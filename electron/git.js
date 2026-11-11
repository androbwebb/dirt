// Git project discovery, worktree management, and AI-assisted cleanup analysis.
// Everything here reads metadata (git status, names, sizes, dates). The only
// thing sent to the AI is metadata: folder names, sizes, file-type counts.
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
export const tilde = (p) => (p === HOME ? '~' : p?.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
export const expand = (p) => path.resolve(String(p || '~').trim().replace(/^~(?=$|\/)/, HOME));

export function run(cmd, args, { timeout = 30_000, max = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: max }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}
const git = (dir, args, opts) => run('git', ['-C', dir, ...args], opts);

/** Native folder size in bytes (low priority); null on failure. */
export function du(p, timeout = 90_000) {
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

export async function pool(items, n, fn) {
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

/** Default folders to look for repos in: the usual project roots that exist. */
export async function defaultRoots() {
  const cands = ['Personal', 'Work', 'Projects', 'Developer', 'code', 'Code', 'src', 'dev', 'repos', 'GitHub'].map((d) => path.join(HOME, d));
  const out = [];
  for (const c of cands) if (await fsp.stat(c).then((s) => s.isDirectory(), () => false)) out.push(c);
  return out.length ? out : [HOME];
}

/** Find repo roots (folders containing a .git directory) under root. */
export async function findRepos(root, maxDepth = 4) {
  const { out } = await run(
    '/usr/bin/find',
    [root, '-maxdepth', String(Math.min(maxDepth, 6)), '(', '-name', 'node_modules', '-o', '-name', 'Library', '-o', '-name', '.Trash', '-o', '-name', '.claude', ')', '-prune', '-o', '-name', '.git', '-type', 'd', '-print', '-prune'],
    { timeout: 60_000 },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((g) => path.dirname(g))
    .sort((a, b) => a.localeCompare(b));
}

async function baseBranch(repo) {
  for (const b of ['main', 'master']) if ((await git(repo, ['rev-parse', '--verify', '--quiet', b], { timeout: 5_000 })).ok) return b;
  const head = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeout: 5_000 })).out.trim();
  return head || 'HEAD';
}

/** Metadata for one checkout (main or worktree). Sizes are optional (slow). */
async function checkoutInfo(repo, w, branch, base, { sizes }) {
  const exists = await fsp.stat(w).then(() => true, () => false);
  if (!exists) return { path: w, branch, missing: true };
  const [status, last, merged, unpushed, mtime] = await Promise.all([
    git(w, ['status', '--porcelain'], { timeout: 20_000 }),
    git(w, ['log', '-1', '--format=%ct'], { timeout: 5_000 }),
    branch && branch !== base ? git(repo, ['branch', '--merged', base, '--format=%(refname:short)'], { timeout: 10_000 }) : Promise.resolve({ out: '' }),
    branch ? git(repo, ['log', branch, '--not', '--remotes', '--oneline'], { timeout: 10_000 }) : Promise.resolve({ out: '' }),
    fsp.stat(w).then((s) => s.mtimeMs, () => null),
  ]);
  const info = {
    path: w,
    branch,
    lastCommit: parseInt(last.out, 10) * 1000 || null,
    // "Last used": newest of last commit and the checkout folder's mtime.
    lastUsed: Math.max(parseInt(last.out, 10) * 1000 || 0, mtime || 0) || null,
    uncommitted: status.out.split('\n').filter(Boolean).length,
    unpushed: unpushed.out.split('\n').filter(Boolean).length,
    merged: branch && branch !== base ? merged.out.split('\n').includes(branch) : null,
  };
  if (sizes) {
    const [size, nm, tgt] = await Promise.all([du(w), du(path.join(w, 'node_modules'), 60_000), du(path.join(w, 'target'), 60_000)]);
    info.size = size;
    info.deps = (nm || 0) + (tgt || 0);
  }
  return info;
}

/** Full picture of one repo: main checkout + every worktree. */
export async function repoInfo(repo, { sizes = false } = {}) {
  const base = await baseBranch(repo);
  const wt = await git(repo, ['worktree', 'list', '--porcelain'], { timeout: 15_000 });
  const blocks = wt.out.trim().split('\n\n').filter(Boolean);
  const entries = blocks.map((b) => ({
    path: b.match(/^worktree (.+)$/m)?.[1],
    branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] || (b.includes('detached') ? null : null),
    detached: b.includes('\ndetached'),
  }));
  const [main, ...rest] = await pool(entries, 3, (e, i) => checkoutInfo(repo, e.path, e.branch, base, { sizes: sizes && i > 0 }));
  const remote = (await git(repo, ['remote', 'get-url', 'origin'], { timeout: 5_000 })).out.trim() || null;
  return { repo, name: path.basename(repo), base, remote, main: { ...main, branch: entries[0]?.branch ?? null }, worktrees: rest.map((w, i) => ({ ...w, detached: entries[i + 1]?.detached })) };
}

export async function listProjects(roots, { sizes = false } = {}) {
  const repos = [...new Set((await Promise.all(roots.map((r) => findRepos(r)))).flat())].slice(0, 150);
  return pool(repos, 4, (r) => repoInfo(r, { sizes }));
}

// ---------- worktree actions ----------
async function repoOf(p) {
  const common = (await git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5_000 })).out.trim();
  if (!common) throw new Error('Not a git checkout');
  return common.endsWith('/.git') ? path.dirname(common) : common;
}

/** Stash any changes (kept in the repo's stash list), then remove the worktree. Branch is kept. */
export async function removeWorktree(p) {
  const repo = await repoOf(p);
  if (path.resolve(repo) === path.resolve(p)) throw new Error("That's the main checkout, not a worktree");
  let stashed = false;
  if ((await git(p, ['status', '--porcelain'])).out.trim()) {
    const msg = `dirt: worktree-removal ${path.basename(p)} ${new Date().toISOString().slice(0, 10)}`;
    const r = await git(p, ['stash', 'push', '-u', '-m', msg], { timeout: 120_000 });
    if (!r.ok) throw new Error('Could not stash uncommitted changes; nothing removed');
    stashed = true;
  }
  const r = await new Promise((resolve) =>
    execFile('git', ['-C', repo, 'worktree', 'remove', p], { timeout: 120_000 }, (err, _o, se) => resolve(err ? String(se || err.message).trim() : null)),
  );
  if (r) throw new Error(r);
  return { repo, stashed };
}

export async function pruneWorktrees(repo) {
  await git(repo, ['worktree', 'prune']);
  return { ok: true };
}

// ---------- cleanup analysis ----------
const MARKERS = ['package.json', 'Cargo.toml', 'project.godot', 'CMakeLists.txt', 'Makefile', 'pyproject.toml', 'requirements.txt', 'go.mod', 'build.gradle', 'pom.xml', 'Gemfile', 'Package.swift', 'pubspec.yaml', 'composer.json', '*.xcodeproj', '*.sln', '*.uproject', 'ProjectSettings', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'tsconfig.json', 'Dockerfile'];

/** Count file extensions (names only) in a folder, up to a sample limit. */
async function extHistogram(dir) {
  const { out } = await run('/usr/bin/find', [dir, '-maxdepth', '4', '-type', 'f'], { timeout: 15_000, max: 8 * 1024 * 1024 });
  const files = out.split('\n').filter(Boolean).slice(0, 4000);
  const counts = {};
  for (const f of files) {
    const ext = path.extname(f).toLowerCase() || '(none)';
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([e, n]) => `${e}:${n}`)
    .join(' ');
}

/** Collect gitignored/untracked heavy folders in a repo with metadata. */
export async function cleanupCandidates(repo) {
  const ignored = await git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], { timeout: 60_000 });
  let entries = ignored.out.split('\n').filter(Boolean);
  // Large untracked-but-not-ignored folders matter too (e.g. forgotten exports).
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory'], { timeout: 60_000 });
  const untrackedSet = new Set(untracked.out.split('\n').filter(Boolean));
  entries = [...new Set([...entries, ...untrackedSet])].slice(0, 400);

  const measured = await pool(entries, 4, async (rel) => {
    const abs = path.join(repo, rel.replace(/\/$/, ''));
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) return null;
    const size = st.isDirectory() ? await du(abs, 60_000) : st.blocks * 512;
    return { rel: rel.replace(/\/$/, ''), abs, dir: st.isDirectory(), size, mtime: st.mtimeMs, ignored: !untrackedSet.has(rel) };
  });
  const big = measured.filter((m) => m && m.size >= 5e6).sort((a, b) => b.size - a.size).slice(0, 40);
  for (const m of big) if (m.dir) m.types = await extHistogram(m.abs);

  const top = await git(repo, ['ls-tree', '--name-only', 'HEAD'], { timeout: 10_000 });
  const tracked = await git(repo, ['ls-files'], { timeout: 30_000, max: 64 * 1024 * 1024 });
  const markerRe = new RegExp(
    '(^|/)(' +
      MARKERS.map((m) =>
        m
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*'),
      ).join('|') +
      ')$',
  );
  const markers = [...new Set(tracked.out.split('\n').filter((f) => markerRe.test(f)))].slice(0, 40);
  return { repo, topLevel: top.out.split('\n').filter(Boolean).slice(0, 80), markers, candidates: big };
}

const fmt = (n) => {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '1-2 sentences: what can be reclaimed and the main caveat.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The relative path exactly as given' },
          verdict: { type: 'string', enum: ['safe', 'caution', 'keep'] },
          note: { type: 'string', description: 'What it is and how it is regenerated (e.g. "Rust build output; `cargo build`"), max ~14 words.' },
        },
        required: ['path', 'verdict', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'items'],
  additionalProperties: false,
};

const ANALYZE_SYSTEM = `You review folders inside a software/game project repo to decide what can be deleted to free disk space.
You see metadata only: names, sizes, whether git ignores them, file-type counts, and the project's marker files. No contents.

Verdicts:
- safe: regenerated by the project's normal build/tooling (build output, compiler caches, dependency installs, editor/import caches, test output, screenshots/logs from test runs). Say the regenerate command when obvious (cargo build, npm install, cmake --build …, opening the project in Godot).
- caution: probably regenerable but costly or uncertain (large downloaded SDKs/engines, extracted data that may come from an external source, exported releases, generated media that might have cost money/time).
- keep: likely irreplaceable and not in git: original game data/ROMs/ISOs, source art or recordings, databases, secrets/keys, personal data. Being gitignored does NOT make something disposable.

Judge from names AND file types AND project markers together (e.g. "target" next to Cargo.toml = cargo output; ".godot" with project.godot = Godot cache; "ROM" with .bin/.iso files = keep).
Return every candidate given, in the same paths.`;

/** Ask the model to classify cleanup candidates. Falls back to name heuristics without a key. */
export async function analyzeRepo(repo, { apiKey, model }) {
  const facts = await cleanupCandidates(repo);
  const name = path.basename(repo);
  if (!facts.candidates.length) {
    return { title: `${name}: nothing big to clean`, summary: 'No ignored or untracked folders over 5 MB.', items: [], total: 0 };
  }

  let verdicts;
  if (apiKey) {
    const lines = [
      `Repo: ${tilde(repo)}`,
      `Top-level tracked entries: ${facts.topLevel.join(', ')}`,
      `Project marker files: ${facts.markers.join(', ') || '(none)'}`,
      '',
      'Candidates (relative path | size | ignored-by-git | last modified | file types):',
      ...facts.candidates.map((c) => `${c.rel}${c.dir ? '/' : ''} | ${fmt(c.size)} | ${c.ignored ? 'ignored' : 'untracked'} | ${new Date(c.mtime).toISOString().slice(0, 10)} | ${c.types || 'file'}`),
    ].join('\n');
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'DIRT' },
      body: JSON.stringify({
        model,
        max_tokens: 6000,
        reasoning: { effort: 'low' },
        response_format: { type: 'json_schema', json_schema: { name: 'cleanup', strict: true, schema: ANALYZE_SCHEMA } },
        messages: [
          { role: 'system', content: ANALYZE_SYSTEM },
          { role: 'user', content: lines },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => {
      throw new Error('Could not reach OpenRouter.', { cause: e });
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`OpenRouter error: ${body.error?.message || `HTTP ${res.status}`}`);
    const text = body.choices?.[0]?.message?.content || '';
    try {
      verdicts = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      verdicts = m ? JSON.parse(m[0]) : null;
    }
    if (verdicts) verdicts.model = body.model || model;
  }

  if (!verdicts) {
    const SAFE = /^(node_modules|target|dist|out|build|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|\.godot|\.gradle|__pycache__|\.pytest_cache|\.venv|venv|coverage|DerivedData|Library)$/i;
    verdicts = {
      summary: 'Classified by folder name only (add an OpenRouter key for smarter analysis).',
      items: facts.candidates.map((c) => ({ path: c.rel, verdict: SAFE.test(path.basename(c.rel)) ? 'safe' : 'caution', note: SAFE.test(path.basename(c.rel)) ? 'Common build/cache folder' : 'Unknown; check before deleting' })),
    };
  }

  const byRel = new Map(facts.candidates.map((c) => [c.rel, c]));
  const order = { safe: 0, caution: 1, keep: 2 };
  const items = verdicts.items
    .map((v) => {
      const c = byRel.get(String(v.path).replace(/\/$/, ''));
      if (!c) return null;
      return { path: c.abs, display: tilde(c.abs), name: c.rel, kind: c.dir ? 'folder' : 'file', size: c.size, modified: c.mtime, lastUsed: null, note: v.note, verdict: v.verdict, group: null };
    })
    .filter(Boolean)
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.size - a.size);
  return {
    title: `Cleanup: ${name}`,
    summary: verdicts.summary,
    items,
    total: items.reduce((s, i) => s + (i.size || 0), 0),
    model: verdicts.model,
  };
}
