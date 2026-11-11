export interface TreeNode {
  name: string;
  path: string;
  size: number;
  count: number;
  type: 'dir' | 'file' | 'rest';
  hasKids?: boolean;
  /** Summarized folder (node_modules, .git, app bundles…): totaled, not itemized. */
  opaque?: boolean;
  err?: string;
  children?: TreeNode[];
}

export interface Settings {
  threads: number;
  memoryMb: number;
}

export interface Explanation {
  title: string;
  what: string;
  createdBy: string;
  verdict: 'safe' | 'caution' | 'keep';
  why: string;
  howToReclaim: string;
  model: string;
}

export interface SettingsInfo {
  apiKey: { hasKey: boolean; hint: string | null };
  settings: Settings;
  defaults: Settings;
  limits: { threads: [number, number]; memoryMb: [number, number] };
  cores: number;
  totalMemMb: number;
  usage: { nodes: number; maxNodes: number; heapUsed: number };
}

export interface Volume {
  name: string;
  path: string;
  total: number;
  free: number;
}

export interface Place {
  name: string;
  path: string;
}

export interface Progress {
  status: 'scanning' | 'done' | 'cancelled' | 'error';
  rootPath: string;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  truncated: boolean;
  current: string;
  elapsed: number;
  error: string | null;
  volume?: { total: number; free: number } | null;
}

type Reply<T> = { ok: true; result: T } | { ok: false; error: string };

declare global {
  interface Window {
    dirt?: { invoke(method: string, args?: unknown): Promise<Reply<unknown>>; platform: string };
  }
}

async function call<T>(method: string, args?: unknown): Promise<T> {
  if (!window.dirt) throw new Error('DIRT must run inside the desktop app (npm run dev).');
  const reply = (await window.dirt.invoke(method, args)) as Reply<T>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

export const api = {
  locations: () => call<{ volumes: Volume[]; places: Place[]; home: string }>('locations'),
  scan: (path: string) => call<Progress>('scan', { path }),
  scans: () => call<Progress[]>('scans'),
  getSettings: () => call<SettingsInfo>('getSettings'),
  setApiKey: (key: string) => call<{ hasKey: boolean; hint: string | null }>('setApiKey', { key }),
  explain: (root: string, path: string) => call<Explanation>('explain', { root, path }),
  setSettings: (s: Partial<Settings>) => call<Settings>('setSettings', s),
  status: (root: string) => call<Progress>('status', { root }),
  /** Stop a running scan and/or forget its results. */
  close: (root: string) => call<{ ok: true }>('close', { root }),
  tree: (root: string, path: string, depth = 6) => call<{ rootPath: string; tree: TreeNode }>('tree', { root, path, depth }),
  reveal: (root: string, path: string) => call<{ ok: true }>('reveal', { root, path }),
  trash: (root: string, paths: string[]) => call<{ ok: true; freed: number }>('trash', { root, paths }),
};
