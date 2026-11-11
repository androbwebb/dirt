import { app, BrowserWindow, ipcMain, shell, utilityProcess, nativeTheme, Notification, safeStorage } from 'electron';
import { explain } from './ai.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.DIRT_DEV_URL;
const HOME = os.homedir();

// ---------- settings ----------
const LIMITS = { threads: [1, 64], memoryMb: [64, 4096] };
const DEFAULTS = { threads: 16, memoryMb: 256 };
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
  };
}

// ---------- Claude API key (encrypted with the macOS Keychain) ----------
const keyFile = () => path.join(app.getPath('userData'), 'anthropic-key.bin');

async function readApiKey() {
  try {
    return safeStorage.decryptString(await fsp.readFile(keyFile()));
  } catch {
    return null;
  }
}

async function writeApiKey(key) {
  if (!key) {
    await fsp.rm(keyFile(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable');
  await fsp.mkdir(path.dirname(keyFile()), { recursive: true });
  await fsp.writeFile(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
}

async function loadSettings() {
  try {
    settings = sanitize(JSON.parse(await fsp.readFile(settingsFile(), 'utf8')));
  } catch {
    settings = { ...DEFAULTS };
  }
}

app.setName('DIRT');

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
    ask('configure', settings).catch(() => {});
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
      if (p?.status === 'done' && !BrowserWindow.getFocusedWindow()) notifyDone(p);
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

// ---------- IPC ----------
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
  async explain({ root, path: p }) {
    // Pull the node from the scan itself (not from the renderer) with one level of children.
    const { tree } = await ask('tree', { root, path: p, depth: 1 });
    return explain(tree, await readApiKey());
  },
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
