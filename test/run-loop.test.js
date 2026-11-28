// The whole `tagteam run` loop against fake agents and a mock provider: launch flags and env,
// hooks, MCP, the handoff after each exit, the summarizer fallback order, and the chain.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, makeRepo, write, commit } from './helpers.js';
import * as store from '../src/store.js';
import { buildProfile, saveProfile, writeConfig, readConfig } from '../src/profiles.js';
import { run } from '../src/launcher.js';
import { mockProvider, REPLY } from './mock-provider.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const win = process.platform === 'win32';
const SECRET = 'sk-proj-FAKE1234567890abcdefghijklmnop';

let env0;
let ctx;

// Put fake `claude`, `codex` and `tagteam` first on PATH, the way npm would install them.
function fakeBin() {
  const dir = tmp('tagteam-bin-');
  const node = JSON.stringify(process.execPath);
  for (const agent of ['claude', 'codex']) {
    fs.writeFileSync(path.join(dir, `${agent}.js`), `require(${JSON.stringify(FAKE)});\n`);
    if (win) fs.writeFileSync(path.join(dir, `${agent}.cmd`), `@node "%dp0%\\${agent}.js" %*\r\n`);
    else fs.writeFileSync(path.join(dir, agent), `#!/bin/sh\nexec ${node} "${path.join(dir, `${agent}.js`)}" "$@"\n`, { mode: 0o755 });
  }
  if (win) fs.writeFileSync(path.join(dir, 'tagteam.cmd'), `@${node} "${CLI}" %*\r\n`);
  else fs.writeFileSync(path.join(dir, 'tagteam'), `#!/bin/sh\nexec ${node} "${CLI}" "$@"\n`, { mode: 0o755 });
  return dir;
}

beforeEach(() => {
  env0 = { ...process.env };
  const dir = tmp('tagteam-fake-');
  process.env.TAGTEAM_HOME = tmp('tagteam-home-');
  process.env.PATH = `${fakeBin()}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_LOG = path.join(dir, 'runs.jsonl');
  process.env.FAKE_DIR = dir;
  process.env.CODEX_HOME = path.join(dir, 'codex-home');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude-config'); // /handoff command goes here, not ~/.claude
  process.env.CLAUDECODE = '1'; // as if tagteam itself runs inside a Claude Code terminal
  process.env.TAGTEAM_SUMMARY_TIMEOUT_MS = '3000'; // generous for slow CI runners; only the 'hang' route waits for it
  const root = makeRepo();
  write(root, 'src/billing.js', 'export const prorate = (a, d) => d / a;\n');
  commit(root, 'billing');
  store.ensureProject(root);
  const lines = [];
  ctx = { root, lines, log: (l) => lines.push(l) };
});

afterEach(async () => {
  await ctx.mock?.close();
  for (const k of Object.keys(process.env)) if (!(k in env0)) delete process.env[k];
  Object.assign(process.env, env0);
});

const runs = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// ask() that accepts the next profile `times` times, then stops.
const askN = (times) => async (cfg, next) => (times-- > 0 ? next : null);

function profiles(mockUrl, extra = {}) {
  saveProfile('claude', buildProfile('claude'), null);
  const ds = buildProfile('ds', { preset: 'deepseek' });
  ds.api.baseUrl = `${mockUrl}/ds`;
  saveProfile('ds', ds, 'ds-test-key');
  const cx = buildProfile('cx', { agent: 'codex', baseUrl: `${mockUrl}/cx-agent` });
  cx.api = { format: 'openai', baseUrl: `${mockUrl}/cx`, model: 'm' };
  saveProfile('cx', cx, 'cx-test-key');
  for (const [name, p] of Object.entries(extra)) saveProfile(name, p, `${name}-key`);
}

test('claude: hooks and MCP from tagteam work; an agent-saved handoff needs no summarizer', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  process.env.FAKE_MODE = 'save';
  await run(ctx.root, { profile: 'claude', ask: askN(0), log: ctx.log });

  const [r] = runs();
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.hookErrors, []);
  assert.equal(r.env.CLAUDECODE, undefined, 'parent session marker must be stripped');
  assert.match(r.saved, /Saved handoff/);
  // The fake saves no test status, so the MCP answer tells the agent so while it can still fix it.
  assert.match(r.saved, /Gaps the next agent will hit:/);
  assert.match(r.saved, /- No test status/);
  const h = store.latestHandoff(ctx.root);
  assert.equal(h.source, 'agent');
  assert.equal(h.agent, 'fake-claude');
  assert.equal(h.next_action, 'next step after claude');
  assert.equal(ctx.mock.seen.length, 0);
  assert.ok(ctx.lines.some((l) => /the agent saved handoff/.test(l)));
});

test('chain: the next agent starts with the previous handoff; a silent exit gets a redacted summary', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  writeConfig({ ...readConfig(), chain: ['claude', 'ds'] });
  process.env.FAKE_MODE = 'save,silent';
  await run(ctx.root, { ask: askN(1), log: ctx.log });

  const [first, second] = runs();
  assert.equal(first.agent, 'claude');
  assert.equal(second.agent, 'claude');
  // DeepSeek profile: its own key and endpoint, not the parent session's.
  assert.equal(second.env.ANTHROPIC_AUTH_TOKEN, 'ds-test-key');
  assert.equal(second.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  // The SessionStart hook injected the first agent's handoff into the second agent.
  assert.match(second.context, /next step after claude/);

  // ds exited without saving: ds itself is the only summarizer with a key, so it writes the handoff.
  assert.equal(ctx.mock.seen.length, 1);
  const req = ctx.mock.seen[0];
  assert.equal(req.prefix, '/ds');
  assert.equal(req.headers.authorization, 'Bearer ds-test-key');
  assert.match(req.body, /swapped the division/);
  assert.match(req.body, /src\/billing\.js/);
  assert.ok(!req.body.includes(SECRET), 'transcript secrets must be redacted before sending');
  const h = store.latestHandoff(ctx.root);
  assert.equal(h.source, 'summary');
  assert.equal(h.next_action, REPLY.next_action);
});

test('summarizer fallback: a failing provider is skipped, the next one writes the handoff', async () => {
  ctx.mock = await mockProvider({ '/cx': [{ status: 500 }], '/sum': [{ status: 503 }], '/ds': ['ok'] });
  profiles(ctx.mock.url, { sum: { agent: 'none', api: { format: 'openai', baseUrl: `${ctx.mock.url}/sum`, model: 'm' } } });
  process.env.FAKE_MODE = 'limit';
  await run(ctx.root, { profile: 'ds', ask: askN(0), log: ctx.log });

  // Other chain profiles first, then summarizer-only ones; the agent that just stopped (maybe rate limited) goes last.
  assert.deepEqual(ctx.mock.seen.map((s) => s.prefix), ['/cx', '/sum', '/ds']);
  assert.ok(ctx.lines.some((l) => /sum failed \(Summarizer HTTP 503/.test(l)));
  assert.ok(ctx.lines.some((l) => /ds exited \(code 1\)/.test(l)));
  assert.equal(store.latestHandoff(ctx.root).source, 'summary');
});

test('every summarizer down (429, 401, garbage, hang): git state and the last messages are saved', async () => {
  ctx.mock = await mockProvider({ '/cx': [{ status: 429 }], '/a': [{ status: 401 }], '/b': ['garbage'], '/ds': ['hang'] });
  profiles(ctx.mock.url, {
    a: { agent: 'none', api: { format: 'openai', baseUrl: `${ctx.mock.url}/a`, model: 'm' } },
    b: { agent: 'none', api: { format: 'anthropic', baseUrl: `${ctx.mock.url}/b`, model: 'm' } },
  });
  process.env.FAKE_MODE = 'limit';
  await run(ctx.root, { profile: 'ds', ask: askN(0), log: ctx.log });

  // Order: other chain profiles with an API (cx), summarizer-only (a, b), then ds that just stopped.
  assert.deepEqual(ctx.mock.seen.map((s) => s.prefix), ['/cx', '/a', '/b', '/ds']);
  assert.equal(ctx.lines.filter((l) => / failed \(/.test(l)).length, 4);
  const h = store.latestHandoff(ctx.root);
  assert.equal(h.source, 'auto');
  assert.ok(h.git.dirty_files.includes('src/billing.js'));
  assert.ok(h.recent_user_messages.some((m) => /Fix the prorate bug/.test(m)));
  assert.ok(!JSON.stringify(h).includes(SECRET), 'saved handoffs are redacted too');
});

test('crash with --no-summary: nothing is sent, the git state is still saved', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  process.env.FAKE_MODE = 'crash';
  await run(ctx.root, { profile: 'ds', summary: false, ask: askN(0), log: ctx.log });

  assert.equal(ctx.mock.seen.length, 0);
  assert.ok(ctx.lines.some((l) => /ds exited \(code 3\)/.test(l)));
  const h = store.latestHandoff(ctx.root);
  assert.equal(h.source, 'auto');
  assert.deepEqual(h.git.dirty_files, ['src/billing.js']);
});

test('codex: provider and MCP flags work; the context and save instructions are in the prompt', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  saveProfile('claude', buildProfile('claude'), null);
  // A handoff from an earlier session, which codex must receive.
  store.saveHandoff(ctx.root, { id: '2026-01-01T00-00-00-000Z', created_at: new Date(0).toISOString(), source: 'agent', next_action: 'wire the gateway', git: null });
  process.env.FAKE_MODE = 'save';
  await run(ctx.root, { profile: 'cx', ask: askN(0), log: ctx.log });

  const [r] = runs();
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.env.TAGTEAM_PROVIDER_KEY, 'cx-test-key');
  assert.ok(r.args.includes(`model_providers.tagteam.base_url=${JSON.stringify(`${ctx.mock.url}/cx-agent`)}`));
  assert.match(r.context, /wire the gateway/);
  assert.match(r.context, /save_handoff/);
  const h = store.latestHandoff(ctx.root);
  assert.equal(h.agent, 'fake-codex');
  assert.equal(h.next_action, 'next step after codex');
});

test('codex silent exit: its rollout transcript feeds the summarizer', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  process.env.FAKE_MODE = 'silent';
  await run(ctx.root, { profile: 'cx', ask: askN(0), log: ctx.log });

  // Other chain profiles first (claude has no API, ds does), then cx itself last.
  assert.deepEqual(ctx.mock.seen.map((s) => s.prefix), ['/ds']);
  assert.match(ctx.mock.seen[0].body, /swapped the division/);
  assert.ok(!ctx.mock.seen[0].body.includes(SECRET));
  assert.equal(store.latestHandoff(ctx.root).source, 'summary');
});

// A Claude session that ends on the usage-limit message, as Claude Code writes it to the transcript.
function limitTranscript() {
  const f = path.join(process.env.FAKE_DIR, 'limit-transcript.json');
  fs.writeFileSync(f, JSON.stringify([
    { role: 'user', text: 'Fix the prorate bug in src/billing.js' },
    { role: 'assistant', text: 'Claude AI usage limit reached|1795000000' },
  ]));
  process.env.FAKE_TRANSCRIPT = f;
}

test('--auto-switch: a usage limit starts the next profile without asking, with the handoff', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  writeConfig({ ...readConfig(), chain: ['claude', 'ds'] });
  limitTranscript();
  process.env.FAKE_MODE = 'limit,save';
  let asked = 0;
  await run(ctx.root, { autoSwitch: true, ask: async () => (asked++, null), log: ctx.log });

  const [first, second] = runs();
  assert.equal(first.mode, 'limit');
  assert.equal(second.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic', 'second run is the ds profile');
  assert.ok(second.context.includes(REPLY.next_action), 'ds starts from the handoff');
  assert.ok(ctx.lines.some((l) => /claude stopped on a usage limit/.test(l)));
  assert.ok(ctx.lines.some((l) => /--auto-switch: continuing with ds/.test(l)));
  assert.equal(asked, 1, 'asked only after ds, which did not hit a limit');
});

test('--auto-switch: when every profile is limited it stops and asks instead of looping', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  writeConfig({ ...readConfig(), chain: ['claude', 'ds'] });
  limitTranscript();
  process.env.FAKE_MODE = 'limit';
  let asked = 0;
  await run(ctx.root, { autoSwitch: true, ask: async () => (asked++, null), log: ctx.log });
  assert.equal(runs().length, 2);
  assert.equal(asked, 1);
});

test('without --auto-switch a limit is reported but the user still chooses', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  writeConfig({ ...readConfig(), chain: ['claude', 'ds'] });
  limitTranscript();
  process.env.FAKE_MODE = 'limit';
  let asked = 0;
  await run(ctx.root, { ask: async () => (asked++, null), log: ctx.log });
  assert.equal(runs().length, 1);
  assert.equal(asked, 1);
  assert.ok(ctx.lines.some((l) => /claude stopped on a usage limit/.test(l)));
});

test('--auto-switch ignores an ordinary exit', async () => {
  ctx.mock = await mockProvider({});
  profiles(ctx.mock.url);
  writeConfig({ ...readConfig(), chain: ['claude', 'ds'] });
  process.env.FAKE_MODE = 'silent';
  let asked = 0;
  await run(ctx.root, { autoSwitch: true, ask: async () => (asked++, null), log: ctx.log });
  assert.equal(runs().length, 1);
  assert.equal(asked, 1);
});
