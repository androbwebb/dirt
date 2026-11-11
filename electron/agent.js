// "Ask DIRT": an LLM agent (via OpenRouter tool calling) that can navigate and
// search the disk using METADATA ONLY — names, sizes, dates, Spotlight kind,
// git status. No tool ever reads file contents. It finishes by presenting a
// results page the user can act on (reveal / move to Trash, with confirmation).
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProjects } from './git.js';

const HOME = os.homedir();
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_STEPS = 24;

// ---------- helpers ----------
const tilde = (p) => (p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const expand = (p) => path.resolve(String(p || '~').trim().replace(/^~(?=$|\/)/, HOME));

const fmt = (n) => {
  if (n == null) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const ageDays = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : null);

function run(cmd, args, { timeout = 30_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

/** Native folder size (KiB → bytes); null on failure. Runs at low priority. */
function du(p, timeout = 90_000) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/nice', ['-n', '10', '/usr/bin/du', '-skx', p], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(t);
      const kb = parseInt(out, 10);
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
    child.on('error', () => resolve(null));
  });
}

/** Run async jobs with bounded concurrency. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await fn(items[j], j);
      }
    }),
  );
  return out;
}

const PACKAGE_EXT = /\.(app|bundle|framework|photoslibrary|musiclibrary|tvlibrary|logicx|band|fcpbundle|pages|numbers|key|rtfd|sparsebundle|xcarchive|utm|pvm|vmwarevm)$/i;

async function statEntry(p) {
  try {
    const st = await fsp.lstat(p);
    const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? (PACKAGE_EXT.test(p) ? 'package' : 'folder') : 'file';
    return { kind, size: kind === 'file' ? st.blocks * 512 : null, modified: st.mtimeMs, created: st.birthtimeMs };
  } catch {
    return null;
  }
}

/** Spotlight "last opened" + "date added" for many paths in one mdls call. */
async function spotlight(paths) {
  if (!paths.length) return [];
  const { out } = await run('/usr/bin/mdls', ['-raw', '-nullMarker', '', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemDateAdded', '-name', 'kMDItemKind', ...paths], { timeout: 20_000 });
  const parts = out.split('\0');
  return paths.map((_, i) => {
    const [lastUsed, added, kind] = parts.slice(i * 3, i * 3 + 3);
    const t = (s) => (s ? Date.parse(s.replace(' +0000', 'Z').replace(' ', 'T')) || null : null);
    return { lastUsed: t(lastUsed), added: t(added), spotlightKind: kind || null };
  });
}

// ---------- tools ----------
// Every tool returns JSON-able metadata. None read file contents.
function makeTools({ ask }) {
  return {
    list_scans: {
      description: 'List DIRT scans that are finished and cached (fast, accurate folder sizes). Use largest_in_scan on these instead of measuring folders yourself.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const list = await ask('list');
        return list
          .filter((s) => s.status === 'done')
          .map((s) => ({ root: tilde(s.rootPath), total: fmt(s.bytes), files: s.files, scanned: day(s.finishedAt), age_hours: Math.round((Date.now() - s.finishedAt) / 36e5) }));
      },
    },

    largest_in_scan: {
      description: 'Biggest individual items (files, packages, summarized folders like node_modules) anywhere under a path, from a cached scan. Fast. Use for "what is taking space under X".',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'integer', description: 'default 30, max 100' } },
        required: ['path'],
        additionalProperties: false,
      },
      async run({ path: p, limit }) {
        const r = await ask('largest', { path: expand(p), limit: Math.min(limit || 30, 100) });
        if (!r) return { error: 'No cached scan covers this path. Use list_folder / folder_size, or ask the user to scan it.' };
        return { scan_root: tilde(r.root), items: r.items.map((i) => ({ path: tilde(i.path), size: fmt(i.size), kind: i.kind })) };
      },
    },

    list_folder: {
      description: 'List the entries of one folder with kind, size and modified date. Folder sizes come from a cached scan when available, otherwise are null (use folder_size).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          sort: { type: 'string', enum: ['size', 'modified', 'name'] },
          limit: { type: 'integer', description: 'default 60, max 200' },
          include_hidden: { type: 'boolean' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async run({ path: p, sort = 'size', limit = 60, include_hidden = false }) {
        const dir = expand(p);
        let names;
        try {
          names = await fsp.readdir(dir);
        } catch (e) {
          return { error: `${e.code || 'ERR'}: cannot read ${tilde(dir)}` };
        }
        if (!include_hidden) names = names.filter((n) => !n.startsWith('.'));
        const scanSizes = (await ask('sizes', { paths: names.slice(0, 2000).map((n) => path.join(dir, n)) }).catch(() => ({}))) || {};
        const rows = (
          await pool(names.slice(0, 2000), 32, async (n) => {
            const full = path.join(dir, n);
            const st = await statEntry(full);
            if (!st) return null;
            return { name: n, kind: st.kind, size: st.size ?? scanSizes[full] ?? null, modified: st.modified };
          })
        ).filter(Boolean);
        const cmp = { size: (a, b) => (b.size ?? -1) - (a.size ?? -1), modified: (a, b) => a.modified - b.modified, name: (a, b) => a.name.localeCompare(b.name) }[sort];
        rows.sort(cmp);
        return {
          folder: tilde(dir),
          total_entries: rows.length,
          entries: rows.slice(0, Math.min(limit, 200)).map((r) => ({ name: r.name, kind: r.kind, size: fmt(r.size), modified: day(r.modified), age_days: ageDays(r.modified) })),
        };
      },
    },

    folder_size: {
      description: 'Measure total size on disk of up to 10 folders (slow for huge folders; prefer cached scans).',
      parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 10 } },
        required: ['paths'],
        additionalProperties: false,
      },
      async run({ paths }) {
        const list = paths.slice(0, 10).map(expand);
        const sizes = await pool(list, 3, (p) => du(p));
        return list.map((p, i) => ({ path: tilde(p), size: fmt(sizes[i]) ?? 'unknown' }));
      },
    },

    search: {
      description:
        'Find files or folders by name/extension, size and age under a folder. Uses Spotlight, falling back to a bounded filesystem walk. Matches names only, never contents.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Folder to search, e.g. ~/Downloads or ~' },
          name: { type: 'string', description: 'Glob on the file name, e.g. "*.dmg" or "*backup*"' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["dmg","pkg","zip"]' },
          min_size_mb: { type: 'number' },
          older_than_days: { type: 'number', description: 'Last modified more than N days ago' },
          kind: { type: 'string', enum: ['file', 'folder', 'any'] },
          limit: { type: 'integer', description: 'default 100, max 300' },
        },
        required: ['root'],
        additionalProperties: false,
      },
      async run({ root, name, extensions, min_size_mb, older_than_days, kind = 'any', limit = 100 }) {
        const dir = expand(root);
        const cap = Math.min(limit, 300);
        const globs = [...(name ? [name] : []), ...(extensions || []).map((e) => `*.${String(e).replace(/^\./, '')}`)];
        let paths = [];

        // 1) Spotlight
        const q = [];
        if (globs.length) q.push('(' + globs.map((g) => `kMDItemFSName == "${g.replace(/["\\]/g, '')}"c`).join(' || ') + ')');
        if (min_size_mb) q.push(`kMDItemFSSize >= ${Math.round(min_size_mb * 1e6)}`);
        if (older_than_days) q.push(`kMDItemFSContentChangeDate < $time.today(-${Math.round(older_than_days)})`);
        if (kind === 'folder') q.push('kMDItemContentType == "public.folder"');
        if (q.length) {
          const { ok, out } = await run('/usr/bin/mdfind', ['-onlyin', dir, q.join(' && ')], { timeout: 30_000 });
          if (ok) paths = out.split('\n').filter(Boolean);
        }

        // 2) Fallback: bounded find (skips node_modules/.git)
        if (!paths.length) {
          const args = [dir, '-maxdepth', '8', '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o'];
          if (kind === 'file') args.push('-type', 'f');
          if (kind === 'folder') args.push('-type', 'd');
          if (globs.length) {
            args.push('(');
            globs.forEach((g, i) => args.push(...(i ? ['-o'] : []), '-iname', g));
            args.push(')');
          }
          if (min_size_mb) args.push('-size', `+${Math.round(min_size_mb * 1024)}k`);
          if (older_than_days) args.push('-mtime', `+${Math.round(older_than_days)}`);
          args.push('-print');
          const { out } = await run('/usr/bin/find', args, { timeout: 45_000 });
          paths = out.split('\n').filter(Boolean);
        }

        // Drop items nested inside other hits (e.g. files inside a matched .app)
        paths.sort();
        paths = paths.filter((p, i) => !paths.slice(Math.max(0, i - 50), i).some((q2) => p.startsWith(q2 + '/')));
        const hits = (
          await pool(paths.slice(0, 2000), 32, async (p) => {
            const st = await statEntry(p);
            if (!st) return null;
            if (kind === 'file' && st.kind !== 'file') return null;
            if (kind === 'folder' && st.kind === 'file') return null;
            return { path: p, ...st };
          })
        ).filter(Boolean);
        hits.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
        return {
          root: tilde(dir),
          matches: hits.length,
          items: hits.slice(0, cap).map((h) => ({ path: tilde(h.path), kind: h.kind, size: fmt(h.size), modified: day(h.modified), age_days: ageDays(h.modified) })),
        };
      },
    },

    get_info: {
      description: 'Metadata for up to 25 paths: kind, size, created/modified, Spotlight "last opened" and "date added". Never contents.',
      parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 25 } },
        required: ['paths'],
        additionalProperties: false,
      },
      async run({ paths }) {
        const list = paths.slice(0, 25).map(expand);
        const [stats, spot] = await Promise.all([pool(list, 16, statEntry), spotlight(list)]);
        return list.map((p, i) => {
          const st = stats[i];
          if (!st) return { path: tilde(p), error: 'not found' };
          return {
            path: tilde(p),
            kind: spot[i]?.spotlightKind || st.kind,
            size: fmt(st.size),
            created: day(st.created),
            modified: day(st.modified),
            last_opened: day(spot[i]?.lastUsed),
            date_added: day(spot[i]?.added),
          };
        });
      },
    },

    find_git_repos: {
      description:
        'Find git repositories under a folder and report every worktree: branch, last commit, last used, uncommitted/unpushed changes, whether it is merged, size and how much of it is dependencies (node_modules / target).',
      parameters: {
        type: 'object',
        properties: { root: { type: 'string', description: 'default ~' } },
        additionalProperties: false,
      },
      async run({ root = '~' }) {
        const repos = await listProjects([expand(root)], { sizes: true });
        const w = (x, main) => ({
          path: tilde(x.path),
          main,
          branch: x.branch ?? '(detached)',
          missing: !!x.missing,
          last_used_days_ago: ageDays(x.lastUsed),
          uncommitted_files: x.uncommitted,
          unpushed_commits: x.unpushed,
          merged_into_base: x.merged,
          size: main ? undefined : fmt(x.size),
          dependencies_size: main ? undefined : fmt(x.deps),
        });
        const withWt = repos.filter((r) => r.worktrees.length);
        return {
          repos_found: repos.length,
          repos_with_extra_worktrees: withWt.length,
          repos: withWt.map((r) => ({ repo: tilde(r.repo), base: r.base, worktrees: [w(r.main, true), ...r.worktrees.map((x) => w(x, false))] })),
        };
      },
    },

    show_results: {
      description:
        'Present the final answer as a results page. Call exactly once, at the end. Include the specific items the user should look at or may want to clean up, most important first.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short headline, e.g. "Old installers in Downloads"' },
          summary: { type: 'string', description: '1-3 sentences: what you found and what you recommend.' },
          items: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                note: { type: 'string', description: 'Why it is listed, max ~12 words.' },
                verdict: { type: 'string', enum: ['safe', 'caution', 'keep'] },
                group: { type: 'string', description: 'Optional grouping label, e.g. a repo name.' },
              },
              required: ['path', 'note', 'verdict'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'summary', 'items'],
        additionalProperties: false,
      },
      // Handled specially by the loop (enriched + sent to the UI).
      async run() {
        return { ok: true };
      },
    },
  };
}

const SYSTEM = `You are DIRT's disk assistant on the user's Mac. You help find what is using disk space and what can be cleaned up.

You can only see METADATA (names, sizes, dates, kinds, git status) through your tools. You cannot read file contents and must not claim to. You cannot delete anything; the user reviews your results page and decides.

How to work:
- Plan briefly, then call tools. Prefer fast sources: list_scans + largest_in_scan when a cached scan covers the area; search for name/size/age queries; find_git_repos for anything about repos or worktrees.
- Paths: use ~ for the home folder.
- Be efficient: a few targeted calls beat many broad ones.
- Finish by calling show_results exactly once with the concrete items (most important first) and a short summary. If nothing matches, call show_results with an empty items list and say so.
- Verdicts: safe = regenerable/re-downloadable/obviously disposable; caution = probably fine but has a cost or you are unsure; keep = user data or in active use.
- For worktrees: missing folders, merged branches and stale ones with no unpushed/uncommitted work are good candidates; flag unpushed or uncommitted work as caution.
- Never list system paths (/System, /usr, /bin, /Library) as safe.`;

// ---------- loop ----------
/**
 * @param {object} o
 * @param {string} o.query
 * @param {Array} o.history prior messages for follow-ups (mutated)
 * @param {string} o.apiKey
 * @param {string} o.model resolved OpenRouter model id
 * @param {(method: string, args?: object) => Promise<any>} o.ask scan-worker RPC
 * @param {(evt: object) => void} o.emit progress events to the UI
 * @param {AbortSignal} o.signal
 */
export async function runAgent({ query, history, apiKey, model, ask, emit, signal }) {
  if (!apiKey) throw new Error('No OpenRouter API key. Add one in Settings.');
  const tools = makeTools({ ask });
  const toolDefs = Object.entries(tools).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
  if (!history.length) history.push({ role: 'system', content: SYSTEM });
  history.push({ role: 'user', content: query });

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) throw new Error('Stopped.');
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'DIRT' },
      body: JSON.stringify({ model, messages: history, tools: toolDefs, tool_choice: 'auto', max_tokens: 8000, reasoning: { effort: 'low' } }),
      signal,
    }).catch((e) => {
      throw new Error(signal.aborted ? 'Stopped.' : 'Could not reach OpenRouter.', { cause: e });
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      if (res.status === 401) throw new Error('OpenRouter rejected the API key. Check it in Settings.');
      if (res.status === 402) throw new Error('Your OpenRouter account is out of credits.');
      throw new Error(`OpenRouter error: ${body.error?.message || `HTTP ${res.status}`}`);
    }
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error('Empty response from the model.');
    history.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content?.trim() && msg.tool_calls?.length) emit({ type: 'thought', text: msg.content.trim() });

    if (!msg.tool_calls?.length) {
      // Model answered in prose without the results page; show it as a note.
      emit({ type: 'message', text: msg.content || '', model: body.model });
      return;
    }

    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'Invalid JSON arguments' }) });
        continue;
      }
      const tool = tools[name];
      if (!tool) {
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Unknown tool ${name}` }) });
        continue;
      }

      if (name === 'show_results') {
        emit({ type: 'step', tool: name, args: { title: args.title }, status: 'running' });
        const page = await enrichResults(args, ask);
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ shown: page.items.length }) });
        emit({ type: 'results', ...page, model: body.model });
        return;
      }

      const stepId = `${step}-${call.id}`;
      emit({ type: 'step', id: stepId, tool: name, args, status: 'running' });
      const t0 = Date.now();
      let result;
      try {
        result = await tool.run(args);
      } catch (e) {
        result = { error: e.message };
      }
      const summary = summarize(name, result);
      emit({ type: 'step', id: stepId, tool: name, args, status: result?.error ? 'error' : 'done', summary, ms: Date.now() - t0 });
      let text = JSON.stringify(result);
      if (text.length > 60_000) text = text.slice(0, 60_000) + '…(truncated)';
      history.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }
  throw new Error('The assistant took too many steps. Try a narrower question.');
}

/** One-line description of a tool result for the progress list. */
function summarize(name, r) {
  if (r?.error) return r.error;
  switch (name) {
    case 'list_scans':
      return `${r.length} cached scan${r.length === 1 ? '' : 's'}`;
    case 'largest_in_scan':
      return `${r.items.length} items`;
    case 'list_folder':
      return `${r.total_entries} entries`;
    case 'folder_size':
      return r.map((x) => `${x.path.split('/').pop()}: ${x.size}`).join(', ');
    case 'search':
      return `${r.matches} match${r.matches === 1 ? '' : 'es'}`;
    case 'get_info':
      return `${r.length} item${r.length === 1 ? '' : 's'}`;
    case 'find_git_repos':
      return `${r.repos_found} repos, ${r.repos_with_extra_worktrees} with worktrees`;
    default:
      return '';
  }
}

/** Attach real sizes/dates to the items the model chose to show. */
async function enrichResults({ title, summary, items }, ask) {
  const list = (items || []).slice(0, 200).map((i) => ({ ...i, abs: expand(i.path) }));
  const scanSizes = (await ask('sizes', { paths: list.map((i) => i.abs) }).catch(() => ({}))) || {};
  const stats = await pool(list, 16, (i) => statEntry(i.abs));
  const spot = await spotlight(list.filter((_, k) => stats[k]).map((i) => i.abs));
  let si = 0;
  const enriched = await pool(list, 4, async (i, k) => {
    const st = stats[k];
    if (!st) return { path: i.abs, display: tilde(i.abs), note: i.note, verdict: i.verdict, group: i.group || null, missing: true };
    const sp = spot[si++] || {};
    const size = st.size ?? scanSizes[i.abs] ?? (await du(i.abs, 60_000));
    const isWorktree = st.kind === 'folder' && (await fsp.lstat(path.join(i.abs, '.git')).then((g) => g.isFile(), () => false));
    return {
      path: i.abs,
      display: tilde(i.abs),
      name: path.basename(i.abs),
      isWorktree,
      kind: st.kind,
      size,
      modified: st.modified,
      lastUsed: sp.lastUsed || null,
      note: i.note,
      verdict: i.verdict,
      group: i.group || null,
    };
  });
  return { title, summary, items: enriched, total: enriched.reduce((s, i) => s + (i.size || 0), 0) };
}
