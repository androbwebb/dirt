// "What is this?" — asks an LLM (via OpenRouter) to identify a file or folder and
// say whether it's safe to delete. Sends metadata only (name, ~-relative path,
// size, biggest children, Spotlight kind/where-from). Never sends file contents.
import { execFile } from 'node:child_process';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MODEL = '@deepseek-flash';
const FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * "@latest" style families: each resolves to the newest matching OpenRouter
 * model at request time (dated snapshots allowed; experimental/vision excluded).
 */
export const FAMILIES = [
  { alias: '@deepseek-flash', label: 'DeepSeek Flash', re: /^deepseek\/deepseek-v[\d.]+-flash(-\d{4})?$/ },
  { alias: '@deepseek-pro', label: 'DeepSeek Pro', re: /^deepseek\/deepseek-v[\d.]+-pro(-\d{4})?$/ },
  { alias: '@qwen-flash', label: 'Qwen Flash', re: /^qwen\/qwen[\d.]+-flash(-[\d-]+)?$/ },
  { alias: '@qwen-plus', label: 'Qwen Plus', re: /^qwen\/qwen[\d.]+-plus(-[\d-]+)?$/ },
  { alias: '@qwen-max', label: 'Qwen Max', re: /^qwen\/qwen[\d.]+-max(-\d+)?$/ },
];
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const HOME = os.homedir();

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short human name for the item, e.g. "Python bytecode cache".' },
    what: { type: 'string', description: 'What it is, 1-2 sentences.' },
    createdBy: { type: 'string', description: 'The app, tool or system component that created it. "Unknown" if unclear.' },
    verdict: { type: 'string', enum: ['safe', 'caution', 'keep'] },
    why: { type: 'string', description: 'Why that verdict, 1-2 sentences. Mention if it regenerates automatically.' },
    howToReclaim: { type: 'string', description: "Best way to reclaim the space, 1-2 sentences. Prefer the owning tool's own cleanup command or setting over deleting by hand." },
  },
  required: ['title', 'what', 'createdBy', 'verdict', 'why', 'howToReclaim'],
  additionalProperties: false,
};

const SYSTEM = `You identify files and folders on a Mac for a disk-space cleanup tool.
Given metadata about one item, explain what it is and whether deleting it is safe.

Verdicts:
- safe: caches, build artifacts, logs, installers, or anything that regenerates or is trivially re-downloadable.
- caution: deleting is recoverable but has a cost (re-download, re-index, lost settings, app must re-sync), or you are not confident what it is.
- keep: user data, system files, or anything whose loss is permanent or breaks software.

Git: if the metadata says the folder is a git WORKTREE, say so in the title. A worktree is an extra checkout: deleting it loses nothing that is committed and pushed/merged. Verdict: safe if merged or no unpushed commits and no uncommitted files; caution if it has uncommitted files or unpushed commits. Recommend \`git worktree remove\`.
Be specific to this item, not generic. If the metadata is ambiguous, say what it most likely is and choose caution. Keep each field to at most two short sentences.
Respond with a single JSON object with keys: title, what, createdBy, verdict ("safe" | "caution" | "keep"), why, howToReclaim.`;

const tilde = (s) => (s && HOME ? s.split(HOME).join('~') : s);

function run(cmd, args, ms = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

const fmt = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

/** Gather lightweight, content-free context about a path. */
async function describe(node) {
  const lines = [
    `Name: ${node.name}`,
    `Path: ${tilde(node.path)}`,
    `Type: ${node.type === 'file' ? 'file' : node.opaque ? 'folder/package (contents not itemized)' : 'folder'}`,
    `Size on disk: ${fmt(node.size)}`,
  ];
  if (node.count) lines.push(`Files inside: ${node.count.toLocaleString('en-US')}`);

  const md = await run('/usr/bin/mdls', ['-name', 'kMDItemKind', '-name', 'kMDItemContentType', '-name', 'kMDItemWhereFroms', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemCreator', node.path]);
  const mdClean = md
    .split('\n')
    .filter((l) => l.trim() && !l.includes('(null)'))
    .join('\n')
    .slice(0, 1500);
  if (mdClean) lines.push(`Spotlight metadata:\n${tilde(mdClean)}`);

  if (node.type === 'dir') {
    const g = await gitContext(node.path);
    if (g) lines.push(g);
  }

  if (node.type === 'file') {
    const f = (await run('/usr/bin/file', ['-b', node.path])).trim().slice(0, 200);
    if (f) lines.push(`file(1) says: ${f}`);
  }

  if (node.children?.length) {
    const kids = node.children
      .slice(0, 25)
      .map((c) => `  ${c.type === 'rest' ? c.name : c.name + (c.type === 'dir' ? '/' : '')}  ${fmt(c.size)}`)
      .join('\n');
    lines.push(`Largest contents:\n${kids}`);
  }
  return lines.join('\n');
}

/** Git facts (no contents): repo vs worktree, branch, uncommitted/unpushed, merged. */
async function gitContext(dir) {
  const st = await fsp.lstat(path.join(dir, '.git')).catch(() => null);
  if (!st) return null;
  const git = (args) => run('git', ['-C', dir, ...args], 8000).then((s) => s.trim());
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainRepo = common.endsWith('/.git') ? path.dirname(common) : common;
  const branch = (await git(['branch', '--show-current'])) || '(detached HEAD)';
  const status = (await git(['status', '--porcelain'])).split('\n').filter(Boolean).length;
  const unpushed = (await git(['log', 'HEAD', '--not', '--remotes', '--oneline'])).split('\n').filter(Boolean).length;
  const base = (await git(['rev-parse', '--verify', '--quiet', 'main'])) ? 'main' : (await git(['rev-parse', '--verify', '--quiet', 'master'])) ? 'master' : null;
  const isAncestor = (b) => new Promise((r) => execFile('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', b], { timeout: 8000 }, (err) => r(!err)));
  const mergedFlag = base ? ((await isAncestor(base)) ? 'yes' : 'no') : null;
  const last = await git(['log', '-1', '--format=%cr']);
  const worktrees = (await git(['worktree', 'list', '--porcelain'])).split('\n').filter((l) => l.startsWith('worktree ')).length;
  if (st.isFile()) {
    return [
      'Git: this folder is a GIT WORKTREE (an extra checkout of another repo, created with `git worktree add`).',
      `  Main repo: ${tilde(mainRepo)}`,
      `  Branch: ${branch}; last commit ${last || 'unknown'}`,
      `  Uncommitted files: ${status}; commits not pushed to any remote: ${unpushed}`,
      base ? `  Branch fully merged into ${base}: ${mergedFlag}` : '',
      'Worktrees are disposable once their work is committed and pushed/merged; remove them with `git worktree remove <path>` (the branch survives).',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Git: this folder is the MAIN checkout of a git repository${worktrees > 1 ? ` with ${worktrees - 1} extra worktree(s)` : ''}.`,
    `  Branch: ${branch}; last commit ${last || 'unknown'}`,
    `  Uncommitted files: ${status}; commits not pushed to any remote: ${unpushed}`,
  ].join('\n');
}

/** Pull the JSON object out of a reply, tolerating code fences or stray prose. */
function parseAnswer(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('The model did not return a readable answer. Try again or pick another model.');
  }
}

const cache = new Map();

/** Newest model in each family, from the live list. */
export async function families() {
  const list = await listModels();
  return FAMILIES.map(({ alias, label, re }) => {
    const newest = list.filter((m) => re.test(m.id)).sort((a, b) => b.created - a.created)[0];
    return { alias, label, model: newest || null };
  });
}

/** Turn a stored setting (alias or concrete id) into an OpenRouter model id. */
export async function resolveModel(setting) {
  if (!setting?.startsWith('@')) return setting || FALLBACK_MODEL;
  try {
    const fam = (await families()).find((f) => f.alias === setting);
    return fam?.model?.id || FALLBACK_MODEL;
  } catch {
    return FALLBACK_MODEL;
  }
}

// ---------- model list ----------
let modelCache = { at: 0, list: [] };

/**
 * OpenRouter's public model list, limited to models that can return structured
 * JSON, sorted cheapest first. Prices are USD per million tokens.
 */
export async function listModels() {
  if (Date.now() - modelCache.at < 60 * 60 * 1000 && modelCache.list.length) return modelCache.list;
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Could not load OpenRouter models (HTTP ${res.status})`);
  const { data } = await res.json();
  const list = data
    .filter((m) => !m.id.endsWith(':batch'))
    .filter((m) => (m.supported_parameters || []).some((p) => p === 'structured_outputs' || p === 'response_format'))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      priceIn: Number(m.pricing?.prompt || 0) * 1e6,
      priceOut: Number(m.pricing?.completion || 0) * 1e6,
      created: m.created || 0,
    }))
    .filter((m) => m.priceIn >= 0 && m.priceOut >= 0)
    .sort((a, b) => a.priceIn + a.priceOut * 0.25 - (b.priceIn + b.priceOut * 0.25) || a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), list };
  return list;
}

/**
 * @param {object} node serialized tree node (with up to one level of children)
 * @param {{ apiKey: string | null, model: string }} opts
 */
export async function explain(node, { apiKey, model }) {
  if (!apiKey) throw new Error('No OpenRouter API key. Add one in Settings.');
  model = await resolveModel(model);
  const key = `${model}|${node.path}|${node.size}`;
  if (cache.has(key)) return cache.get(key);

  const context = await describe(node);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'DIRT',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        reasoning: { effort: 'low' },
        response_format: { type: 'json_schema', json_schema: { name: 'explanation', strict: true, schema: SCHEMA } },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: context },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new Error('Could not reach OpenRouter.', { cause: e });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('OpenRouter rejected the API key. Check it in Settings.');
    if (res.status === 402) throw new Error('Your OpenRouter account is out of credits.');
    if (res.status === 429) throw new Error('Rate limited by OpenRouter. Try again in a moment.');
    throw new Error(`OpenRouter error: ${msg}`);
  }

  const choice = body.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(choice?.finish_reason === 'length' ? 'The answer was cut off. Try again.' : 'Empty answer from the model.');
  const answer = { ...parseAnswer(text), model: body.model || model };
  cache.set(key, answer);
  return answer;
}
