// "What is this?" — asks Claude to identify a file or folder and say whether
// it's safe to delete. Sends metadata only (name, ~-relative path, size,
// biggest children, Spotlight kind/where-from). Never sends file contents.
import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import os from 'node:os';

const MODEL = 'claude-opus-5-5';
const HOME = os.homedir();

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short human name for the item, e.g. "Python bytecode cache".' },
    what: { type: 'string', description: 'What it is, 1-2 sentences.' },
    createdBy: { type: 'string', description: 'The app, tool or system component that created it. "Unknown" if unclear.' },
    verdict: { type: 'string', enum: ['safe', 'caution', 'keep'] },
    why: { type: 'string', description: 'Why that verdict, 1-2 sentences. Mention if it regenerates automatically.' },
    howToReclaim: { type: 'string', description: 'Best way to reclaim the space, 1-2 sentences. Prefer the owning tool\'s own cleanup command or setting over deleting by hand.' },
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

Be specific to this item, not generic. If the metadata is ambiguous, say what it most likely is and choose caution. Keep each field to at most two short sentences.`;

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

const cache = new Map();

/**
 * @param {object} node serialized tree node (with up to one level of children)
 * @param {string|null} apiKey explicit key, or null to use env / `ant auth login` profile
 */
export async function explain(node, apiKey) {
  const key = `${node.path}|${node.size}`;
  if (cache.has(key)) return cache.get(key);

  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  const context = await describe(node);

  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // Server-side fallback: if a safety classifier declines, retry on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: context }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key. Check it in Settings.', { cause: e });
    if (e instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the Claude API. Try again in a moment.', { cause: e });
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API.', { cause: e });
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status ?? ''}: ${e.message}`, { cause: e });
    if (/api key|apiKey|authentication/i.test(String(e?.message))) throw new Error('No Claude API key. Add one in Settings.', { cause: e });
    throw e;
  }

  if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this one.');
  if (res.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try again.');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Empty answer from Claude.');
  const answer = { ...JSON.parse(text), model: res.model };
  cache.set(key, answer);
  return answer;
}
