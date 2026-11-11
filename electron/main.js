import { app, BrowserWindow, ipcMain, shell, utilityProcess, nativeTheme, Notification, clipboard } from 'electron';
import { explain, listModels, families, resolveModel, DEFAULT_MODEL } from './ai.js';
import { runAgent } from './agent.js';
import { listProjects, defaultRoots, removeWorktree, pruneWorktrees, analyzeRepo } from './git.js';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.DIRT_DEV_URL;
const HOME = os.homedir();

// ---------- settings ----------
const LIMITS = { threads: [1, 64], memoryMb: [64, 4096] };
const DEFAULTS = { threads: 16, memoryMb: 256, aiModel: DEFAULT_MODEL };
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const clampInt = (v, [lo, hi], fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function sanitize(s) {
  return {
    threads: clampInt(s?.threads, LIMITS.threads, settings.threads),
    memoryMb: clampInt(s?.memoryMb, LIMITS.memoryMb, settings.memoryMb),
    aiModel: typeof s?.aiModel === 'string' && /^@?[\w.\-/:]{3,100}$/.test(s.aiModel.trim()) ? s.aiModel.trim() : settings.aiModel,
  };
}

// ---------- OpenRouter API key ----------
// Stored in a file only your user can read (0600), like most CLI tools do.
// Not the Keychain: ad-hoc signed builds change identity on every update, which
// made macOS re-prompt for the Keychain password after each install.
const keyFile = () => path.join(app.getPath('userData'), 'openrouter-key');
const legacyKeyFile = () => path.join(app.getPath('userData'), 'openrouter-key.bin');

async function readApiKey() {
  // Dev/automation convenience: an env key wins over the stored one.
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    return (await fsp.readFile(keyFile(), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function writeApiKey(key) {
  await fsp.rm(legacyKeyFile(), { force: true });
  if (!key) {
    await fsp.rm(keyFile(), { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(keyFile()), { recursive: true });
  await fsp.writeFile(keyFile(), key, { mode: 0o600 });
  await fsp.chmod(keyFile(), 0o600);
}

async function loadSettings() {
  try {
    settings = sanitize(JSON.parse(await fsp.readFile(settingsFile(), 'utf8')));
  } catch {
    settings = { ...DEFAULTS };
  }
}

app.setName('DIRT');
// DIRT stores no cookies or passwords, so keep Chromium from touching the
// Keychain ("DIRT Safe Storage") at all.
app.commandLine.appendSwitch('use-mock-keychain');

// ---------- scan worker ----------
let worker = null;
let workerReady = null;
let nextId = 1;
const pending = new Map();

function startWorker() {
  // Heap ceiling leaves headroom above the largest allowed node budget.
  worker = utilityProcess.fork(path.join(HERE, 'scan-worker.js'), [], {
    serviceName: 'DIRT Scanner',
    // libuv defaults to 4 fs threads; size the pool for the max Threads setting.
    // The scanner's own limiter decides how many are actually used.
    env: { ...process.env, UV_THREADPOOL_SIZE: String(LIMITS.threads[1]) },
    execArgv: [`--max-old-space-size=${LIMITS.memoryMb[1] * 2}`],
  });
  workerReady = new Promise((resolve) => worker.once('spawn', resolve));
  worker.on('spawn', () => {
    ask('configure', { ...settings, cacheDir: path.join(app.getPath('userData'), 'scans') }).catch(() => {});
    // Low CPU priority so a big scan never starves the rest of the Mac.
    try {
      os.setPriority(worker.pid, 10);
    } catch {
      /* best effort */
    }
  });
  worker.on('message', ({ id, ok, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error));
  });
  worker.on('exit', () => {
    for (const p of pending.values()) p.reject(new Error('Scanner stopped'));
    pending.clear();
    worker = null;
  });
}

async function ask(method, args) {
  if (!worker) startWorker();
  await workerReady;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

// ---------- background scan watcher ----------
// Scans keep running with the window hidden or closed; this watches for the
// finish so we can show a notification and dock progress.
let watchTimer = null;

const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtTime = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function setDockProgress(on) {
  for (const w of BrowserWindow.getAllWindows()) w.setProgressBar(on ? 2 : -1); // >1 = indeterminate
}

const watching = new Set();

function watchScan(root) {
  watching.add(root);
  setDockProgress(true);
  if (watchTimer) return;
  watchTimer = setInterval(async () => {
    let list;
    try {
      list = await ask('list');
    } catch {
      return;
    }
    const byRoot = new Map(list.map((p) => [p.rootPath, p]));
    for (const root of [...watching]) {
      const p = byRoot.get(root);
      if (p && p.status === 'scanning') continue;
      watching.delete(root);
      if (p?.status === 'done') {
        ask('repos', { root }).then((r) => addProjects(r), () => {});
        if (!BrowserWindow.getFocusedWindow()) notifyDone(p);
      }
    }
    if (watching.size === 0) {
      clearInterval(watchTimer);
      watchTimer = null;
      setDockProgress(false);
    }
  }, 1000);
}

function notifyDone(p) {
  const where = p.rootPath === '/' ? 'Macintosh HD' : path.basename(p.rootPath);
  if (Notification.isSupported()) {
    const n = new Notification({ title: `Scan finished: ${where}`, body: `${fmtBytes(p.bytes)} mapped in ${fmtTime(p.elapsed)}.` });
    n.on('click', showWindow);
    n.show();
  }
  app.dock?.bounce('informational');
}

// ---------- filesystem helpers ----------
async function volumeInfo(p) {
  try {
    const s = await fsp.statfs(p);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

async function listVolumes() {
  const vols = [];
  const root = await volumeInfo('/');
  if (root) vols.push({ name: 'Macintosh HD', path: '/', ...root });
  try {
    for (const name of await fsp.readdir('/Volumes')) {
      const p = path.join('/Volumes', name);
      try {
        if ((await fsp.lstat(p)).isSymbolicLink()) continue; // link back to boot volume
      } catch {
        continue;
      }
      const info = await volumeInfo(p);
      if (info && info.total > 0) vols.push({ name, path: p, ...info });
    }
  } catch {
    /* no /Volumes */
  }
  return vols;
}

async function listPlaces() {
  const out = [];
  const add = async (name, p) => {
    try {
      if ((await fsp.stat(p)).isDirectory()) out.push({ name, path: p });
    } catch {
      /* missing */
    }
  };
  await add('Home', HOME);
  for (const c of ['Downloads', 'Documents', 'Desktop', 'Library', 'Movies', 'Pictures', 'Music']) await add(c, path.join(HOME, c));
  await add('Applications', '/Applications');
  return out;
}

const PROTECTED = new Set(['/', HOME, '/Users', '/Applications', '/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/etc', '/var']);
const isProtected = (p) => PROTECTED.has(p) || /^\/(System|usr|bin|sbin)\//.test(p);

// ---------- projects registry (repos found by scans + usual project folders) ----------
const projectsFile = () => path.join(app.getPath('userData'), 'projects.json');
let projectRepos = null;

async function loadProjects() {
  if (projectRepos) return projectRepos;
  try {
    projectRepos = new Set(JSON.parse(await fsp.readFile(projectsFile(), 'utf8')).repos || []);
  } catch {
    projectRepos = new Set();
  }
  return projectRepos;
}

async function addProjects(paths) {
  const set = await loadProjects();
  const before = set.size;
  for (const p of paths) set.add(p);
  if (set.size !== before) await fsp.writeFile(projectsFile(), JSON.stringify({ repos: [...set].sort() }, null, 2));
}

let projectsCache = { at: 0, data: null };

// ---------- IPC ----------
const conversations = new Map();

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

const api = {
  async locations() {
    return { volumes: await listVolumes(), places: await listPlaces(), home: HOME };
  },
  async scan({ path: target }) {
    if (typeof target !== 'string' || !target.trim()) throw new Error('Missing path');
    const abs = path.resolve(target.trim().replace(/^~(?=$|\/)/, HOME));
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new Error('Folder not found');
    }
    if (!st.isDirectory()) throw new Error('Not a folder');
    const res = await ask('scan', { path: abs });
    watchScan(res.rootPath);
    return res;
  },
  scans: () => ask('list'),
  /** First folder (alphabetically, case-insensitive) whose name starts with the last path segment. */
  async completePath({ partial }) {
    if (typeof partial !== 'string') return { name: null };
    const slash = partial.lastIndexOf('/');
    const prefix = partial.slice(slash + 1);
    if (slash < 0 || !prefix) return { name: null };
    const dir = path.resolve((partial.slice(0, slash) || '/').replace(/^~(?=$|\/)/, HOME));
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return { name: null };
    }
    const lower = prefix.toLowerCase();
    const hits = entries
      .filter((e) => e.name.toLowerCase().startsWith(lower) && (prefix.startsWith('.') || !e.name.startsWith('.')))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const e of hits) {
      if (e.isDirectory()) return { name: e.name };
      if (e.isSymbolicLink()) {
        const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
        if (st?.isDirectory()) return { name: e.name };
      }
    }
    return { name: null };
  },
  async explain({ root, path: p }) {
    // Pull the node from the scan itself (not from the renderer) with one level of children.
    const { tree } = await ask('tree', { root, path: p, depth: 1 });
    return explain(tree, { apiKey: await readApiKey(), model: settings.aiModel });
  },
  aiModels: () => listModels(),

  // ---------- git projects ----------
  async projects({ refresh } = {}) {
    if (!refresh && projectsCache.data && Date.now() - projectsCache.at < 5 * 60_000) return projectsCache.data;
    const roots = await defaultRoots();
    const known = [...(await loadProjects())];
    const fromRoots = await listProjects(roots, { sizes: true });
    const seen = new Set(fromRoots.map((r) => r.repo));
    const extra = [];
    for (const r of known) {
      if (seen.has(r)) continue;
      if (!(await fsp.stat(path.join(r, '.git')).then(() => true, () => false))) continue;
      extra.push(...(await listProjects([r], { sizes: true })).filter((x) => x.repo === r));
    }
    const repos = [...fromRoots, ...extra];
    await addProjects(repos.map((r) => r.repo));
    // Repo sizes from cached scans when available (cheap); otherwise unknown.
    const sizes = await ask('sizes', { paths: repos.map((r) => r.repo) }).catch(() => ({}));
    for (const r of repos) r.size = sizes[r.repo] ?? null;
    projectsCache = { at: Date.now(), data: { roots, repos } };
    return projectsCache.data;
  },
  async removeWorktree({ path: p }) {
    const r = await removeWorktree(p);
    projectsCache.at = 0;
    return r;
  },
  async pruneWorktrees({ repo }) {
    projectsCache.at = 0;
    return pruneWorktrees(repo);
  },
  async analyzeRepo({ repo }) {
    return analyzeRepo(repo, { apiKey: await readApiKey(), model: await resolveModel(settings.aiModel) });
  },
  copyText({ text }) {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  },
  async revealPath({ path: p }) {
    await fsp.lstat(p);
    shell.showItemInFolder(p);
    return { ok: true };
  },

  // ---------- Ask DIRT agent ----------
  async agentStart({ conversationId, query }) {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Empty question');
    let convo = conversations.get(conversationId);
    if (!convo) conversations.set(conversationId, (convo = { history: [], controller: null }));
    if (convo.controller) throw new Error('Still working on the last question');
    const controller = new AbortController();
    convo.controller = controller;
    const emit = (evt) => broadcast('dirt:agent', { conversationId, ...evt });
    (async () => {
      try {
        await runAgent({
          query: query.trim(),
          history: convo.history,
          apiKey: await readApiKey(),
          model: await resolveModel(settings.aiModel),
          ask,
          emit,
          signal: controller.signal,
        });
        emit({ type: 'done' });
      } catch (e) {
        emit({ type: 'error', message: e.message });
      } finally {
        convo.controller = null;
      }
    })();
    return { ok: true };
  },
  agentCancel({ conversationId }) {
    conversations.get(conversationId)?.controller?.abort();
    return { ok: true };
  },
  agentReset({ conversationId }) {
    conversations.get(conversationId)?.controller?.abort();
    conversations.delete(conversationId);
    return { ok: true };
  },

  /** Trash arbitrary paths (from an Ask results page). */
  async trashPaths({ paths }) {
    if (!Array.isArray(paths) || !paths.length) throw new Error('Nothing to trash');
    const done = [];
    const failed = [];
    for (const raw of paths) {
      const p = path.resolve(String(raw));
      if (isProtected(p) || p.split('/').length < 3) {
        failed.push({ path: p, error: 'protected path' });
        continue;
      }
      try {
        await fsp.lstat(p);
        await shell.trashItem(p);
        done.push(p);
      } catch (e) {
        failed.push({ path: p, error: e.message });
      }
    }
    await ask('remove', { root: null, paths: done }).catch(() => {});
    return { trashed: done, failed };
  },

  /** Diff a worktree against its repo's main/master since the branch point. */
  async worktreeDiff({ path: p }) {
    const git = (args, max = 4 * 1024 * 1024) =>
      new Promise((resolve) => execFile('git', ['-C', p, ...args], { maxBuffer: max, timeout: 30_000 }, (err, out) => resolve(err ? null : String(out))));
    const top = (await git(['rev-parse', '--show-toplevel']))?.trim();
    if (!top) throw new Error('Not a git checkout');
    const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
    const repoRoot = common && common.endsWith('/.git') ? path.dirname(common) : top;
    const branch = (await git(['branch', '--show-current']))?.trim() || '(detached)';
    let base = null;
    for (const b of ['main', 'master', 'origin/main', 'origin/master']) {
      if ((await git(['rev-parse', '--verify', '--quiet', b])) !== null) {
        base = b;
        break;
      }
    }
    if (!base) throw new Error('No main or master branch found');
    const mb = (await git(['merge-base', base, 'HEAD']))?.trim();
    const [stat, patch, untracked, ahead, behind] = await Promise.all([
      git(['diff', '--numstat', mb]),
      git(['diff', '--no-color', '--no-ext-diff', mb], 3 * 1024 * 1024),
      git(['ls-files', '--others', '--exclude-standard']),
      git(['rev-list', '--count', `${base}..HEAD`]),
      git(['rev-list', '--count', `HEAD..${base}`]),
    ]);
    const files = (stat || '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, d, f] = l.split('\t');
        return { file: f, added: a === '-' ? null : +a, removed: d === '-' ? null : +d };
      });
    return {
      worktree: p,
      repoRoot,
      branch,
      base,
      ahead: parseInt(ahead, 10) || 0,
      behind: parseInt(behind, 10) || 0,
      files,
      untracked: (untracked || '').split('\n').filter(Boolean).slice(0, 300),
      patch: patch === null ? null : patch.slice(0, 1_500_000),
      truncated: patch !== null && patch.length > 1_500_000,
    };
  },
  aiFamilies: () => families(),
  async setApiKey({ key }) {
    const k = typeof key === 'string' ? key.trim() : '';
    await writeApiKey(k);
    return { hasKey: !!k, hint: k ? k.slice(-4) : null };
  },
  async getSettings() {
    const key = await readApiKey();
    return { apiKey: { hasKey: !!key, hint: key ? key.slice(-4) : null }, settings, defaults: DEFAULTS, limits: LIMITS, cores: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576), usage: await ask('usage') };
  },
  async setSettings(next) {
    settings = sanitize({ ...settings, ...next });
    await ask('configure', settings);
    await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
    return settings;
  },
  async status({ root }) {
    const p = await ask('status', { root });
    return { ...p, volume: await volumeInfo(p.rootPath) };
  },
  close: ({ root }) => ask('close', { root }),
  tree: (args) => ask('tree', args),
  async reveal({ root, path: p }) {
    if (!(await ask('exists', { root, path: p }))) throw new Error('Not found');
    shell.showItemInFolder(p);
    return { ok: true };
  },
  async trash({ root, paths }) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('Nothing to trash');
    const abs = await ask('validate', { root, paths });
    for (const p of abs) if (isProtected(p)) throw new Error(`Protected path: ${p}`);
    const done = [];
    let failure = null;
    for (const p of abs) {
      try {
        await shell.trashItem(p);
        done.push(p);
      } catch (e) {
        failure = `${path.basename(p)}: ${e.message}`;
        break;
      }
    }
    const { freed } = await ask('remove', { root, paths: done });
    if (failure) throw new Error(`Trashed ${done.length} of ${abs.length}. Stopped at ${failure}`);
    return { ok: true, freed };
  },
};

ipcMain.handle('dirt', async (_e, method, args) => {
  const fn = Object.hasOwn(api, method) ? api[method] : null;
  if (!fn) return { ok: false, error: `Unknown method ${method}` };
  try {
    return { ok: true, result: await fn(args || {}) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- window ----------
function showWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else createWindow();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    title: 'DIRT',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 29 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11100e' : '#ece8df',
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (process.env.DIRT_SCREENSHOTS) {
      import('./screenshots.js').then(({ captureScreens }) => captureScreens(win, process.env.DIRT_SCREENSHOTS, app));
    }
    if (watchTimer) win.setProgressBar(2);
  });
  // Never navigate away from the app or open new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!DEV_URL || !url.startsWith(DEV_URL)) e.preventDefault();
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(HERE, '..', 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  await loadSettings();
  if (DEV_URL && app.dock) app.dock.setIcon(path.join(HERE, '..', 'build', 'icon.png'));
  startWorker();
  createWindow();
  app.on('activate', showWindow);
});

// Mac convention: closing the window keeps the app (and any scan) alive in the
// Dock. Cmd+Q quits for real.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  worker?.kill();
});
