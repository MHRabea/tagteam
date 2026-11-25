import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tmp, makeRepo, write } from './helpers.js';
import * as store from '../src/store.js';
import { capture } from '../src/handoff.js';
import { buildProfile, saveProfile, readConfig, encryptKey, decryptKey, setChain, keyBackend } from '../src/profiles.js';
import { buildLaunch, resolveCommand, ensureHandoff, summarizerOrder, agentSavedSince, nextInChain } from '../src/launcher.js';
import { summarize, extractJson } from '../src/summarize.js';
import { readTranscript } from '../src/transcript.js';

const REPLY = { task: { title: 'Fix prorate' }, completed: ['found bug'], next_action: 'Swap the division in prorate()', tests: { result: 'fail', command: '' }, decisions: [{ decision: '' }] };

// Fake OpenAI- and Anthropic-style endpoint that returns REPLY and records the request.
function fakeApi() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const text = '```json\n' + JSON.stringify(REPLY) + '\n```';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url.endsWith('/v1/messages') ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('presets and validation', () => {
  assert.equal(buildProfile('deepseek').env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(buildProfile('work', { preset: 'openai', model: 'gpt-x' }).model, 'gpt-x');
  const custom = buildProfile('router', { agent: 'claude', baseUrl: 'https://openrouter.ai/api' });
  assert.equal(custom.keyEnv, 'ANTHROPIC_AUTH_TOKEN');
  assert.throws(() => buildProfile('x y'), /Invalid profile name/);
  assert.throws(() => buildProfile('nobody'), /--agent/);
  assert.throws(() => buildProfile('c', { agent: 'custom' }), /--command/);
});

test('keys are encrypted at rest and round-trip', { skip: keyBackend() !== 'dpapi' && 'DPAPI is the key store on Windows only' }, () => {
  const enc = encryptKey('sk-test-123');
  assert.match(enc, /^dpapi:/);
  assert.doesNotMatch(enc, /sk-test/);
  assert.equal(decryptKey(enc), 'sk-test-123');
});

test('summarizer calls OpenAI and Anthropic formats and normalises the reply', async () => {
  const { server, seen, url } = await fakeApi();
  const root = makeRepo();
  write(root, 'a.txt', 'API_KEY=hunter2\n');
  try {
    const transcript = [{ role: 'user', text: 'fix prorate, my token is sk-ant-abcdefghijklmnopqrstuvwxyz' }];
    const a = await summarize({ api: { format: 'openai', baseUrl: url, model: 'm' }, key: 'k1', root, transcript });
    assert.equal(a.next_action, REPLY.next_action);
    assert.equal(a.tests.command, undefined);
    assert.deepEqual(a.decisions, []);
    await summarize({ api: { format: 'anthropic', baseUrl: url, model: 'm' }, key: 'k2', root, transcript });
    assert.equal(seen[0].url, '/chat/completions');
    assert.equal(seen[0].headers.authorization, 'Bearer k1');
    assert.equal(seen[1].url, '/v1/messages');
    assert.equal(seen[1].headers['x-api-key'], 'k2');
    const sent = JSON.stringify(seen.map((s) => s.body));
    assert.doesNotMatch(sent, /hunter2|sk-ant-abc/); // redacted before leaving the machine
  } finally {
    server.close();
  }
});

test('extractJson tolerates prose and fences', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson('nothing'), /no JSON/);
});

test('reads Codex rollout transcripts', () => {
  const f = path.join(tmp('tagteam-cx-'), 'rollout.jsonl');
  const lines = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do step 2' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(readTranscript(f), [{ role: 'user', text: 'do step 2' }, { role: 'assistant', text: 'done' }]);
});

test('Windows .cmd shims resolve to node + js entry', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const dir = tmp('tagteam-bin-');
  fs.writeFileSync(path.join(dir, 'fakeagent.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe")\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\bin\\agent.js" %*\r\n');
  const old = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${old}`;
  try {
    const r = resolveCommand('fakeagent');
    assert.equal(r.cmd, process.execPath);
    assert.deepEqual(r.pre, [path.join(dir, 'node_modules', 'fake', 'bin', 'agent.js')]);
    fs.writeFileSync(path.join(dir, 'nativeagent.cmd'), '"%dp0%\\node_modules\\@x\\agent\\bin\\agent.exe"   %*');
    assert.deepEqual(resolveCommand('nativeagent'), { cmd: path.join(dir, 'node_modules', '@x', 'agent', 'bin', 'agent.exe'), pre: [] });
    assert.throws(() => resolveCommand('missing-agent'), /not installed/);
  } finally {
    process.env.PATH = old;
  }
});

test('codex launch passes provider, key env, MCP server and context prompt', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const dir = tmp('tagteam-bin-');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  const old = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${old}`;
  try {
    const root = makeRepo();
    store.ensureProject(root);
    capture(root, { source: 'agent', fields: { task: { title: 'Billing', acceptance: [] }, completed: [], in_progress: [], next_action: 'Add retry', known_issues: [], decisions: [], constraints: [] } });
    const spec = buildLaunch(buildProfile('openai', { model: 'gpt-x' }), root, 'sk-secret');
    const args = spec.args.join(' ');
    assert.match(args, /model_provider="tagteam"/);
    assert.match(args, /model_providers\.tagteam\.base_url="https:\/\/api\.openai\.com\/v1"/);
    assert.match(args, /mcp_servers\.tagteam\.env=\{TAGTEAM_ROOT=/);
    assert.match(args, /-m gpt-x/);
    assert.match(spec.args.at(-1), /Next action\nAdd retry[\s\S]*save_handoff/);
    assert.equal(spec.env.TAGTEAM_PROVIDER_KEY, 'sk-secret');
    assert.doesNotMatch(args, /sk-secret/); // key only in env, never argv
  } finally {
    process.env.PATH = old;
  }
});

test('handoff on exit: agent save wins, else summary from another profile, else git state', async () => {
  const { server, url } = await fakeApi();
  try {
    const root = makeRepo();
    store.ensureProject(root);
    const p = { agent: 'claude' };
    const quiet = () => {};

    // agent saved during the run
    let started = Date.now();
    const agentH = capture(root, { source: 'agent', fields: { task: { title: 'T', acceptance: [] }, completed: [], in_progress: [], next_action: 'n', known_issues: [], decisions: [], constraints: [] } });
    capture(root, { source: 'auto', reason: 'session_end' });
    assert.ok(agentSavedSince(store.latestHandoff(root), started));
    const kept = await ensureHandoff(root, { name: 'claude', p, started, summary: true, cfg: { profiles: {}, chain: [] }, log: quiet });
    assert.equal(kept.carried_from, agentH.id);

    // no agent save, no summarizer → mechanical
    await new Promise((r) => setTimeout(r, 5));
    started = Date.now();
    write(root, 'a.txt', 'edited\n');
    const mech = await ensureHandoff(root, { name: 'claude', p, started, summary: true, cfg: { profiles: {}, chain: [] }, log: quiet });
    assert.equal(mech.source, 'auto');

    // summarizer available on another profile
    started = Date.now();
    const cfg = { profiles: { claude: {}, ds: { api: { format: 'openai', baseUrl: url, model: 'm' }, key: encryptKey('k') } }, chain: ['claude', 'ds'] };
    const sum = await ensureHandoff(root, { name: 'claude', p, started, summary: true, cfg, log: quiet });
    assert.equal(sum.source, 'summary');
    assert.equal(sum.next_action, REPLY.next_action);
  } finally {
    server.close();
  }
});

test('summarizer order: other chain profiles, then summary-only, then the one that stopped', () => {
  const k = encryptKey('1');
  const cfg = { profiles: { a: { api: {}, key: k }, b: { api: {}, key: k }, c: {}, g: { agent: 'none', api: {}, key: k } }, chain: ['a', 'b', 'c'] };
  assert.deepEqual(summarizerOrder(cfg, 'a'), ['b', 'g', 'a']);
  assert.deepEqual(summarizerOrder({ ...cfg, summarizer: 'g' }, 'b'), ['g', 'a', 'b']);
  assert.deepEqual(summarizerOrder({ profiles: { c: {} }, chain: ['c'] }, 'c'), []);
  assert.equal(nextInChain(['a', 'b'], 'b'), 'a');
});

test('a failing summarizer falls through to the next one', async () => {
  const { server, url } = await fakeApi();
  try {
    const root = makeRepo();
    store.ensureProject(root);
    write(root, 'a.txt', 'edited\n');
    const k = encryptKey('k');
    const cfg = {
      profiles: { claude: {}, broken: { api: { format: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'm' }, key: k }, ok: { agent: 'none', api: { format: 'openai', baseUrl: url, model: 'm' }, key: k } },
      chain: ['claude', 'broken'],
    };
    const lines = [];
    const h = await ensureHandoff(root, { name: 'claude', p: { agent: 'claude' }, started: Date.now(), summary: true, cfg, log: (l) => lines.push(l) });
    assert.equal(h.source, 'summary');
    assert.match(h.agent, /summary: ok/);
    assert.match(lines.join('\n'), /broken failed/);
  } finally {
    server.close();
  }
});

test('summary-only profiles stay out of the chain', () => {
  saveProfile('gem', buildProfile('gem', { preset: 'gemini' }), 'g-key');
  assert.ok(!readConfig().chain.includes('gem'));
  assert.throws(() => setChain(['gem']), /Summarizer-only/);
  assert.equal(buildProfile('grok').agent, 'none');
});

test('profiles persist, keep keys on re-add, and chain validates names', () => {
  saveProfile('px', buildProfile('px', { preset: 'deepseek' }), 'key-1');
  const stored = readConfig().profiles.px.key;
  saveProfile('px', buildProfile('px', { preset: 'deepseek', model: 'other' }), null);
  assert.equal(readConfig().profiles.px.key, stored);
  assert.equal(readConfig().profiles.px.model, 'other');
  assert.throws(() => setChain(['px', 'ghost']), /Unknown profile/);
});

test('launch env drops a parent agent session and stale Anthropic vars', async () => {
  const { cleanEnv } = await import('../src/launcher.js');
  const base = { PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_API_KEY: 'old' };
  assert.deepEqual(cleanEnv(base, { keyEnv: 'ANTHROPIC_AUTH_TOKEN' }), { PATH: 'x' });
  assert.deepEqual(cleanEnv(base, {}), { PATH: 'x', ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_API_KEY: 'old' });
});

test('codex profile with mcp:false saves through the CLI and can write tagteam data', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const dir = tmp('tagteam-bin-');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  const old = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${old}`;
  try {
    const root = makeRepo();
    store.ensureProject(root);
    const spec = buildLaunch({ ...buildProfile('mine', { agent: 'codex', baseUrl: 'https://x/v1' }), mcp: false, codex: { disable: ['multi_agent'], config: ['web_search="disabled"'] } }, root, 'k', 'grok');
    const args = spec.args.join(' ');
    assert.doesNotMatch(args, /mcp_servers/);
    assert.ok(spec.args.includes('--add-dir'));
    assert.match(args, /--disable multi_agent .*web_search="disabled"/);
    assert.match(spec.args.at(-1), /tagteam capture --json --agent grok/);
  } finally {
    process.env.PATH = old;
  }
});

test('native-login codex preset needs no key and sets no provider', () => {
  const p = buildProfile('codex');
  assert.equal(p.agent, 'codex');
  assert.equal(p.provider, undefined);
  assert.equal(p.key, undefined);
});
