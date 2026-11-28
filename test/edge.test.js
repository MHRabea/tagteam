// 0.2.0: handoff completeness, shared (repo) constraints, `tagteam check` for CI, usage-limit detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, makeRepo, write, commit } from './helpers.js';
import * as store from '../src/store.js';
import { git } from '../src/git.js';
import { capture, handoffGaps, statusReport, contextPack, checkRange } from '../src/handoff.js';
import { detectLimit } from '../src/transcript.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const cli = (root, args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });

const full = {
  task: { title: 'Fix prorate' },
  completed: ['swapped the division'],
  next_action: 'Fix the rounding in prorate() in src/billing.js so test/billing.test.js passes',
  tests: { command: 'npm test', result: 'pass' },
};

test('gaps: a complete handoff has none; missing and vague fields are named', () => {
  assert.deepEqual(handoffGaps({ source: 'agent', ...full }), []);
  const gaps = handoffGaps({ source: 'agent', task: { title: 'x' }, next_action: 'continue' });
  assert.ok(gaps.some((g) => /vague/.test(g)));
  assert.ok(gaps.some((g) => /No test status/.test(g)));
  assert.ok(gaps.some((g) => /Nothing listed/.test(g)));
  assert.ok(handoffGaps({ source: 'agent', task: { title: 'x' } }).some((g) => /No next action/.test(g)));
  assert.ok(handoffGaps({ source: 'agent', ...full, tests: { result: 'fail' } }).some((g) => /Tests fail/.test(g)));
  assert.match(handoffGaps({ source: 'auto' })[0], /Only git state/);
  assert.deepEqual(handoffGaps(null), []);
});

test('gaps are advisory: shown in status and context, but never fail status', () => {
  const root = makeRepo();
  store.ensureProject(root);
  capture(root, { source: 'agent', fields: { task: { title: 'x' }, next_action: 'tbd' } });
  const r = statusReport(root);
  assert.equal(r.ok, true);
  assert.match(r.text, /Completeness \(advisory\)/);
  assert.match(contextPack(root), /Handoff gaps/);
  capture(root, { source: 'agent', fields: full });
  assert.match(statusReport(root).text, /Completeness: ok/);
  assert.doesNotMatch(contextPack(root), /Handoff gaps/);
});

test('shared constraints live in the repo, come first, and dedupe local copies', () => {
  const root = makeRepo();
  store.ensureProject(root);
  store.addConstraint(root, { text: 'local only' });
  store.addConstraint(root, { text: 'both' });
  store.addSharedConstraint(root, { text: 'both', paths: ['src/pay/**'] });
  store.addSharedConstraint(root, { text: 'both', paths: ['ignored duplicate'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.tagteam', 'constraints.json'), 'utf8')), [{ text: 'both', paths: ['src/pay/**'] }]);
  assert.deepEqual(store.allConstraints(root).map((c) => [c.text, Boolean(c.shared)]), [['both', true], ['local only', false]]);
  assert.match(contextPack(root), /both \[src\/pay\/\*\*\]/);
  write(root, '.tagteam/constraints.json', '{"not": "an array"}');
  assert.throws(() => store.allConstraints(root), /JSON array/);
});

function branchRepo() {
  const root = makeRepo();
  write(root, '.tagteam/constraints.json', JSON.stringify([{ text: 'Do not change the payment gateway', paths: ['src/payments/**'] }]));
  write(root, 'src/payments/gateway.js', 'v1\n');
  commit(root, 'base');
  git(root, 'branch', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  return root;
}

test('check: only files changed on the branch count, uncommitted ones too', () => {
  const root = branchRepo();
  write(root, 'src/app.js', 'ok\n');
  commit(root, 'unrelated');
  assert.deepEqual(checkRange(root, 'base').violations, []);
  write(root, 'src/payments/gateway.js', 'v2\n');
  const r = checkRange(root, 'base');
  assert.deepEqual(r.violations, [{ constraint: 'Do not change the payment gateway', files: ['src/payments/gateway.js'] }]);
  assert.throws(() => checkRange(root, 'no-such-ref'), /fetch-depth: 0/);
});

test('check CLI: exit 2 with GitHub annotations on a hit, exit 0 when clean; works without tagteam init', () => {
  const root = branchRepo();
  process.env.TAGTEAM_HOME = tmp('tagteam-fresh-home-'); // a CI runner has no ~/.tagteam
  const clean = cli(root, ['check', '--base', 'base']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /1 path rule/);
  write(root, 'src/payments/gateway.js', 'v2\n');
  commit(root, 'touch gateway');
  const hit = cli(root, ['check', '--base', 'base'], { GITHUB_ACTIONS: 'true' });
  assert.equal(hit.status, 2, hit.stderr);
  assert.match(hit.stdout, /::error file=src\/payments\/gateway\.js,title=tagteam constraint::Do not change the payment gateway/);
  const noAnnot = cli(root, ['check', '--base', 'base']);
  assert.doesNotMatch(noAnnot.stdout, /::error/);
});

test('constraint --shared writes the repo file', () => {
  const root = makeRepo();
  const r = cli(root, ['constraint', 'Keep the public API stable', '--paths', 'src/api/**', '--shared']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(store.readSharedConstraints(root), [{ text: 'Keep the public API stable', paths: ['src/api/**'] }]);
});

const jsonl = (entries) => {
  const f = path.join(tmp('tagteam-tr-'), 't.jsonl');
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return f;
};
const said = (role, text, extra = {}) => ({ type: role, message: { role, content: [{ type: 'text', text }] }, ...extra });

test('detectLimit: Claude Code limit and API errors at the end of the session', () => {
  assert.match(detectLimit(jsonl([said('user', 'hi'), said('assistant', 'Claude AI usage limit reached|1795000000')])), /usage limit/);
  assert.match(detectLimit(jsonl([said('assistant', '5-hour limit reached ∙ resets 3pm')])), /limit reached/);
  assert.ok(detectLimit(jsonl([said('assistant', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', { isApiErrorMessage: true })])));
  assert.ok(detectLimit(jsonl([said('assistant', 'Credit balance is too low')])));
  // A tool-use-only last turn is skipped: the last text decides.
  assert.ok(detectLimit(jsonl([said('assistant', 'Claude AI usage limit reached'), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] } }])));
});

test('detectLimit: no false positives from normal work', () => {
  // Talking about rate limits while coding is not a limit.
  const long = `I added a rate limiter to the API. ${'It uses a token bucket per user. '.repeat(12)}`;
  assert.equal(detectLimit(jsonl([said('assistant', long)])), null);
  // An earlier limit followed by more work is not how the session ended.
  assert.equal(detectLimit(jsonl([said('assistant', 'Claude AI usage limit reached'), said('user', 'ok'), said('assistant', 'Done: tests pass.')])), null);
  // The user mentioning a limit does not count.
  assert.equal(detectLimit(jsonl([said('assistant', 'Done.'), said('user', 'I hit my usage limit yesterday')])), null);
  assert.equal(detectLimit(path.join(tmp('tagteam-tr-'), 'missing.jsonl')), null);
});

test('detectLimit: Codex error events', () => {
  const msg = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'output_text', text }] } });
  assert.match(detectLimit(jsonl([msg('assistant', 'working'), { type: 'event_msg', payload: { type: 'error', message: "You've hit your usage limit. Try again later." } }])), /usage limit/);
  assert.equal(detectLimit(jsonl([{ type: 'event_msg', payload: { type: 'error', message: 'stream disconnected' } }])), null);
  assert.equal(detectLimit(jsonl([{ type: 'event_msg', payload: { type: 'error', message: 'rate limit' } }, msg('assistant', 'recovered and finished')])), null);
});
