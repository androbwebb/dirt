// "Ask DIRT": chat-style agent view with a live step list and an actionable
// results page (bulk select, reveal, move to Trash, worktree diff).
import { api, type AgentEvent, type ResultItem, type SuggestedCommand, type WorktreeDiff } from './api';
import { ago, bytes, esc, int } from './format';

interface Step {
  id?: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  summary?: string;
  ms?: number;
}

interface Page {
  title: string;
  summary: string;
  commands?: SuggestedCommand[];
  items: (ResultItem & { trashed?: boolean })[];
  total: number;
  model?: string;
}

interface Turn {
  query: string;
  steps: Step[];
  thoughts: string[];
  page?: Page;
  message?: string;
  error?: string;
  running: boolean;
  /** UI state for the results table */
  sel: Set<string>;
  anchor: number | null;
  filter: 'all' | 'safe' | 'caution' | 'keep';
  confirming: boolean;
}

interface Deps {
  view: HTMLElement;
  enter(): void;
  isActive(): boolean;
  toast(msg: string, kind?: 'ok' | 'err'): void;
  home(): string;
  openSettings(): void;
}

const TOOL_LABEL: Record<string, string> = {
  list_scans: 'Scans',
  largest_in_scan: 'Largest',
  list_folder: 'List',
  folder_size: 'Measure',
  search: 'Search',
  get_info: 'Inspect',
  find_git_repos: 'Git repos',
  show_results: 'Results',
};

const VERDICT: Record<string, string> = { safe: 'Safe', caution: 'Caution', keep: 'Keep' };

export function createAsk(deps: Deps) {
  let conversationId = crypto.randomUUID();
  const turns: Turn[] = [];

  const tilde = (p: string) => {
    const h = deps.home();
    return h && p.startsWith(h) ? '~' + p.slice(h.length) : p;
  };

  // ---------- events from the agent ----------
  window.dirt?.onAgent((e: AgentEvent) => {
    if (e.conversationId !== conversationId) return;
    const t = turns[turns.length - 1];
    if (!t) return;
    switch (e.type) {
      case 'step': {
        const existing = e.id ? t.steps.find((s) => s.id === e.id) : null;
        if (existing) Object.assign(existing, e);
        else t.steps.push({ id: e.id, tool: e.tool, args: e.args ?? {}, status: e.status, summary: e.summary, ms: e.ms });
        break;
      }
      case 'thought':
        t.thoughts.push(e.text);
        break;
      case 'results':
        t.page = { title: e.title, summary: e.summary, items: e.items, commands: e.commands, total: e.total, model: e.model };
        // Pre-select the "safe" items so the obvious cleanup is one click.
        for (const i of e.items) if (i.verdict === 'safe' && !i.missing) t.sel.add(i.path);
        t.steps.forEach((s) => s.tool === 'show_results' && (s.status = 'done'));
        break;
      case 'message':
        t.message = e.text;
        break;
      case 'error':
        t.error = e.message;
        t.running = false;
        break;
      case 'done':
        t.running = false;
        if (!deps.isActive() && t.page) deps.toast(`Ask DIRT: ${t.page.title}`);
        break;
    }
    if (deps.isActive()) renderThread();
  });

  // ---------- view ----------
  function show(prefill?: string) {
    deps.enter();
    deps.view.innerHTML = `
      <section class="ask">
        <div class="ask-head">
          <h1 class="page-title ask-title"><span class="ai-spark ai-spark-big">✦</span> Ask <mark>DIRT</mark></h1>
          <form class="ask-form" id="ask-form">
            <span class="ask-prompt"><span class="ai-spark">✦</span></span>
            <textarea id="ask-input" rows="1" spellcheck="false" placeholder="Find old .dmg files in Downloads"></textarea>
            <button class="btn btn-acid" type="submit" id="ask-go">Ask <span class="arrow">→</span></button>
          </form>
          <div class="ask-bar">
            <button class="ask-new" id="ask-new" ${turns.length ? '' : 'hidden'}>New conversation</button>
          </div>
        </div>
        <div class="ask-thread" id="ask-thread"></div>
      </section>`;
    const input = document.getElementById('ask-input') as HTMLTextAreaElement;
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    document.getElementById('ask-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    document.getElementById('ask-new')!.addEventListener('click', () => {
      void api.agentReset(conversationId);
      conversationId = crypto.randomUUID();
      turns.length = 0;
      show();
    });
    renderThread();
    if (prefill) {
      input.value = prefill;
      submit();
    } else input.focus();
  }

  async function submit() {
    const input = document.getElementById('ask-input') as HTMLTextAreaElement | null;
    const q = input?.value.trim();
    if (!q) return;
    if (turns.some((t) => t.running)) return deps.toast('Still working on the last question.', 'err');
    turns.push({ query: q, steps: [], thoughts: [], running: true, sel: new Set(), anchor: null, filter: 'all', confirming: false });
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    document.getElementById('ask-new')?.removeAttribute('hidden');
    renderThread();
    try {
      await api.agentStart(conversationId, q);
    } catch (e) {
      const t = turns[turns.length - 1];
      t.error = (e as Error).message;
      t.running = false;
      renderThread();
    }
  }

  // ---------- rendering ----------
  function argLine(s: Step): string {
    const a = s.args as Record<string, unknown>;
    const parts: string[] = [];
    const p = (a.path ?? a.root) as string | undefined;
    if (p) parts.push(String(p));
    if (Array.isArray(a.paths)) parts.push(`${a.paths.length} path${a.paths.length === 1 ? '' : 's'}`);
    if (a.name) parts.push(String(a.name));
    if (Array.isArray(a.extensions) && a.extensions.length) parts.push(a.extensions.map((x) => `.${x}`).join(' '));
    if (a.min_size_mb) parts.push(`≥ ${a.min_size_mb} MB`);
    if (a.older_than_days) parts.push(`> ${a.older_than_days} days old`);
    if (a.title) parts.push(String(a.title));
    return parts.join(' · ');
  }

  function renderThread() {
    const el = document.getElementById('ask-thread');
    if (!el) return;
    el.innerHTML = turns.map((t, i) => renderTurn(t, i)).join('') || '';
    turns.forEach((t, i) => bindTurn(t, i));
    const last = el.lastElementChild;
    if (last && turns[turns.length - 1]?.running) last.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function renderTurn(t: Turn, i: number): string {
    const steps = t.steps.filter((s) => s.tool !== 'show_results');
    return `
      <article class="turn" data-turn="${i}">
        <div class="turn-q"><span class="turn-q-tag">You</span><span class="turn-q-text">${esc(t.query)}</span></div>
        ${
          steps.length || t.running
            ? `<ol class="steps">
                ${steps
                  .map(
                    (s) => `
                  <li class="step is-${s.status}">
                    <span class="step-dot"></span>
                    <span class="step-tool">${esc(TOOL_LABEL[s.tool] ?? s.tool)}</span>
                    <span class="step-args">${esc(argLine(s))}</span>
                    <span class="step-res">${s.status === 'running' ? 'working…' : esc(s.summary ?? '')}</span>
                    <span class="step-ms">${s.ms != null ? `${(s.ms / 1000).toFixed(1)}s` : ''}</span>
                  </li>`,
                  )
                  .join('')}
                ${t.running && !t.page ? `<li class="step is-thinking"><span class="step-dot"></span><span class="step-tool">Thinking</span><span class="step-args"></span><span class="step-res"></span><span class="step-ms"></span></li>` : ''}
              </ol>`
            : ''
        }
        ${t.page ? renderPage(t) : ''}
        ${t.message ? `<div class="turn-msg">${esc(t.message)}</div>` : ''}
        ${
          t.error
            ? `<div class="turn-err">${esc(t.error)}${/key|Settings/i.test(t.error) ? ' <button class="btn btn-sm btn-ink" data-act="settings">Open settings →</button>' : ''}</div>`
            : ''
        }
      </article>`;
  }

  function visibleItems(t: Turn) {
    return (t.page?.items ?? []).filter((it) => t.filter === 'all' || it.verdict === t.filter);
  }

  function renderPage(t: Turn): string {
    const p = t.page!;
    const counts = { safe: 0, caution: 0, keep: 0 } as Record<string, number>;
    const sizes = { safe: 0, caution: 0, keep: 0 } as Record<string, number>;
    for (const it of p.items) {
      if (it.trashed) continue;
      counts[it.verdict] = (counts[it.verdict] ?? 0) + 1;
      sizes[it.verdict] = (sizes[it.verdict] ?? 0) + (it.size ?? 0);
    }
    const live = p.items.filter((i) => !i.trashed);
    const total = live.reduce((s, i) => s + (i.size ?? 0), 0);
    const items = visibleItems(t);
    const max = Math.max(1, ...items.map((i) => i.size ?? 0));
    const sel = p.items.filter((i) => t.sel.has(i.path) && !i.trashed);
    const selSize = sel.reduce((s, i) => s + (i.size ?? 0), 0);
    const [num, unit] = bytes(total).split(' ');

    let lastGroup: string | null = null;
    const rows = items
      .map((it, idx) => {
        const groupRow =
          it.group && it.group !== lastGroup ? `<tr class="rp-group"><td colspan="6">${esc(it.group)}</td></tr>` : '';
        lastGroup = it.group ?? lastGroup;
        const when = it.lastUsed ? `opened ${ago(it.lastUsed)}` : it.modified ? `modified ${ago(it.modified)}` : '';
        return `${groupRow}
          <tr class="rp-row v-row-${it.verdict} ${t.sel.has(it.path) && !it.trashed ? 'is-sel' : ''} ${it.trashed ? 'is-trashed' : ''} ${it.missing ? 'is-missing' : ''}" data-idx="${idx}">
            <td class="rp-check"><span class="box">${t.sel.has(it.path) && !it.trashed ? '✓' : ''}</span></td>
            <td class="rp-verdict"><span class="vbadge vb-${it.verdict}">${VERDICT[it.verdict] ?? it.verdict}</span></td>
            <td class="rp-main">
              <div class="rp-name">${esc(it.name ?? it.display.split('/').pop() ?? it.display)}${it.trashed ? '<span class="rp-tag rp-tag-trash">In Trash</span>' : ''}${it.missing ? '<span class="rp-tag">Missing</span>' : ''}${it.kind && it.kind !== 'file' ? `<span class="rp-tag">${esc(it.kind)}</span>` : ''}</div>
              <div class="rp-path">${esc(tilde(it.path))}</div>
              <div class="rp-note">${esc(it.note)}</div>
            </td>
            <td class="rp-size">
              <b>${it.size != null ? bytes(it.size) : '—'}</b>
              <span class="rp-bar"><span style="width:${(((it.size ?? 0) / max) * 100).toFixed(1)}%"></span></span>
            </td>
            <td class="rp-when">${esc(when)}</td>
            <td class="rp-actions">
              ${it.isWorktree ? '<button class="mini mini-ai" data-act="diff" title="Diff against main">Diff</button>' : ''}
              ${!it.missing && !it.trashed ? '<button class="mini" data-act="reveal" title="Reveal in Finder">↗</button>' : ''}
            </td>
          </tr>`;
      })
      .join('');

    return `
      <section class="card rp">
        <header class="rp-head">
          <div class="rp-head-main">
            <span class="rp-eyebrow">Results</span>
            <h2 class="rp-title">${esc(p.title)}</h2>
            <p class="rp-summary">${esc(p.summary)}</p>
          </div>
          <div class="rp-total">
            <span class="bignum">${num}<small>${unit ?? ''}</small></span>
            <span class="rp-total-label">${int(live.length)} item${live.length === 1 ? '' : 's'}</span>
          </div>
        </header>
        ${renderCommands(p.commands)}
        <div class="rp-filters">
          ${(['all', 'safe', 'caution', 'keep'] as const)
            .map((f) => {
              const n = f === 'all' ? live.length : counts[f];
              const s = f === 'all' ? total : sizes[f];
              return `<button class="rp-filter f-${f} ${t.filter === f ? 'is-on' : ''}" data-filter="${f}" ${f !== 'all' && !n ? 'disabled' : ''}>
                <span>${f === 'all' ? 'All' : VERDICT[f]}</span><b>${n}</b><small>${bytes(s)}</small></button>`;
            })
            .join('')}
        </div>
        ${
          items.length
            ? `<div class="rp-table-wrap"><table class="rp-table"><tbody>${rows}</tbody></table></div>`
            : `<div class="rp-empty">Nothing to show.</div>`
        }
        <footer class="rp-foot ${sel.length ? 'has-sel' : ''}">
          <div class="rp-sel">
            ${sel.length ? `<b>${sel.length} selected</b> · ${bytes(selSize)}` : 'Click rows to select · shift-click for a range'}
          </div>
          <div class="rp-foot-actions">
            <button class="btn btn-sm" data-act="all">Select all</button>
            <button class="btn btn-sm" data-act="none" ${sel.length ? '' : 'disabled'}>Clear</button>
            ${
              t.confirming
                ? `<button class="btn btn-red btn-confirm" data-act="trash-go">Yes, move ${sel.length} to Trash</button><button class="btn" data-act="trash-no">No</button>`
                : `<button class="btn btn-red" data-act="trash" ${sel.length ? '' : 'disabled'}>Move to Trash →</button>`
            }
          </div>
        </footer>
        ${p.model ? `<div class="rp-model">${esc(p.model)}</div>` : ''}
      </section>`;
  }

  function renderCommands(cmds?: SuggestedCommand[]): string {
    if (!cmds?.length) return '';
    const RISK: Record<string, string> = { safe: 'Safe', caution: 'Caution', destructive: 'Destructive' };
    return `
      <div class="cmds">
        <div class="cmds-head"><span>Terminal</span><small>Copy &amp; paste · DIRT never runs these</small></div>
        ${cmds
          .map(
            (c, k) => `
          <div class="cmd r-${c.risk}">
            <div class="cmd-line">
              <span class="cmd-prompt">$</span>
              <code class="cmd-code">${esc(c.command)}</code>
              <button class="cmd-copy" data-copy="${k}">Copy</button>
            </div>
            <div class="cmd-meta"><span class="vbadge vb-${c.risk === 'destructive' ? 'keep' : c.risk}">${RISK[c.risk] ?? c.risk}</span><span class="cmd-desc">${esc(c.description)}</span></div>
          </div>`,
          )
          .join('')}
      </div>`;
  }

  function bindTurn(t: Turn, i: number) {
    const el = document.querySelector<HTMLElement>(`.turn[data-turn="${i}"]`);
    if (!el) return;
    el.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        const cmd = t.page?.commands?.[Number(b.dataset.copy)];
        if (!cmd) return;
        await api.copyText(cmd.command);
        b.textContent = 'Copied ✓';
        b.classList.add('is-copied');
        setTimeout(() => {
          b.textContent = 'Copy';
          b.classList.remove('is-copied');
        }, 1500);
      }),
    );
    el.querySelector('[data-act="settings"]')?.addEventListener('click', () => deps.openSettings());
    if (!t.page) return;
    const items = visibleItems(t);

    el.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        t.filter = b.dataset.filter as Turn['filter'];
        t.anchor = null;
        renderThread();
      }),
    );

    el.querySelectorAll<HTMLTableRowElement>('.rp-row').forEach((row) =>
      row.addEventListener('click', (e) => {
        const idx = Number(row.dataset.idx);
        const it = items[idx];
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'reveal') return void api.revealPath(it.path).catch((err) => deps.toast(err.message, 'err'));
        if (act === 'diff') return void showDiff(it.path);
        if (it.trashed || it.missing) return;
        if (e.shiftKey && t.anchor != null) {
          const [a, b] = t.anchor < idx ? [t.anchor, idx] : [idx, t.anchor];
          const turnOn = !t.sel.has(it.path);
          for (let j = a; j <= b; j++) {
            const x = items[j];
            if (x.trashed || x.missing) continue;
            if (turnOn) t.sel.add(x.path);
            else t.sel.delete(x.path);
          }
        } else if (t.sel.has(it.path)) t.sel.delete(it.path);
        else t.sel.add(it.path);
        t.anchor = idx;
        t.confirming = false;
        renderThread();
      }),
    );

    const act = (name: string, fn: () => void) => el.querySelector(`.rp-foot [data-act="${name}"]`)?.addEventListener('click', fn);
    act('all', () => {
      for (const it of items) if (!it.trashed && !it.missing) t.sel.add(it.path);
      renderThread();
    });
    act('none', () => {
      t.sel.clear();
      t.confirming = false;
      renderThread();
    });
    act('trash', () => {
      t.confirming = true;
      renderThread();
    });
    act('trash-no', () => {
      t.confirming = false;
      renderThread();
    });
    act('trash-go', async () => {
      const paths = [...t.sel];
      const btn = el.querySelector<HTMLButtonElement>('[data-act="trash-go"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Trashing…';
      }
      try {
        const r = await api.trashPaths(paths);
        const done = new Set(r.trashed);
        let freed = 0;
        for (const it of t.page!.items) {
          if (done.has(it.path)) {
            it.trashed = true;
            freed += it.size ?? 0;
          }
        }
        t.sel.clear();
        t.confirming = false;
        deps.toast(
          r.failed.length
            ? `Moved ${r.trashed.length} to Trash. ${r.failed.length} failed: ${r.failed[0].error}`
            : `Moved ${r.trashed.length} to Trash. ${bytes(freed)} reclaimable once you empty it.`,
          r.failed.length ? 'err' : 'ok',
        );
      } catch (err) {
        deps.toast((err as Error).message, 'err');
        t.confirming = false;
      }
      renderThread();
    });
  }

  // ---------- worktree diff ----------
  async function showDiff(path: string) {
    document.getElementById('diff')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'ai-overlay';
    overlay.id = 'diff';
    overlay.innerHTML = `
      <div class="card diff-card" role="dialog" aria-label="Diff">
        <div class="ai-head"><span class="ai-tag">Diff</span><button class="ai-x" title="Close">✕</button></div>
        <div class="diff-body"><div class="stripes"><div></div></div></div>
      </div>`;
    document.body.append(overlay);
    const close = () => {
      overlay.remove();
      window.removeEventListener('keydown', onKey);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.ai-x')) close();
    });

    let d: WorktreeDiff;
    try {
      d = await api.worktreeDiff(path);
    } catch (err) {
      overlay.querySelector('.diff-body')!.innerHTML = `<div class="ai-error">${esc((err as Error).message)}</div>`;
      return;
    }
    const add = d.files.reduce((s, f) => s + (f.added ?? 0), 0);
    const del = d.files.reduce((s, f) => s + (f.removed ?? 0), 0);
    overlay.querySelector('.diff-body')!.innerHTML = `
      <div class="diff-head">
        <div class="diff-branches"><span class="diff-branch">${esc(d.branch)}</span><span class="diff-vs">vs</span><span class="diff-branch diff-base">${esc(d.base)}</span></div>
        <div class="diff-path">${esc(tilde(d.worktree))}</div>
        <div class="diff-stats">
          <span class="chip">${d.files.length} file${d.files.length === 1 ? '' : 's'}</span>
          <span class="chip diff-add">+${int(add)}</span>
          <span class="chip diff-del">−${int(del)}</span>
          <span class="chip">${d.ahead} ahead · ${d.behind} behind</span>
          ${d.untracked.length ? `<span class="chip chip-hatch">${d.untracked.length} untracked</span>` : ''}
        </div>
      </div>
      ${
        d.files.length
          ? `<ul class="diff-files">${d.files
              .map(
                (f) =>
                  `<li><span class="df-name">${esc(f.file)}</span><span class="df-add">${f.added == null ? 'bin' : `+${f.added}`}</span><span class="df-del">${f.removed == null ? '' : `−${f.removed}`}</span></li>`,
              )
              .join('')}</ul>`
          : `<div class="rp-empty">No changes against ${esc(d.base)}.</div>`
      }
      ${d.untracked.length ? `<div class="diff-untracked"><b>Untracked</b> ${d.untracked.slice(0, 40).map((u) => `<code>${esc(u)}</code>`).join(' ')}${d.untracked.length > 40 ? ' …' : ''}</div>` : ''}
      ${d.patch ? `<pre class="diff-patch">${colorPatch(d.patch)}${d.truncated ? '\n… (truncated)' : ''}</pre>` : ''}`;
  }

  function colorPatch(patch: string): string {
    return patch
      .split('\n')
      .map((l) => {
        const cls = l.startsWith('diff --git')
          ? 'dl-file'
          : l.startsWith('@@')
            ? 'dl-hunk'
            : l.startsWith('+') && !l.startsWith('+++')
              ? 'dl-add'
              : l.startsWith('-') && !l.startsWith('---')
                ? 'dl-del'
                : l.startsWith('+++') || l.startsWith('---') || l.startsWith('index ')
                  ? 'dl-meta'
                  : '';
        return `<span class="dl ${cls}">${esc(l) || ' '}</span>`;
      })
      .join('\n');
  }

  /** Open the Ask view with a ready-made results page (e.g. repo analysis). */
  function showPage(query: string, page: Page) {
    const t: Turn = { query, steps: [], thoughts: [], page, running: false, sel: new Set(), anchor: null, filter: 'all', confirming: false };
    for (const i of page.items) if (i.verdict === 'safe' && !i.missing) t.sel.add(i.path);
    turns.push(t);
    show();
    requestAnimationFrame(() => document.querySelector('.turn:last-child')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  return { show, showPage, showDiff };
}
