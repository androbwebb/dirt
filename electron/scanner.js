// Disk scanner: walks a directory tree on a single volume and builds an in-memory
// size tree. Designed to be gentle: low fs concurrency, small files folded into
// their parent, and a hard cap on tracked nodes so memory stays bounded.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_THREADS = 16;
export const DEFAULT_MEMORY_MB = 256;
// Rough cost of one tracked node (object + name string + array slot).
export const BYTES_PER_NODE = 170;
// Files under this size are folded into their directory's "small files" bucket.
const SMALL_FILE = 256 * 1024;
// Directories under this total size drop their child list once scanned.
const COLLAPSE_DIR = 1024 * 1024;
// Yield to the event loop every N directories so the UI/API stays responsive.
const YIELD_EVERY = 200;

// Folders that are "one thing" to a human: we total their size but don't
// build a per-file tree inside them. Saves lots of memory and CPU.
const OPAQUE_NAMES = new Set([
  // dev tooling
  'node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', '.turbo', '.parcel-cache', '.svelte-kit',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.gradle', 'Pods', '.pnpm-store', 'bower_components', '.terraform', '.yarn',
  // macOS volume bookkeeping
  '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100', '.TemporaryItems', '.Trashes', '.MobileBackups',
  // Chromium / Electron app internals (Chrome, Slack, Discord, VS Code, …)
  'Cache', 'Code Cache', 'GPUCache', 'Service Worker', 'IndexedDB', 'blob_storage', 'CacheStorage',
  'ShaderCache', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad',
]);
// Packages and document bundles Finder already shows as single items.
const OPAQUE_EXT = new RegExp(
  '\\.(' +
    [
      // apps & system extensions
      'app', 'bundle', 'framework', 'plugin', 'kext', 'appex', 'xpc', 'prefPane', 'saver', 'qlgenerator', 'mdimporter', 'wdgt',
      // media libraries
      'photoslibrary', 'photolibrary', 'migratedphotolibrary', 'aplibrary', 'musiclibrary', 'tvlibrary', 'imovielibrary',
      'fcpbundle', 'fcpcache', 'lrdata', 'lrlibrary', 'logicx', 'band', 'dvdmedia',
      // documents
      'pages', 'numbers', 'key', 'rtfd', 'mbox', 'scriptbundle',
      // audio plugins
      'component', 'vst', 'vst3', 'aaxplugin',
      // virtual machines & disk images
      'vmwarevm', 'pvm', 'utm', 'sparsebundle', 'pkg', 'mpkg',
      // developer bundles
      'git',
      'xcarchive', 'xcodeproj', 'xcworkspace', 'playground', 'dSYM', 'xcassets', 'docarchive', 'lproj', 'nib', 'storyboardc',
    ].join('|') +
    ')$',
  'i',
);
// Location-based: each iOS device backup is thousands of hash-named files.
const OPAQUE_PATHS = [/\/MobileSync\/Backup\/[^/]+$/];

export const isOpaque = (name, fullPath) =>
  OPAQUE_NAMES.has(name) || OPAQUE_EXT.test(name) || OPAQUE_PATHS.some((re) => re.test(fullPath));

export class Limiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  /** Change the limit live; raising it immediately starts queued work. */
  setLimit(n) {
    this.limit = n;
    while (this.active < this.limit && this.queue.length) this.queue.shift()();
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.limit) go();
      else this.queue.push(go);
    });
  }
}

class Cancelled extends Error {}

function makeNode(name, type, parent, size) {
  return {
    name,
    type, // 'dir' | 'file'
    size, // for dirs: own blocks until finalize(), then total
    count: type === 'file' ? 1 : 0,
    children: type === 'dir' ? [] : null,
    smallSize: 0,
    smallCount: 0,
    err: null,
    parent,
  };
}

const childPathOf = (parent, name) => (parent === '/' ? '/' + name : parent + '/' + name);

/**
 * Shared across concurrent scans so total filesystem pressure and memory stay
 * bounded no matter how many scans run at once.
 */
export function createShared() {
  return { limiter: new Limiter(DEFAULT_THREADS), nodes: 0, maxNodes: nodesFor(DEFAULT_MEMORY_MB) };
}

export const nodesFor = (mb) => Math.floor((mb * 1024 * 1024) / BYTES_PER_NODE);

export class Scan {
  constructor(rootPath, shared = createShared()) {
    this.shared = shared;
    this.rootPath = path.resolve(rootPath);
    this.status = 'scanning';
    this.files = 0;
    this.dirs = 0;
    this.bytes = 0;
    this.errors = 0;
    this.nodes = 0;
    this.truncated = false;
    this.current = this.rootPath;
    this.started = Date.now();
    this.finished = null;
    this.cancelled = false;
    this.error = null;
    this.root = null;
    this.limiter = shared.limiter;
    this.seenInodes = new Set();
    this.children = new Set();
    this.allowedDevs = new Set();
    this.skipPaths = new Set(['/dev', '/Volumes', '/System/Volumes', '/net', '/home', '/cores']);
    this.promise = this.#run();
  }

  cancel() {
    this.cancelled = true;
    for (const c of this.children) c.kill();
    this.children.clear();
  }

  /** Release this scan's share of the node budget. */
  dispose() {
    this.cancel();
    this.shared.nodes -= this.nodes;
    this.nodes = 0;
    this.root = null;
  }

  async #run() {
    try {
      const st = await fsp.lstat(this.rootPath);
      if (!st.isDirectory()) throw new Error('Not a directory');
      this.allowedDevs.add(st.dev);
      // On macOS, "/" is a sealed system volume; user data lives on the Data
      // volume reached via firmlinks. Allow both, skip the duplicate mount tree.
      if (this.rootPath === '/' && process.platform === 'darwin') {
        try {
          this.allowedDevs.add((await fsp.lstat('/System/Volumes/Data')).dev);
        } catch {
          /* not present */
        }
      }
      const name = this.rootPath === '/' ? 'Macintosh HD' : path.basename(this.rootPath);
      this.root = makeNode(name, 'dir', null, st.blocks * 512);
      await this.#walk(this.root, this.rootPath);
      this.status = 'done';
    } catch (e) {
      if (e instanceof Cancelled) {
        this.status = 'cancelled';
        this.root = null;
      } else {
        this.status = 'error';
        this.error = e.message;
      }
    } finally {
      this.finished = Date.now();
      this.seenInodes = null;
    }
  }

  async #walk(node, full) {
    if (this.cancelled) throw new Cancelled();
    if (this.shared.nodes >= this.shared.maxNodes) {
      // Over budget: keep totals accurate, just stop itemizing.
      this.truncated = true;
      const t = await this.#measure(full);
      node.smallSize += t.size;
      node.smallCount += t.count;
      finalize(node);
      return;
    }
    let entries;
    try {
      entries = await this.limiter.run(() => fsp.readdir(full, { withFileTypes: true }));
    } catch (e) {
      node.err = e.code || 'ERR';
      this.errors++;
      return;
    }
    this.dirs++;
    this.current = full;
    if (this.dirs % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));

    const subdirs = [];
    const opaque = [];
    await Promise.all(
      entries.map(async (ent) => {
        const childPath = childPathOf(full, ent.name);
        if (this.skipPaths.has(childPath)) return;
        let st;
        try {
          st = await this.limiter.run(() => fsp.lstat(childPath));
        } catch {
          this.errors++;
          return;
        }
        if (this.cancelled) return;
        const size = st.blocks * 512;
        if (st.isDirectory()) {
          if (!this.allowedDevs.has(st.dev)) return; // another volume
          const child = makeNode(ent.name, 'dir', node, size);
          this.nodes++;
          this.shared.nodes++;
          this.bytes += size;
          node.children.push(child);
          if (isOpaque(ent.name, childPath)) {
            child.opaque = true;
            opaque.push([child, childPath]);
          } else subdirs.push([child, childPath]);
          return;
        }
        // Count hard-linked files once.
        if (st.nlink > 1) {
          const key = st.dev + ':' + st.ino;
          if (this.seenInodes.has(key)) return;
          this.seenInodes.add(key);
        }
        this.files++;
        this.bytes += size;
        if (size < SMALL_FILE) {
          node.smallSize += size;
          node.smallCount++;
        } else {
          node.children.push(makeNode(ent.name, 'file', node, size));
          this.nodes++;
          this.shared.nodes++;
        }
      }),
    );
    if (this.cancelled) throw new Cancelled();
    // Walk subdirectories sequentially-ish via the shared limiter.
    await Promise.all([
      ...subdirs.map(([child, p]) => this.#walk(child, p)),
      ...opaque.map(async ([child, p]) => {
        const t = await this.#measure(p);
        // du's total already includes the folder's own blocks.
        child.smallSize = t.size;
        child.smallCount = t.count;
        child.size = t.size;
        child.count = t.count;
      }),
    ]);
    finalize(node);
  }

  /**
   * Total a folder (including its own blocks) without itemizing it. Uses the
   * native `du`, which is far faster than stat-ing each file from JS. Falls
   * back to a JS walk if du fails. File count is unknown (0) via du.
   */
  async #measure(full) {
    if (this.cancelled) throw new Cancelled();
    this.current = full;
    const kb = await this.limiter.run(() => this.#du(full));
    if (this.cancelled) throw new Cancelled();
    if (kb !== null) {
      this.bytes += kb * 1024;
      return { size: kb * 1024, count: 0 };
    }
    const t = { size: 0, count: 0 };
    try {
      const st = await fsp.lstat(full);
      t.size = st.blocks * 512;
    } catch {
      /* ignore */
    }
    await this.#sizeOnly(full, t);
    return t;
  }

  #du(full) {
    return new Promise((resolve) => {
      // -s total, -k KiB, -x stay on this volume. Permission errors still yield a total.
      const child = spawn('/usr/bin/du', ['-skx', full], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.children.add(child);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve(null));
      child.on('close', () => {
        this.children.delete(child);
        const kb = parseInt(out, 10);
        resolve(Number.isFinite(kb) && !this.cancelled ? kb : null);
      });
    });
  }

  /** Total a folder's contents without allocating tree nodes. */
  async #sizeOnly(full, total) {
    if (this.cancelled) throw new Cancelled();
    let entries;
    try {
      entries = await this.limiter.run(() => fsp.readdir(full, { withFileTypes: true }));
    } catch {
      this.errors++;
      return;
    }
    this.dirs++;
    this.current = full;
    if (this.dirs % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    const subdirs = [];
    await Promise.all(
      entries.map(async (ent) => {
        const childPath = full + '/' + ent.name;
        let st;
        try {
          st = await this.limiter.run(() => fsp.lstat(childPath));
        } catch {
          this.errors++;
          return;
        }
        const size = st.blocks * 512;
        if (st.isDirectory()) {
          if (!this.allowedDevs.has(st.dev)) return;
          total.size += size;
          this.bytes += size;
          subdirs.push(childPath);
          return;
        }
        if (st.nlink > 1) {
          const key = st.dev + ':' + st.ino;
          if (this.seenInodes.has(key)) return;
          this.seenInodes.add(key);
        }
        this.files++;
        this.bytes += size;
        total.size += size;
        total.count++;
      }),
    );
    if (this.cancelled) throw new Cancelled();
    await Promise.all(subdirs.map((p) => this.#sizeOnly(p, total)));
  }

  find(target) {
    if (!this.root) return null;
    const abs = path.resolve(target);
    if (abs === this.rootPath) return this.root;
    const rel = path.relative(this.rootPath, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    let node = this.root;
    for (const part of rel.split(path.sep)) {
      if (!node.children) return null;
      node = node.children.find((c) => c.name === part);
      if (!node) return null;
    }
    return node;
  }

  pathOf(node) {
    const parts = [];
    for (let n = node; n && n.parent; n = n.parent) parts.unshift(n.name);
    return parts.length ? path.join(this.rootPath, ...parts) : this.rootPath;
  }

  /** Remove a node and subtract its size from every ancestor. */
  remove(node) {
    const parent = node.parent;
    if (!parent) return;
    parent.children = parent.children.filter((c) => c !== node);
    for (let a = parent; a; a = a.parent) {
      a.size -= node.size;
      a.count -= node.count;
    }
    this.bytes -= node.size;
  }

  /** Serialize a subtree for the client, pruning slivers into "smaller items". */
  serialize(node, depth) {
    const minSize = Math.max(node.size * 0.002, 1);
    const toJSON = (n, d, p) => {
      const out = { name: n.name, path: p, size: n.size, count: n.count, type: n.type };
      if (n.err) out.err = n.err;
      if (n.type !== 'dir') return out;
      if (n.opaque) {
        out.opaque = true;
        out.hasKids = false;
        return out;
      }
      const kids = n.children || [];
      out.hasKids = kids.length > 0 || n.smallCount > 0;
      if (d >= depth) return out;
      const children = [];
      let restSize = n.smallSize;
      let restCount = n.smallCount;
      for (const c of kids) {
        if (c.size >= minSize) children.push(toJSON(c, d + 1, childPathOf(p, c.name)));
        else {
          restSize += c.size;
          restCount += c.type === 'dir' ? Math.max(c.count, 1) : 1;
        }
      }
      if (restSize > 0) {
        children.push({
          name: `${restCount.toLocaleString('en-US')} smaller items`,
          path: p + '/\u0000rest',
          size: restSize,
          count: restCount,
          type: 'rest',
        });
      }
      out.children = children;
      return out;
    };
    return toJSON(node, 0, this.pathOf(node));
  }

  progress() {
    return {
      status: this.status,
      rootPath: this.rootPath,
      files: this.files,
      dirs: this.dirs,
      bytes: this.bytes,
      errors: this.errors,
      truncated: this.truncated,
      current: this.current,
      elapsed: (this.finished || Date.now()) - this.started,
      error: this.error,
    };
  }
}

/** Roll child sizes up into a directory once all its descendants are walked. */
function finalize(node) {
  if (node.opaque) return;
  let size = node.size + node.smallSize; // own blocks + small files
  let count = node.smallCount;
  for (const c of node.children) {
    size += c.size;
    count += c.count;
  }
  node.size = size;
  node.count = count;
  node.children.sort((a, b) => b.size - a.size);
  // Tiny directories don't need a browsable child list.
  if (size < COLLAPSE_DIR && node.parent) {
    node.children = [];
    node.smallSize = size;
    node.smallCount = count;
  }
}
