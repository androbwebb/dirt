// Runs in an Electron utilityProcess so heavy filesystem walking never blocks
// the window. Holds every scan's tree and answers queries from the main process.
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { Scan, createShared, nodesFor } from './scanner.js';

const shared = createShared();
/** rootPath → Scan */
const scans = new Map();

// ---------- disk cache: finished scans survive restarts for a day ----------
const CACHE_TTL = 24 * 60 * 60 * 1000;
let cacheDir = null;
const fileFor = (root) => path.join(cacheDir, crypto.createHash('sha1').update(root).digest('hex').slice(0, 16));
const expired = (scan) => scan.status === 'done' && scan.finished && Date.now() - scan.finished > CACHE_TTL;

async function persist(scan) {
  if (!cacheDir || scan.status !== 'done' || !scan.root) return;
  try {
    const base = fileFor(scan.rootPath);
    await scan.save(base + '.json.gz');
    await fsp.writeFile(base + '.meta.json', JSON.stringify(scan.meta()));
  } catch {
    /* cache is best effort */
  }
}

async function forget(root) {
  if (!cacheDir) return;
  const base = fileFor(root);
  await Promise.all([fsp.rm(base + '.json.gz', { force: true }), fsp.rm(base + '.meta.json', { force: true })]);
}

/** Recreate finished scans from disk (trees load lazily on first use). */
async function restoreAll() {
  await fsp.mkdir(cacheDir, { recursive: true });
  for (const f of await fsp.readdir(cacheDir)) {
    if (!f.endsWith('.meta.json')) continue;
    const base = path.join(cacheDir, f.slice(0, -'.meta.json'.length));
    try {
      const meta = JSON.parse(await fsp.readFile(base + '.meta.json', 'utf8'));
      if (!meta.finished || Date.now() - meta.finished > CACHE_TTL || scans.has(meta.rootPath)) {
        if (!scans.has(meta.rootPath)) await forget(meta.rootPath);
        continue;
      }
      scans.set(meta.rootPath, new Scan(meta.rootPath, shared, { meta, file: base + '.json.gz' }));
    } catch {
      await fsp.rm(base + '.meta.json', { force: true });
    }
  }
}

/** Debounced re-save after trashing items. */
const saveTimers = new Map();
function persistSoon(scan) {
  clearTimeout(saveTimers.get(scan.rootPath));
  saveTimers.set(scan.rootPath, setTimeout(() => persist(scan), 2000));
}

/** Drop scans older than a day. */
function sweep() {
  for (const [root, scan] of scans) {
    if (expired(scan)) {
      scan.dispose();
      scans.delete(root);
      void forget(root);
    }
  }
}

function get(root) {
  const scan = scans.get(root);
  if (!scan) throw new Error('No such scan');
  return scan;
}

function done(root) {
  const scan = get(root);
  if (scan.status !== 'done') throw new Error('Scan not finished');
  return scan;
}

/** The finished scan with the deepest root containing path p. */
function coveringScan(p) {
  let best = null;
  for (const s of scans.values()) {
    if (s.status !== 'done') continue;
    const r = s.rootPath;
    if ((p === r || p.startsWith(r === '/' ? '/' : r + '/')) && (!best || r.length > best.rootPath.length)) best = s;
  }
  return best;
}

const handlers = {
  async configure({ threads, memoryMb, cacheDir: dir }) {
    if (threads) shared.limiter.setLimit(threads);
    if (memoryMb) shared.maxNodes = nodesFor(memoryMb);
    if (dir && !cacheDir) {
      cacheDir = dir;
      await restoreAll();
    }
    return { ok: true };
  },
  usage() {
    return { nodes: shared.nodes, maxNodes: shared.maxNodes, heapUsed: process.memoryUsage().heapUsed };
  },
  scan({ path: target }) {
    const existing = scans.get(target);
    if (existing && existing.status === 'scanning') return existing.progress();
    existing?.dispose();
    const scan = new Scan(target, shared);
    scans.set(scan.rootPath, scan);
    scan.promise.then(() => persist(scan));
    return scan.progress();
  },
  list() {
    sweep();
    return [...scans.values()].map((s) => s.progress());
  },
  status({ root }) {
    return get(root).progress();
  },
  /** Stop (if running) and forget a scan. */
  async close({ root }) {
    scans.get(root)?.dispose();
    scans.delete(root);
    await forget(root);
    return { ok: true };
  },
  async tree({ root, path: target, depth }) {
    const scan = done(root);
    await scan.ensureLoaded();
    const node = scan.find(target || scan.rootPath);
    if (!node) throw new Error('Not found');
    const d = Math.min(Math.max(Number(depth) || 6, 1), 10);
    return { rootPath: scan.rootPath, tree: scan.serialize(node, d) };
  },
  /** Confirm paths belong to this scan and are not the scan root. */
  async validate({ root, paths }) {
    const scan = done(root);
    await scan.ensureLoaded();
    return paths.map((p) => {
      const abs = path.resolve(String(p));
      const node = scan.find(abs);
      if (!node || !node.parent) throw new Error(`Not removable: ${abs}`);
      return abs;
    });
  },
  /** Drop trashed items from every scan that contains them; returns bytes freed. */
  async remove({ root, paths }) {
    let freed = 0;
    for (const scan of scans.values()) {
      if (scan.status !== 'done') continue;
      // Only touch trees already in memory, plus the one being acted on.
      if (!scan.root && scan.rootPath !== root) continue;
      await scan.ensureLoaded();
      let changed = false;
      for (const p of paths) {
        const node = scan.find(p);
        if (node && node.parent) {
          if (scan.rootPath === root) freed += node.size;
          scan.remove(node);
          changed = true;
        }
      }
      if (changed) persistSoon(scan);
    }
    return { freed };
  },
  /** Biggest leaf items (files, packages, summarized/collapsed folders) under a path. */
  async largest({ path: p, limit = 30 }) {
    const scan = coveringScan(p);
    if (!scan) return null;
    await scan.ensureLoaded();
    const start = scan.find(p);
    if (!start) return null;
    const top = [];
    const consider = (n) => {
      if (top.length >= limit && n.size <= top[top.length - 1].size) return;
      top.push(n);
      top.sort((a, b) => b.size - a.size);
      if (top.length > limit) top.pop();
    };
    const walk = (n) => {
      const leaf = n.type === 'file' || n.opaque || !n.children || n.children.length === 0;
      if (leaf) return consider(n);
      if (n.smallSize > 0 && n !== start) consider({ ...n, smallOnly: true, size: n.smallSize });
      for (const c of n.children) walk(c);
    };
    walk(start);
    return {
      root: scan.rootPath,
      items: top.map((n) => ({
        path: scan.pathOf(n.smallOnly ? n : n) + (n.smallOnly ? ' (small files)' : ''),
        size: n.size,
        kind: n.type === 'file' ? 'file' : n.opaque ? 'package/summarized' : 'folder',
      })),
    };
  },
  /** Repo roots discovered by a scan's walk. */
  repos({ root }) {
    return [...(scans.get(root)?.repos ?? [])];
  },
  /** Sizes for paths covered by any finished scan: { path: bytes }. */
  async sizes({ paths }) {
    const out = {};
    for (const p of paths) {
      const scan = coveringScan(p);
      if (!scan) continue;
      await scan.ensureLoaded();
      const n = scan.find(p);
      if (n) out[p] = n.size;
    }
    return out;
  },
  async exists({ root, path: p }) {
    const scan = scans.get(root);
    await scan?.ensureLoaded();
    return !!scan?.find(p);
  },
};

process.parentPort.on('message', async ({ data }) => {
  const { id, method, args } = data;
  try {
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown method ${method}`);
    process.parentPort.postMessage({ id, ok: true, result: await fn(args || {}) });
  } catch (e) {
    process.parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
