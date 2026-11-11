import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import { api, type AiFamily, type AiModel, type Checkout, type Project, type Explanation, type Progress, type TreeNode, type Volume, type Place, type SettingsInfo } from './api';
import { ago, bytes, bytesParts, clock, esc, int, pct, shortPath } from './format';
import { Sunburst, PALETTE, type Transition } from './sunburst';
import { startDrag } from './drag';
import { createAsk } from './ask';

const app = document.getElementById('app')!;
let home = '';
let pollTimer = 0;

type ViewName = 'home' | 'scan' | 'results' | 'settings' | 'ask';
const current: { view: ViewName; root: string | null } = { view: 'home', root: null };
let scans: Progress[] = [];

// ---------- shell ----------
app.innerHTML = `
  <header class="topbar">
    <button class="logo" id="logo" title="Home">DIRT</button>
    <div class="tagline">Disk<br/>Inspection &amp;<br/>Removal Tool</div>
    <nav class="tabs" id="tabs"></nav>
    <div class="topbar-right">
      <button class="btn btn-sm btn-ask" id="ask-btn"><span class="ai-spark">✦</span> Ask DIRT</button>
      <button class="btn btn-sm" id="settings-btn">Settings</button>
    </div>
  </header>
  <main id="view"></main>
  <div class="toast" id="toast" hidden></div>
`;
const view = document.getElementById('view')!;
document.getElementById('logo')!.addEventListener('click', () => void showHome());
document.getElementById('settings-btn')!.addEventListener('click', () => void showSettings());
document.getElementById('ask-btn')!.addEventListener('click', () => ask.show());

const ask = createAsk({
  view,
  enter: () => setView('ask'),
  isActive: () => current.view === 'ask',
  toast: (m, k) => toast(m, k),
  home: () => home,
  openSettings: () => void showSettings(),
});

function setView(v: ViewName, root: string | null = null) {
  clearInterval(pollTimer);
  disposeResults();
  current.view = v;
  current.root = root;
  document.getElementById('settings-btn')!.classList.toggle('btn-ink', v === 'settings');
  document.getElementById('ask-btn')!.classList.toggle('is-on', v === 'ask');
  renderTabs();
}

function toast(msg: string, kind: 'ok' | 'err' = 'ok') {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.className = `toast toast-${kind}`;
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => (t.hidden = true), 4200));
}

function bigBytes(n: number, cls = '') {
  const [num, unit] = bytesParts(n);
  return `<span class="bignum ${cls}">${num}<small>${unit}</small></span>`;
}

/** Friendly name for a scan root: the volume name for "/", else the folder name. */
function displayName(p: string) {
  if (p === '/') return 'Macintosh HD';
  if (home && p === home) return 'Home';
  return p.split('/').filter(Boolean).pop() || p;
}

function openScan(root: string) {
  const s = scans.find((x) => x.rootPath === root);
  if (s?.status === 'done') void showResults(root);
  else showScanning(root);
}

// ---------- scan tabs (global) ----------
function renderTabs() {
  const el = document.getElementById('tabs')!;
  el.innerHTML = scans
    .map((s) => {
      const active = (current.view === 'scan' || current.view === 'results') && current.root === s.rootPath;
      return `
      <span class="tab ${active ? 'is-active' : ''} is-${s.status}" data-root="${esc(s.rootPath)}" title="${esc(s.rootPath)}">
        ${s.status === 'scanning' ? '<span class="running-dot"></span>' : ''}
        <span class="tab-name">${esc(displayName(s.rootPath))}</span>
        <span class="tab-size">${s.status === 'error' ? 'Error' : bytes(s.bytes)}${s.status === 'done' ? ` · ${ago(s.finishedAt)}` : ''}</span>
        <button class="tab-x" data-close="${esc(s.rootPath)}" title="${s.status === 'scanning' ? 'Stop' : 'Close'}">✕</button>
      </span>`;
    })
    .join('');
  el.querySelectorAll<HTMLElement>('.tab').forEach((t) =>
    t.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-close]')) return;
      openScan(t.dataset.root!);
    }),
  );
  el.querySelectorAll<HTMLElement>('[data-close]').forEach((b) =>
    b.addEventListener('click', () => void closeScan(b.dataset.close!)),
  );
}

async function closeScan(root: string) {
  await api.close(root).catch(() => {});
  scans = scans.filter((s) => s.rootPath !== root);
  if (current.root === root) void showHome();
  else if (current.view === 'home') void showHome();
  else renderTabs();
}

/** Global 1s refresh: keeps tabs and home cards live, notices finished scans. */
async function refreshScans() {
  let next: Progress[];
  try {
    next = await api.scans();
  } catch {
    return;
  }
  const sig = (l: Progress[]) => l.map((s) => `${s.rootPath}:${s.status}`).join('|');
  const changed = sig(next) !== sig(scans);
  scans = next;
  renderTabs();
  if (current.view === 'home') {
    if (changed) return void showHome();
    for (const s of scans) {
      view.querySelectorAll<HTMLElement>('[data-live-root]').forEach((el) => {
        if (el.dataset.liveRoot === s.rootPath) el.textContent = bytes(s.bytes);
      });
    }
  }
}
setInterval(refreshScans, 1000);

// ---------- HOME ----------
async function showHome() {
  setView('home');
  view.innerHTML = `<section class="home"><div class="loading-block">LOADING VOLUMES…</div></section>`;
  let volumes: Volume[];
  let places: Place[];
  try {
    const r = await api.locations();
    volumes = r.volumes;
    places = r.places;
    home = r.home;
    scans = await api.scans();
  } catch (e) {
    view.innerHTML = `<section class="home"><div class="error-block">${esc(String(e))}</div></section>`;
    return;
  }
  if (current.view !== 'home') return;
  renderTabs();

  // Per-location state so cards can say "scanning" or "view results".
  const scanOf = (p: string) => scans.find((s) => s.rootPath === p);
  const stateOf = (p: string) => {
    const st = scanOf(p)?.status;
    return st === 'scanning' || st === 'done' ? st : null;
  };
  const cardActions = (p: string, label: string, cls: string) => {
    const st = stateOf(p);
    if (st === 'scanning') return `<button class="btn btn-acid" data-goto="${esc(p)}">View scan <span class="arrow">→</span></button>`;
    if (st === 'done')
      return `<span class="card-actions"><button class="btn btn-ink" data-goto="${esc(p)}">View results <span class="arrow">→</span></button><button class="btn btn-sm" data-scan="${esc(p)}">Rescan ↻</button><span class="scanned-ago">Scanned ${ago(scanOf(p)?.finishedAt)}</span></span>`;
    return `<button class="btn ${cls}" data-scan="${esc(p)}">${label} <span class="arrow">→</span></button>`;
  };

  view.innerHTML = `
    <section class="home">
      <div class="hero">
        <h1 class="hero-title">
          <span class="fit">Where did all your</span>
          <span class="fit"><mark>space</mark> go<span class="q">?</span></span>
        </h1>
        <form class="ask-form ask-home" id="home-ask">
          <span class="ask-prompt"><span class="ai-spark">✦</span> Ask DIRT</span>
          <textarea id="home-ask-input" rows="1" spellcheck="false" placeholder="Find old installers in Downloads · Which worktrees can I delete?"></textarea>
          <button class="btn btn-acid" type="submit">Ask <span class="arrow">→</span></button>
        </form>
      </div>

      <h3 class="section-label"><span>01</span> Volumes</h3>
      <div class="vol-grid">
        ${volumes
          .map((v, i) => {
            const used = v.total - v.free;
            const p = pct(used, v.total);
            const scanning = stateOf(v.path) === 'scanning';
            return `
            <article class="card vol ${scanning ? 'is-scanning' : ''}" style="--accent:${PALETTE[i % PALETTE.length]}">
              ${scanning ? `<div class="card-status"><span class="running-dot"></span>Scanning · <span data-live-root="${esc(v.path)}">${bytes(scanOf(v.path)!.bytes)}</span></div>` : ''}
              <div class="vol-top">
                <div>
                  <div class="eyebrow">${esc(shortPath(v.path, home))}</div>
                  <h2>${esc(v.name)}</h2>
                </div>
                <div class="vol-pct">${p >= 99 && p < 100 ? p.toFixed(1) : p.toFixed(0)}<small>%</small></div>
              </div>
              <div class="meter"><div class="meter-fill" style="width:${p.toFixed(2)}%"></div></div>
              <dl class="vol-stats">
                <div><dt>Used</dt><dd>${bytes(used)}</dd></div>
                <div><dt>Free</dt><dd>${bytes(v.free)}</dd></div>
                <div><dt>Total</dt><dd>${bytes(v.total)}</dd></div>
              </dl>
              ${cardActions(v.path, 'Scan volume', 'btn-ink')}
            </article>`;
          })
          .join('')}
      </div>

      <h3 class="section-label"><span>02</span> Folders</h3>
      <div class="place-grid">
        ${places
          .map((p, i) => {
            const st = stateOf(p.path);
            return `
          <button class="card place ${st ? 'is-' + st : ''}" ${st ? `data-goto="${esc(p.path)}"` : `data-scan="${esc(p.path)}"`} style="--accent:${PALETTE[(i + 3) % PALETTE.length]}">
            <span class="place-idx">${String(i + 1).padStart(2, '0')}</span>
            <span class="place-name">${esc(p.name)}</span>
            <span class="place-path">${
              st === 'scanning'
                ? `Scanning · <span data-live-root="${esc(p.path)}">${bytes(scanOf(p.path)!.bytes)}</span>`
                : st === 'done'
                  ? `${bytes(scanOf(p.path)!.bytes)} · ${ago(scanOf(p.path)!.finishedAt)}`
                  : esc(shortPath(p.path, home, 28))
            }</span>
            <span class="arrow">→</span>
          </button>`;
          })
          .join('')}
      </div>

      <h3 class="section-label"><span>03</span> Git projects</h3>
      <div class="projects" id="projects"><div class="loading-block">FINDING REPOS…</div></div>

      <h3 class="section-label"><span>04</span> Anywhere</h3>
      <form class="custom" id="custom">
        <input id="custom-path" type="text" spellcheck="false" autocomplete="off" placeholder="~/Projects or /Volumes/Archive" />
        <button class="btn btn-acid" type="submit">Scan <span class="arrow">→</span></button>
      </form>
    </section>`;

  fitHeadline();
  const homeAsk = document.getElementById('home-ask-input') as HTMLTextAreaElement;
  homeAsk.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('home-ask')!.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  document.getElementById('home-ask')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = homeAsk.value.trim();
    if (q) ask.show(q);
  });
  void loadProjects(false);
  view.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => openScan(b.dataset.goto!)));
  view.querySelectorAll<HTMLElement>('[data-scan]').forEach((b) => b.addEventListener('click', () => void beginScan(b.dataset.scan!)));
  document.getElementById('custom')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = (document.getElementById('custom-path') as HTMLInputElement).value.trim();
    if (!raw) return;
    const v = raw.replace(/^~(?=$|\/)/, home).replace(/\/+$/, '') || '/';
    if (stateOf(v)) return openScan(v);
    void beginScan(v);
  });
}

// ---------- GIT PROJECTS ----------
let projectsShowAll = false;
const armed = new Set<string>();

async function loadProjects(refresh: boolean) {
  const el = document.getElementById('projects');
  if (!el) return;
  if (refresh) el.innerHTML = '<div class="loading-block">FINDING REPOS…</div>';
  let data: { roots: string[]; repos: Project[] };
  try {
    data = await api.projects(refresh);
  } catch (e) {
    el.innerHTML = `<div class="error-block">${esc((e as Error).message)}</div>`;
    return;
  }
  if (current.view !== 'home') return;
  renderProjects(data.repos, data.roots);
}

function wtBadges(c: Checkout, isMain: boolean) {
  const b: string[] = [];
  if (c.missing) b.push('<span class="badge b-red">Folder missing</span>');
  if (!isMain && c.merged) b.push('<span class="badge b-green">Merged</span>');
  if (c.unpushed) b.push(`<span class="badge b-acid">${c.unpushed} unpushed</span>`);
  if (c.uncommitted) b.push(`<span class="badge b-ink">${c.uncommitted} uncommitted</span>`);
  return b.join('');
}

function renderProjects(repos: Project[], roots: string[]) {
  const el = document.getElementById('projects');
  if (!el) return;
  const sorted = [...repos].sort(
    (a, b) => b.worktrees.length - a.worktrees.length || (b.size ?? -1) - (a.size ?? -1) || (b.main.lastUsed ?? 0) - (a.main.lastUsed ?? 0),
  );
  const wtCount = repos.reduce((s, r) => s + r.worktrees.length, 0);
  const wtBytes = repos.reduce((s, r) => s + r.worktrees.reduce((x, w) => x + (w.size ?? 0), 0), 0);
  const shown = projectsShowAll ? sorted : sorted.slice(0, Math.max(8, sorted.filter((r) => r.worktrees.length).length));

  el.innerHTML = `
    <div class="proj-summary">
      <div class="proj-stat"><b>${repos.length}</b><span>repos</span></div>
      <div class="proj-stat"><b>${wtCount}</b><span>worktrees</span></div>
      <div class="proj-stat proj-stat-acid"><b>${bytes(wtBytes)}</b><span>in worktrees</span></div>
      <div class="proj-roots">${roots.map((r) => `<code>${esc(shortPath(r, home, 30))}</code>`).join(' ')}</div>
      <button class="btn btn-sm" id="proj-refresh">Refresh ↻</button>
    </div>
    <div class="proj-list">
      ${shown
        .map(
          (r) => `
        <article class="proj ${r.worktrees.length ? 'has-wt' : ''}" data-repo="${esc(r.repo)}">
          <div class="proj-head">
            <div class="proj-id">
              <div class="proj-name">${esc(r.name)}${r.main.branch ? `<span class="proj-branch">${esc(r.main.branch)}</span>` : ''}</div>
              <div class="proj-meta">${esc(shortPath(r.repo, home, 48))}${r.main.lastUsed ? ` · used ${ago(r.main.lastUsed)}` : ''}</div>
            </div>
            <div class="proj-badges">${wtBadges(r.main, true)}</div>
            <div class="proj-size">${r.size != null ? bytes(r.size) : '<span class="muted">—</span>'}</div>
            <div class="proj-actions">
              <button class="mini mini-ai" data-act="analyze" title="AI: find build output and junk">Analyze ✦</button>
              <button class="mini" data-act="scan" title="Scan this repo">Scan</button>
              <button class="mini" data-act="reveal" data-path="${esc(r.repo)}" title="Reveal in Finder">↗</button>
            </div>
          </div>
          ${
            r.worktrees.length
              ? `<ul class="wt-list">${r.worktrees
                  .map(
                    (w) => `
              <li class="wt ${w.missing ? 'is-missing' : ''}" data-wt="${esc(w.path)}">
                <span class="wt-branch">${esc(w.branch ?? (w.detached ? 'detached' : '—'))}</span>
                <span class="wt-path">${esc(shortPath(w.path, home, 60))}</span>
                <span class="wt-used">${w.lastUsed ? `used ${ago(w.lastUsed)}` : ''}</span>
                <span class="wt-badges">${wtBadges(w, false)}</span>
                <span class="wt-size">${w.size != null ? `<b>${bytes(w.size)}</b>` : ''}${w.deps ? `<small>${bytes(w.deps)} deps</small>` : ''}</span>
                <span class="wt-actions">
                  ${
                    w.missing
                      ? '<button class="mini" data-act="prune">Prune</button>'
                      : `<button class="mini mini-ai" data-act="diff">Diff</button>
                         <button class="mini" data-act="reveal" data-path="${esc(w.path)}">↗</button>
                         ${w.deps ? '<button class="mini" data-act="deps" title="Move node_modules / target to Trash">Trash deps</button>' : ''}
                         <button class="mini ${armed.has(w.path) ? 'mini-armed' : 'mini-bin'}" data-act="remove">${armed.has(w.path) ? 'Confirm remove' : 'Remove'}</button>`
                  }
                </span>
              </li>`,
                  )
                  .join('')}</ul>`
              : ''
          }
        </article>`,
        )
        .join('')}
    </div>
    ${sorted.length > shown.length || projectsShowAll ? `<button class="btn btn-sm proj-more" id="proj-more">${projectsShowAll ? 'Show fewer' : `Show all ${sorted.length} repos`}</button>` : ''}`;

  el.querySelector('#proj-refresh')?.addEventListener('click', () => void loadProjects(true));
  el.querySelector('#proj-more')?.addEventListener('click', () => {
    projectsShowAll = !projectsShowAll;
    renderProjects(repos, roots);
  });

  el.querySelectorAll<HTMLElement>('.proj').forEach((card) => {
    const repo = repos.find((r) => r.repo === card.dataset.repo)!;
    card.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const wtEl = btn.closest<HTMLElement>('[data-wt]');
      const wt = wtEl?.dataset.wt;
      try {
        if (act === 'reveal') return void (await api.revealPath(btn.dataset.path!));
        if (act === 'scan') return void beginScan(repo.repo);
        if (act === 'diff' && wt) return void ask.showDiff(wt);
        if (act === 'analyze') {
          btn.disabled = true;
          btn.textContent = 'Analyzing…';
          const page = await api.analyzeRepo(repo.repo);
          return ask.showPage(`Analyze ${repo.name}`, page);
        }
        if (act === 'prune') {
          await api.pruneWorktrees(repo.repo);
          toast('Pruned missing worktree entries.');
          return void loadProjects(true);
        }
        if (act === 'deps' && wt) {
          const r = await api.trashPaths([`${wt}/node_modules`, `${wt}/target`]);
          toast(r.trashed.length ? `Moved ${r.trashed.length} dependency folder${r.trashed.length > 1 ? 's' : ''} to Trash.` : 'Nothing to trash.');
          return void loadProjects(true);
        }
        if (act === 'remove' && wt) {
          if (!armed.has(wt)) {
            armed.add(wt);
            setTimeout(() => armed.delete(wt), 6000);
            return renderProjects(repos, roots);
          }
          armed.delete(wt);
          btn.disabled = true;
          btn.textContent = 'Removing…';
          const r = await api.removeWorktree(wt);
          toast(r.stashed ? 'Worktree removed. Uncommitted changes were stashed in the repo; the branch is kept.' : 'Worktree removed. The branch is kept.');
          return void loadProjects(true);
        }
      } catch (err) {
        toast((err as Error).message, 'err');
        if (act === 'analyze') {
          btn.disabled = false;
          btn.textContent = 'Analyze ✦';
        }
      }
    });
  });
}

/** Scale each headline line so it spans exactly the full content width. */
let fitObserver: ResizeObserver | null = null;
function fitHeadline() {
  const title = view.querySelector<HTMLElement>('.hero-title');
  fitObserver?.disconnect();
  if (!title) return;
  const fit = () => {
    const width = title.clientWidth;
    title.querySelectorAll<HTMLElement>('.fit').forEach((line) => {
      line.style.fontSize = '100px';
      const natural = line.scrollWidth;
      if (natural > 0) line.style.fontSize = `${(100 * width) / natural}px`;
    });
  };
  fit();
  void document.fonts.ready.then(fit);
  fitObserver = new ResizeObserver(fit);
  fitObserver.observe(title);
}

// ---------- SETTINGS ----------
async function showSettings() {
  setView('settings');
  let info: SettingsInfo;
  try {
    info = await api.getSettings();
  } catch (e) {
    toast((e as Error).message, 'err');
    return;
  }
  if (current.view !== 'settings') return;
  const { settings, limits, defaults, cores } = info;
  const memLabel = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)}<small>GB</small>` : `${mb}<small>MB</small>`);
  const threadPresets = [
    ['Gentle', 4],
    ['Default', defaults.threads],
    ['Fast', Math.min(limits.threads[1], Math.max(cores * 4, 32))],
  ] as const;
  const memPresets = [
    ['Lean', 128],
    ['Default', defaults.memoryMb],
    ['Big', 1024],
    ['Huge', 4096],
  ] as const;

  view.innerHTML = `
    <section class="settings">
      <h1 class="page-title">Settings</h1>
      <div class="settings-grid">
        <article class="card setting" style="--accent:${PALETTE[1]}">
          <div class="setting-head">
            <h2>Threads</h2>
            <div class="bignum setting-value" id="v-threads">${settings.threads}</div>
          </div>
          <input class="range" type="range" id="r-threads" min="${limits.threads[0]}" max="${limits.threads[1]}" step="1" value="${settings.threads}" />
          <div class="ticks"><span>${limits.threads[0]}</span><span>${cores} cores</span><span>${limits.threads[1]}</span></div>
          <div class="presets">
            ${threadPresets.map(([l, v]) => `<button class="preset" data-threads="${v}">${l}<b>${v}</b></button>`).join('')}
          </div>
        </article>

        <article class="card setting" style="--accent:${PALETTE[3]}">
          <div class="setting-head">
            <h2>Memory budget</h2>
            <div class="bignum setting-value" id="v-mem">${memLabel(settings.memoryMb)}</div>
          </div>
          <input class="range" type="range" id="r-mem" min="${limits.memoryMb[0]}" max="${limits.memoryMb[1]}" step="64" value="${settings.memoryMb}" />
          <div class="ticks"><span>${limits.memoryMb[0]} MB</span><span>${(info.totalMemMb / 1024).toFixed(0)} GB RAM</span><span>${limits.memoryMb[1] / 1024} GB</span></div>
          <div class="presets">
            ${memPresets.map(([l, v]) => `<button class="preset" data-mem="${v}">${l}<b>${v >= 1024 ? v / 1024 + ' GB' : v + ' MB'}</b></button>`).join('')}
          </div>
          <div class="usage">
            <div class="usage-label"><span>In use</span><b id="u-text"></b></div>
            <div class="meter"><div class="meter-fill" id="u-fill"></div></div>
          </div>
        </article>
      </div>
      <article class="card setting setting-wide" style="--accent:${PALETTE[4]}">
        <div class="setting-head">
          <h2>OpenRouter</h2>
          <div class="key-state ${info.apiKey.hasKey ? 'is-set' : ''}" id="key-state">${info.apiKey.hasKey ? `Saved ••••${esc(info.apiKey.hint ?? '')}` : 'Not set'}</div>
        </div>
        <form class="custom" id="key-form">
          <input id="key-input" type="password" spellcheck="false" autocomplete="off" placeholder="sk-or-…" />
          <button class="btn btn-acid" type="submit">Save</button>
          <button class="btn" type="button" id="key-clear" ${info.apiKey.hasKey ? '' : 'hidden'}>Remove</button>
        </form>
        <div class="families" id="families"><div class="fam-loading">Loading models…</div></div>
        <details class="all-models" id="all-models">
          <summary>All models</summary>
          <div class="model-pick">
            <input id="model-filter" type="text" spellcheck="false" autocomplete="off" placeholder="Filter: deepseek, qwen, llama…" />
            <select id="model-select" size="8"><option>Loading…</option></select>
          </div>
        </details>
      </article>
      <div class="settings-foot">
        <button class="btn" id="reset">Reset to defaults</button>
        <span class="saved" id="saved" hidden>Saved</span>
      </div>
    </section>`;

  const rT = document.getElementById('r-threads') as HTMLInputElement;
  const rM = document.getElementById('r-mem') as HTMLInputElement;
  const paint = () => {
    document.getElementById('v-threads')!.textContent = rT.value;
    document.getElementById('v-mem')!.innerHTML = memLabel(Number(rM.value));
    for (const r of [rT, rM]) r.style.setProperty('--fill', `${((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100}%`);
    view.querySelectorAll<HTMLElement>('[data-threads]').forEach((b) => b.classList.toggle('is-on', b.dataset.threads === rT.value));
    view.querySelectorAll<HTMLElement>('[data-mem]').forEach((b) => b.classList.toggle('is-on', b.dataset.mem === rM.value));
  };
  let savedTimer = 0;
  const save = async () => {
    try {
      const s = await api.setSettings({ threads: Number(rT.value), memoryMb: Number(rM.value) });
      rT.value = String(s.threads);
      rM.value = String(s.memoryMb);
      paint();
      const el = document.getElementById('saved');
      if (el) {
        el.hidden = false;
        clearTimeout(savedTimer);
        savedTimer = window.setTimeout(() => (el.hidden = true), 1400);
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  for (const r of [rT, rM]) {
    r.addEventListener('input', paint);
    r.addEventListener('change', () => void save());
  }
  view.querySelectorAll<HTMLElement>('[data-threads]').forEach((b) =>
    b.addEventListener('click', () => {
      rT.value = b.dataset.threads!;
      paint();
      void save();
    }),
  );
  view.querySelectorAll<HTMLElement>('[data-mem]').forEach((b) =>
    b.addEventListener('click', () => {
      rM.value = b.dataset.mem!;
      paint();
      void save();
    }),
  );
  const keyState = (hasKey: boolean, hint: string | null) => {
    const el = document.getElementById('key-state');
    if (el) {
      el.textContent = hasKey ? `Saved ••••${hint ?? ''}` : 'Not set';
      el.classList.toggle('is-set', hasKey);
    }
    const clear = document.getElementById('key-clear');
    if (clear) clear.hidden = !hasKey;
  };
  document.getElementById('key-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('key-input') as HTMLInputElement;
    if (!input.value.trim()) return;
    try {
      const r = await api.setApiKey(input.value);
      input.value = '';
      keyState(r.hasKey, r.hint);
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  });
  // Model picker: "@latest" families as big buttons, plus the full list.
  const famEl = document.getElementById('families')!;
  const sel = document.getElementById('model-select') as HTMLSelectElement;
  const filter = document.getElementById('model-filter') as HTMLInputElement;
  let models: AiModel[] = [];
  let fams: AiFamily[] = [];
  let currentModel = settings.aiModel;
  // Typical question: ~2k tokens in, ~600 out (incl. reasoning).
  const perQuestion = (m: AiModel) => (m.priceIn * 2000 + m.priceOut * 600) / 1e6;
  const money = (n: number) => (n === 0 ? 'free' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
  const flashSaved = () => {
    const el = document.getElementById('saved');
    if (el) {
      el.hidden = false;
      window.setTimeout(() => (el.hidden = true), 1400);
    }
  };
  const renderFamilies = () => {
    const custom = !currentModel.startsWith('@') ? models.find((m) => m.id === currentModel) : null;
    famEl.innerHTML =
      fams
        .map(
          (f) => `
        <button class="fam ${f.alias === currentModel ? 'is-on' : ''}" data-alias="${esc(f.alias)}" ${f.model ? '' : 'disabled'}>
          <span class="fam-label">${esc(f.label)}</span>
          <span class="fam-id">${f.model ? esc(f.model.id.split('/')[1]) : 'unavailable'}</span>
          <span class="fam-price">${f.model ? `≈${money(perQuestion(f.model))}` : ''}</span>
        </button>`,
        )
        .join('') +
      (custom
        ? `<div class="fam is-on fam-custom"><span class="fam-label">Custom</span><span class="fam-id">${esc(custom.id)}</span><span class="fam-price">≈${money(perQuestion(custom))}</span></div>`
        : '');
    famEl.querySelectorAll<HTMLElement>('[data-alias]').forEach((b) => b.addEventListener('click', () => void choose(b.dataset.alias!)));
  };
  const renderModels = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    sel.innerHTML = shown
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${m.id === currentModel ? 'selected' : ''}>${esc(m.id)}  ·  $${m.priceIn.toFixed(2)} / $${m.priceOut.toFixed(2)}</option>`,
      )
      .join('');
  };
  const choose = async (id: string) => {
    try {
      currentModel = (await api.setSettings({ aiModel: id })).aiModel;
      renderFamilies();
      renderModels();
      flashSaved();
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };
  filter.addEventListener('input', renderModels);
  sel.addEventListener('change', () => void choose(sel.value));
  Promise.all([api.aiFamilies(), api.aiModels()])
    .then(([f, list]) => {
      fams = f;
      models = list;
      renderFamilies();
      renderModels();
    })
    .catch((err) => {
      famEl.innerHTML = `<div class="ai-error">${esc((err as Error).message)}</div>`;
    });
  document.getElementById('key-clear')!.addEventListener('click', async () => {
    const r = await api.setApiKey('');
    keyState(r.hasKey, r.hint);
  });
  document.getElementById('reset')!.addEventListener('click', () => {
    rT.value = String(defaults.threads);
    rM.value = String(defaults.memoryMb);
    paint();
    void save();
  });
  paint();

  const BYTES_PER_NODE = 170;
  const usage = async () => {
    const i = await api.getSettings().catch(() => null);
    const t = document.getElementById('u-text');
    const f = document.getElementById('u-fill');
    if (!i || !t || !f) return;
    const usedMb = (i.usage.nodes * BYTES_PER_NODE) / 1048576;
    t.textContent = `${usedMb.toFixed(usedMb < 10 ? 1 : 0)} MB / ${Number(rM.value) >= 1024 ? (Number(rM.value) / 1024).toFixed(1) + ' GB' : rM.value + ' MB'}`;
    f.style.width = `${Math.min(100, (usedMb / Number(rM.value)) * 100).toFixed(1)}%`;
  };
  void usage();
  pollTimer = window.setInterval(usage, 1000);
}

// ---------- SCANNING ----------
async function beginScan(path: string) {
  let p: Progress;
  try {
    p = await api.scan(path);
  } catch (e) {
    toast(String((e as Error).message), 'err');
    return;
  }
  scans = [...scans.filter((s) => s.rootPath !== p.rootPath), p];
  showScanning(p.rootPath);
}

function showScanning(root: string) {
  setView('scan', root);
  view.innerHTML = `
    <section class="scanning">
      <div class="eyebrow">Now digging</div>
      <h1 class="scan-target">${esc(displayName(root))}</h1>
      <div class="stripes"><div></div></div>
      <div class="scan-grid">
        <div class="card stat"><div class="eyebrow">Found</div><div id="s-bytes" class="bignum">0<small>B</small></div></div>
        <div class="card stat"><div class="eyebrow">Files</div><div id="s-files" class="bignum">0</div></div>
        <div class="card stat"><div class="eyebrow">Folders</div><div id="s-dirs" class="bignum">0</div></div>
        <div class="card stat"><div class="eyebrow">Elapsed</div><div id="s-time" class="bignum">00:00</div></div>
      </div>
      <div class="ticker card"><span class="ticker-label">PATH</span><code id="s-current"></code></div>
      <button class="btn btn-red" id="s-cancel">Stop ✕</button>
    </section>`;
  document.getElementById('s-cancel')!.addEventListener('click', () => void closeScan(root));

  const tick = async () => {
    let p: Progress;
    try {
      p = await api.status(root);
    } catch {
      clearInterval(pollTimer);
      return;
    }
    if (current.view !== 'scan' || current.root !== root) return;
    const set = (id: string, html: string) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    };
    const [n, u] = bytesParts(p.bytes);
    set('s-bytes', `${n}<small>${u}</small>`);
    set('s-files', int(p.files));
    set('s-dirs', int(p.dirs));
    set('s-time', clock(p.elapsed));
    set('s-current', esc(shortPath(p.current, home, 90)));
    if (p.status === 'done') {
      clearInterval(pollTimer);
      if (p.truncated) toast('Hit the memory budget: totals are complete, but some deep items are not itemized.', 'err');
      void showResults(root);
    } else if (p.status === 'error') {
      clearInterval(pollTimer);
      toast(p.error || 'Scan failed', 'err');
    }
  };
  pollTimer = window.setInterval(tick, 250);
  void tick();
}

// ---------- RESULTS ----------
interface ResultsState {
  rootPath: string;
  tree: TreeNode;
  chart: Sunburst;
  bin: Map<string, TreeNode>;
  progress: Progress;
  confirming: boolean;
  /** Paths selected in the list (children of the current view). */
  sel: Set<string>;
  /** Index of the last row clicked, for shift-click ranges. */
  anchor: number | null;
  keyHandler: (e: KeyboardEvent) => void;
}
let R: ResultsState | null = null;

function disposeResults() {
  if (!R) return;
  R.chart.destroy();
  window.removeEventListener('keydown', R.keyHandler);
  R = null;
}

async function showResults(root: string) {
  setView('results', root);
  let rootPath: string;
  let tree: TreeNode;
  let progress: Progress;
  try {
    [{ rootPath, tree }, progress] = await Promise.all([api.tree(root, ''), api.status(root)]);
    if (!home) home = (await api.locations()).home;
  } catch (e) {
    toast((e as Error).message, 'err');
    return void showHome();
  }
  if (current.view !== 'results' || current.root !== root) return;

  view.innerHTML = `
    <section class="results">
      <nav class="crumbs" id="crumbs"></nav>
      <div class="stage">
        <div class="card chart-card">
          <div class="chart-host" id="chart-host"></div>
          <div class="center" id="center"></div>
          <div class="chart-hint"><span>Click</span> dive in <span>Center</span> go up <span>Drag</span> to bin</div>
        </div>
        <aside class="card panel">
          <div class="panel-head" id="panel-head"></div>
          <div class="rows-head" id="rows-head"></div>
          <ol class="rows" id="rows"></ol>
        </aside>
      </div>
      <footer class="bin" id="bin"></footer>
    </section>`;

  const chart = new Sunburst({
    hover: (n) => {
      renderCenter(n);
      highlightRow(n?.path ?? null);
    },
    drill: (n) => void navigate(n.path, 'in'),
    up: () => goUp(),
    dragStart: (n, e) => beginDrag(n, e),
    ask: (n) => void askAI(n),
  });
  document.getElementById('chart-host')!.append(chart.el);

  const keyHandler = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Escape' && R?.sel.size) {
      R.sel.clear();
      renderSelection();
      return;
    }
    if (document.getElementById('ai')) {
      if (e.key === 'Escape') closeAI();
      return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      goUp();
    }
  };
  window.addEventListener('keydown', keyHandler);

  R = { rootPath, tree, chart, bin: new Map(), progress, confirming: false, sel: new Set(), anchor: null, keyHandler };
  // Let layout settle so the chart knows its size before the first sweep.
  requestAnimationFrame(() => {
    if (!R) return;
    chart.render(tree, null);
    renderAll();
  });
}

function parentPath(p: string) {
  if (!R || p === R.rootPath) return null;
  const i = p.lastIndexOf('/');
  const up = i <= 0 ? '/' : p.slice(0, i);
  return up.length < R.rootPath.length ? R.rootPath : up;
}

function goUp() {
  if (!R) return;
  const up = parentPath(R.tree.path);
  if (up) void navigate(up, 'out');
}

async function navigate(path: string, dir: 'in' | 'out' | 'none') {
  if (!R) return;
  const prev = R.tree.path;
  let transition: Transition = null;
  if (dir === 'in') {
    const g = R.chart.geometryOf(path);
    transition = g ? { kind: 'in', from: g } : null;
  } else if (dir === 'out') {
    transition = { kind: 'out', childPath: prev };
  }
  let tree: TreeNode;
  try {
    tree = (await api.tree(R.rootPath, path)).tree;
  } catch (e) {
    toast((e as Error).message, 'err');
    return;
  }
  if (!R) return;
  R.tree = tree;
  R.sel.clear();
  R.anchor = null;
  R.chart.render(tree, transition);
  renderAll();
}

function renderAll() {
  renderCrumbs();
  renderCenter(null);
  renderPanel();
  renderBin();
}

function renderCrumbs() {
  if (!R) return;
  const { rootPath, tree } = R;
  const rel = tree.path === rootPath ? [] : tree.path.slice(rootPath.length).split('/').filter(Boolean);
  const rootName = rootPath === '/' ? 'Macintosh HD' : rootPath.split('/').pop() || rootPath;
  const crumbs = [{ name: rootName, path: rootPath }];
  let acc = rootPath;
  for (const part of rel) {
    acc = acc === '/' ? '/' + part : acc + '/' + part;
    crumbs.push({ name: part, path: acc });
  }
  const el = document.getElementById('crumbs')!;
  el.innerHTML =
    `<button class="crumb crumb-up" ${crumbs.length < 2 ? 'disabled' : ''} data-up="1">↑ Up</button>` +
    crumbs
      .map(
        (c, i) =>
          `<button class="crumb ${i === crumbs.length - 1 ? 'crumb-current' : ''}" data-path="${esc(c.path)}">${esc(c.name)}</button>`,
      )
      .join('<span class="crumb-sep">/</span>') +
    `<span class="crumbs-spacer"></span><span class="crumb-age">Scanned ${ago(R.progress.finishedAt)}</span><button class="crumb" id="rescan">Rescan ↻</button>`;
  el.querySelector('#rescan')?.addEventListener('click', () => R && void beginScan(R.rootPath));
  el.querySelector('[data-up]')?.addEventListener('click', goUp);
  el.querySelectorAll<HTMLElement>('[data-path]').forEach((b) =>
    b.addEventListener('click', () => {
      if (R && b.dataset.path !== R.tree.path) void navigate(b.dataset.path!, 'out');
    }),
  );
}

function renderCenter(hover: TreeNode | null) {
  if (!R) return;
  const n = hover ?? R.tree;
  const el = document.getElementById('center')!;
  const share = hover ? pct(hover.size, R.tree.size) : null;
  el.innerHTML = `
    <div class="center-inner ${hover ? 'is-hover' : ''}">
      <div class="center-kind">${hover ? (n.opaque ? 'Package' : n.type === 'dir' ? 'Folder' : n.type === 'file' ? 'File' : 'Grouped') : 'You are here'}</div>
      <div class="center-name">${esc(n.name)}</div>
      ${bigBytes(n.size, 'center-size')}
      <div class="center-meta">${share !== null ? `${share.toFixed(1)}% of view` : `${int(n.count)} files`}</div>
    </div>`;
  const r = R.chart.holeRadius();
  el.style.width = el.style.height = `${r * 2}px`;
}

function childColor(i: number, n: TreeNode) {
  return n.type === 'rest' ? 'var(--hatch)' : PALETTE[i % PALETTE.length];
}

function renderPanel() {
  if (!R) return;
  const { tree, progress, rootPath } = R;
  const head = document.getElementById('panel-head')!;
  const isVolumeRoot = tree.path === rootPath && progress.volume && (rootPath === '/' || rootPath.startsWith('/Volumes/'));
  const unseen = isVolumeRoot && progress.volume ? Math.max(0, progress.volume.total - progress.volume.free - tree.size) : 0;
  head.innerHTML = `
    <div class="eyebrow">${tree.path === rootPath ? 'Scan root' : 'Folder'}</div>
    <h2 class="panel-title">${esc(tree.name)}</h2>
    <div class="panel-path">${esc(shortPath(tree.path, home, 56))}</div>
    <div class="panel-size">${bigBytes(tree.size)}</div>
    <div class="chips">
      <span class="chip">${int(tree.count)} files</span>
      ${progress.errors ? `<span class="chip chip-warn" title="Couldn't read these. Grant Full Disk Access to include them.">${int(progress.errors)} unreadable</span>` : ''}
      ${unseen > 1e9 ? `<span class="chip chip-hatch" title="Used on disk but not visible to the scan: system files, APFS snapshots, purgeable space, or protected folders.">${bytes(unseen)} hidden / system</span>` : ''}
      <button class="chip chip-btn" data-reveal="${esc(tree.path)}">Reveal in Finder ↗</button>
      <button class="chip chip-btn chip-ai" id="ask-here"><span class="ai-spark">✦</span> What is this?</button>
    </div>`;
  head.querySelector('#ask-here')?.addEventListener('click', () => void askAI(tree));
  head.querySelector<HTMLElement>('[data-reveal]')?.addEventListener('click', (e) => void reveal((e.currentTarget as HTMLElement).dataset.reveal!));

  const rows = document.getElementById('rows')!;
  const kids = tree.children ?? [];
  const max = kids.reduce((m, k) => Math.max(m, k.size), 0) || 1;
  rows.innerHTML = kids.length
    ? kids
        .map((k, i) => {
          const share = pct(k.size, tree.size);
          const drillable = k.type === 'dir' && k.hasKids;
          return `
          <li class="row ${drillable ? 'is-dir' : ''} ${k.opaque ? 'is-opaque' : ''} t-${k.type}" data-i="${i}" data-path="${esc(k.path)}">
            <span class="row-rank" data-act="select" title="Select (⌘-click, shift-click for a range)">${String(i + 1).padStart(2, '0')}</span>
            <span class="row-swatch" style="background:${childColor(i, k)}"></span>
            <span class="row-main">
              <span class="row-name">${esc(k.name)}${k.opaque ? `<span class="row-tag">${k.count ? `${int(k.count)} files` : 'summarized'}</span>` : ''}${drillable ? '<span class="row-go">→</span>' : ''}</span>
              <span class="row-bar"><span style="width:${((k.size / max) * 100).toFixed(2)}%;background:${childColor(i, k)}"></span></span>
            </span>
            <span class="row-size">${bytes(k.size)}<small>${share.toFixed(1)}%</small></span>
            ${k.type !== 'rest' ? `<span class="row-actions"><button class="mini mini-ai" data-act="ask" title="What is this?">✦ AI</button><button class="mini" data-act="reveal" title="Reveal in Finder">↗</button><button class="mini mini-bin" data-act="bin" title="Add to bin">+ Bin</button></span>` : '<span class="row-actions"></span>'}
          </li>`;
        })
        .join('')
    : `<li class="empty">Nothing big in here. Just ${int(tree.count)} small files.</li>`;

  rows.querySelectorAll<HTMLLIElement>('.row').forEach((row) => {
    const k = kids[Number(row.dataset.i)];
    row.addEventListener('pointerenter', () => {
      R?.chart.highlight(k.path);
      renderCenter(k);
    });
    row.addEventListener('pointerleave', () => {
      R?.chart.highlight(null);
      renderCenter(null);
    });
    let dragged = false;
    row.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button') || e.button !== 0 || k.type === 'rest') return;
      dragged = false;
      const x = e.clientX;
      const y = e.clientY;
      const move = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - x, ev.clientY - y) > 6) {
          dragged = true;
          window.removeEventListener('pointermove', move);
          const group = R && R.sel.has(k.path) ? selectedNodes() : [];
          if (group.length > 1) beginDragMany(group, ev);
          else beginDrag(k, ev);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
    });
    row.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'bin') return addToBin(k);
      if (act === 'ask') return void askAI(k);
      if (act === 'reveal') return void reveal(k.path);
      if (dragged || !R) return;
      const i = Number(row.dataset.i);
      // Shift-click: select a range from the last clicked row.
      if (e.shiftKey) {
        const from = R.anchor ?? i;
        const [a, b] = from < i ? [from, i] : [i, from];
        for (let j = a; j <= b; j++) if (kids[j].type !== 'rest') R.sel.add(kids[j].path);
        R.anchor = i;
        return renderSelection();
      }
      // Cmd/Ctrl-click or clicking the row number: toggle one.
      if (e.metaKey || e.ctrlKey || act === 'select') {
        if (k.type === 'rest') return;
        if (R.sel.has(k.path)) R.sel.delete(k.path);
        else R.sel.add(k.path);
        R.anchor = i;
        return renderSelection();
      }
      R.anchor = i;
      if (k.type === 'dir' && k.hasKids) void navigate(k.path, 'in');
    });
  });
  renderSelection();
}

/** Selected nodes among the current view's children. */
function selectedNodes(): TreeNode[] {
  if (!R) return [];
  return (R.tree.children ?? []).filter((k) => R!.sel.has(k.path));
}

function renderSelection() {
  if (!R) return;
  document.querySelectorAll<HTMLElement>('#rows .row').forEach((r) => r.classList.toggle('is-sel', R!.sel.has(r.dataset.path!)));
  const head = document.getElementById('rows-head');
  if (!head) return;
  const sel = selectedNodes();
  if (!sel.length) {
    head.className = 'rows-head';
    head.innerHTML = '<span>Contents</span><span>Size</span>';
    return;
  }
  const total = sel.reduce((s, n) => s + n.size, 0);
  head.className = 'rows-head is-selecting';
  head.innerHTML = `
    <span>${sel.length} selected · ${bytes(total)}</span>
    <span class="sel-actions">
      <button class="sel-btn" id="sel-all">All</button>
      <button class="sel-btn sel-bin" id="sel-bin">+ Bin</button>
      <button class="sel-btn" id="sel-clear">Clear</button>
    </span>`;
  head.querySelector('#sel-bin')!.addEventListener('click', () => {
    for (const n of sel) addToBin(n, true);
    R!.sel.clear();
    renderSelection();
  });
  head.querySelector('#sel-all')!.addEventListener('click', () => {
    for (const k of R!.tree.children ?? []) if (k.type !== 'rest') R!.sel.add(k.path);
    renderSelection();
  });
  head.querySelector('#sel-clear')!.addEventListener('click', () => {
    R!.sel.clear();
    renderSelection();
  });
}

function highlightRow(path: string | null) {
  document.querySelectorAll<HTMLElement>('#rows .row').forEach((r) => {
    const p = r.dataset.path!;
    r.classList.toggle('row-lit', !!path && (path === p || path.startsWith(p + '/')));
  });
}

async function reveal(path: string) {
  try {
    if (R) await api.reveal(R.rootPath, path);
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

// ---------- AI: "What is this?" ----------
const VERDICT_LABEL: Record<Explanation['verdict'], string> = { safe: 'Safe to delete', caution: 'Caution', keep: 'Keep' };

function closeAI() {
  document.getElementById('ai')?.remove();
}

async function askAI(node: TreeNode) {
  if (!R || node.type === 'rest') return;
  const root = R.rootPath;
  closeAI();
  const overlay = document.createElement('div');
  overlay.className = 'ai-overlay';
  overlay.id = 'ai';
  overlay.innerHTML = `
    <div class="card ai-card" role="dialog" aria-label="What is this?">
      <div class="ai-head">
        <span class="ai-tag">What is this?</span>
        <button class="ai-x" title="Close">✕</button>
      </div>
      <div class="ai-subject">
        <div class="ai-name">${esc(node.name)}</div>
        <div class="ai-meta">${esc(shortPath(node.path, home, 70))} · ${bytes(node.size)}</div>
      </div>
      <div class="ai-body"><div class="stripes"><div></div></div><div class="ai-loading">Asking Claude…</div></div>
    </div>`;
  document.body.append(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || (e.target as HTMLElement).closest('.ai-x')) closeAI();
  });

  let a: Explanation;
  try {
    a = await api.explain(root, node.path);
  } catch (e) {
    const body = overlay.querySelector('.ai-body');
    if (!body) return;
    const msg = (e as Error).message;
    body.innerHTML = `<div class="ai-error">${esc(msg)}</div>${/key|Settings/i.test(msg) ? '<button class="btn btn-ink" id="ai-settings">Open settings →</button>' : ''}`;
    body.querySelector('#ai-settings')?.addEventListener('click', () => {
      closeAI();
      void showSettings();
    });
    return;
  }
  const body = overlay.querySelector('.ai-body');
  if (!body || !document.body.contains(overlay)) return;
  const canBin = R && node.path !== R.rootPath;
  body.innerHTML = `
    <div class="verdict v-${a.verdict}">${VERDICT_LABEL[a.verdict] ?? a.verdict}</div>
    <h2 class="ai-title">${esc(a.title)}</h2>
    <dl class="ai-facts">
      <div><dt>What</dt><dd>${esc(a.what)}</dd></div>
      <div><dt>Made by</dt><dd>${esc(a.createdBy)}</dd></div>
      <div><dt>Why</dt><dd>${esc(a.why)}</dd></div>
      <div><dt>Reclaim</dt><dd>${esc(a.howToReclaim)}</dd></div>
    </dl>
    <div class="ai-actions">
      ${canBin ? '<button class="btn btn-red" id="ai-bin">+ Bin</button>' : ''}
      <button class="btn" id="ai-reveal">Reveal ↗</button>
      <span class="ai-model">${esc(a.model)}</span>
    </div>`;
  body.querySelector('#ai-bin')?.addEventListener('click', () => {
    addToBin(node);
    closeAI();
  });
  body.querySelector('#ai-reveal')?.addEventListener('click', () => void reveal(node.path));
}

// ---------- BIN ----------
function beginDrag(node: TreeNode, e: PointerEvent) {
  startDrag(node, e, () => document.getElementById('bin'), addToBin);
}

function beginDragMany(nodes: TreeNode[], e: PointerEvent) {
  const total = nodes.reduce((s, n) => s + n.size, 0);
  const proxy: TreeNode = { name: `${nodes.length} items`, path: '', size: total, count: 0, type: 'dir' };
  startDrag(proxy, e, () => document.getElementById('bin'), () => {
    for (const n of nodes) addToBin(n, true);
    if (R) R.sel.clear();
    renderSelection();
  });
}

function addToBin(n: TreeNode, quiet = false) {
  if (!R || n.type === 'rest') return;
  for (const p of R.bin.keys()) {
    if (n.path === p || n.path.startsWith(p + '/')) {
      if (!quiet) toast('Already in the bin (or inside something that is).');
      return;
    }
  }
  // Adding a parent supersedes any of its children already collected.
  for (const p of [...R.bin.keys()]) if (p.startsWith(n.path + '/')) R.bin.delete(p);
  R.bin.set(n.path, n);
  R.confirming = false;
  renderBin(true);
}

function renderBin(pulse = false) {
  if (!R) return;
  const el = document.getElementById('bin')!;
  const items = [...R.bin.values()];
  const total = items.reduce((s, n) => s + n.size, 0);
  el.classList.toggle('bin-empty', items.length === 0);
  el.innerHTML = `
    <div class="bin-label">
      <div class="bin-title">The Bin</div>
      <div class="bin-count">${items.length ? `${items.length} item${items.length > 1 ? 's' : ''}` : 'Drag stuff here'}</div>
    </div>
    <div class="bin-items">
      ${
        items.length
          ? items
              .map(
                (n) => `
        <span class="bin-chip" title="${esc(n.path)}">
          <span class="bin-chip-name">${esc(n.name)}</span>
          <span class="bin-chip-size">${bytes(n.size)}</span>
          <button class="bin-x" data-remove="${esc(n.path)}" title="Remove">✕</button>
        </span>`,
              )
              .join('')
          : `<span class="bin-placeholder">Drop folders &amp; files from the rings or the list. Nothing is deleted until you confirm.</span>`
      }
    </div>
    <div class="bin-total">${bigBytes(total)}</div>
    <div class="bin-actions">
      ${
        R.confirming
          ? `<button class="btn btn-red btn-confirm" id="bin-go">Yes, move ${items.length} to Trash</button><button class="btn" id="bin-no">No</button>`
          : `<button class="btn btn-red" id="bin-trash" ${items.length ? '' : 'disabled'}>Move to Trash →</button>
             ${items.length ? '<button class="btn btn-sm" id="bin-clear">Clear</button>' : ''}`
      }
    </div>`;
  if (pulse) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }
  el.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      R?.bin.delete(b.dataset.remove!);
      if (R) R.confirming = false;
      renderBin();
    }),
  );
  el.querySelector('#bin-trash')?.addEventListener('click', () => {
    if (!R) return;
    R.confirming = true;
    renderBin();
  });
  el.querySelector('#bin-no')?.addEventListener('click', () => {
    if (!R) return;
    R.confirming = false;
    renderBin();
  });
  el.querySelector('#bin-clear')?.addEventListener('click', () => {
    if (!R) return;
    R.bin.clear();
    renderBin();
  });
  el.querySelector('#bin-go')?.addEventListener('click', () => void emptyBin());
}

async function emptyBin() {
  if (!R) return;
  const paths = [...R.bin.keys()];
  const btn = document.getElementById('bin-go') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Trashing…';
  }
  try {
    const { freed } = await api.trash(R.rootPath, paths);
    toast(`Moved to Trash. ${bytes(freed)} reclaimable once you empty it.`);
    R.bin.clear();
    R.confirming = false;
    // Land on the deepest folder that still exists.
    let target: string | null = R.tree.path;
    while (target && paths.some((p) => target === p || target!.startsWith(p + '/'))) target = parentPath(target);
    await navigate(target ?? R.rootPath, 'none');
  } catch (e) {
    toast((e as Error).message, 'err');
    R.confirming = false;
    renderBin();
  }
}

// ---------- boot ----------
(async () => {
  try {
    home = (await api.locations()).home;
    scans = await api.scans();
  } catch {
    /* fall through */
  }
  // Reopening the window: jump back to a running or finished scan if there is one.
  const target = scans.find((s) => s.status === 'scanning') ?? scans.find((s) => s.status === 'done');
  if (target) openScan(target.rootPath);
  else void showHome();
})();
