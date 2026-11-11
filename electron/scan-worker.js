// Runs in an Electron utilityProcess so heavy filesystem walking never blocks
// the window. Holds every scan's tree and answers queries from the main process.
import path from 'node:path';
import { Scan, createShared, nodesFor } from './scanner.js';

const shared = createShared();
/** rootPath → Scan */
const scans = new Map();

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

const handlers = {
  configure({ threads, memoryMb }) {
    if (threads) shared.limiter.setLimit(threads);
    if (memoryMb) shared.maxNodes = nodesFor(memoryMb);
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
    return scan.progress();
  },
  list() {
    return [...scans.values()].map((s) => s.progress());
  },
  status({ root }) {
    return get(root).progress();
  },
  /** Stop (if running) and forget a scan. */
  close({ root }) {
    scans.get(root)?.dispose();
    scans.delete(root);
    return { ok: true };
  },
  tree({ root, path: target, depth }) {
    const scan = done(root);
    const node = scan.find(target || scan.rootPath);
    if (!node) throw new Error('Not found');
    const d = Math.min(Math.max(Number(depth) || 6, 1), 10);
    return { rootPath: scan.rootPath, tree: scan.serialize(node, d) };
  },
  /** Confirm paths belong to this scan and are not the scan root. */
  validate({ root, paths }) {
    const scan = done(root);
    return paths.map((p) => {
      const abs = path.resolve(String(p));
      const node = scan.find(abs);
      if (!node || !node.parent) throw new Error(`Not removable: ${abs}`);
      return abs;
    });
  },
  /** Drop trashed items from every scan that contains them; returns bytes freed. */
  remove({ root, paths }) {
    let freed = 0;
    for (const scan of scans.values()) {
      if (scan.status !== 'done') continue;
      for (const p of paths) {
        const node = scan.find(p);
        if (node && node.parent) {
          if (scan.rootPath === root) freed += node.size;
          scan.remove(node);
        }
      }
    }
    return { freed };
  },
  exists({ root, path: p }) {
    return !!scans.get(root)?.find(p);
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
