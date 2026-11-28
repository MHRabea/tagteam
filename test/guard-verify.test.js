// 0.3.0: the PreToolUse guard that blocks edits to protected paths, and `tagteam verify`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers.js';
import * as store from '../src/store.js';
import { capture, contextPack } from '../src/handoff.js';
import { targetPath, blockingRule, setGuard, guardEnabled } from '../src/guard.js';
import { compare, runTests, recordVerification, readVerification, shellFor } from '../src/verify.js';
import { installClaude, HOOKS } from '../src/install.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const cli = (root, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, TAGTEAM_GUARD: '' } });
const hook = (root, tool_name, tool_input) => cli(root, ['guard', '--hook'], JSON.stringify({ cwd: root, tool_name, tool_input }));

function guardedRepo() {
  const root = makeRepo();
  store.ensureProject(root);
  store.addConstraint(root, { text: 'Do not change the payment gateway', paths: ['src/payments/**'] });
  store.addSharedConstraint(root, { text: 'Keep the license', paths: ['LICENSE'] });
  store.addConstraint(root, { text: 'Careful with config', paths: ['config/**'], enforce: 'warn' });
  return root;
}

test('targetPath: repo-relative with forward slashes; outside the repo or missing is null', () => {
  const root = makeRepo();
  assert.equal(targetPath(root, { file_path: path.join(root, 'src', 'a.js') }), 'src/a.js');
  assert.equal(targetPath(root, { file_path: 'src/b.js' }), 'src/b.js');
  assert.equal(targetPath(root, { notebook_path: path.join(root, 'n.ipynb') }), 'n.ipynb');
  assert.equal(targetPath(root, { file_path: path.join(root, '..', 'elsewhere.js') }), null);
  assert.equal(targetPath(root, {}), null);
  assert.equal(targetPath(root, { file_path: root }), null);
});

test('blockingRule: local and shared rules block, warn-only never does, the switch turns it off', () => {
  const root = guardedRepo();
  assert.equal(blockingRule(root, 'src/payments/gateway.js').text, 'Do not change the payment gateway');
  assert.equal(blockingRule(root, 'LICENSE').text, 'Keep the license');
  assert.equal(blockingRule(root, 'config/prod.json'), null);
  assert.equal(blockingRule(root, 'src/app.js'), null);
  setGuard(root, false);
  assert.equal(guardEnabled(root), false);
  assert.equal(blockingRule(root, 'LICENSE'), null);
  setGuard(root, true);
  process.env.TAGTEAM_GUARD = 'off';
  try {
    assert.equal(blockingRule(root, 'LICENSE'), null);
  } finally {
    delete process.env.TAGTEAM_GUARD;
  }
});

test('guard hook: exit 2 with the reason for a protected file, 0 otherwise, never blocks on bad input', () => {
  const root = guardedRepo();
  const blocked = hook(root, 'Edit', { file_path: path.join(root, 'src', 'payments', 'gateway.js') });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /blocked this edit to src\/payments\/gateway\.js/);
  assert.match(blocked.stderr, /Do not change the payment gateway/);
  assert.match(blocked.stderr, /ask the user/);
  assert.equal(hook(root, 'MultiEdit', { file_path: path.join(root, 'LICENSE'), edits: [] }).status, 2);
  assert.equal(hook(root, 'Write', { file_path: path.join(root, 'src', 'app.js') }).status, 0);
  assert.equal(hook(root, 'Write', { file_path: path.join(root, 'config', 'x.json') }).status, 0, 'warn-only');
  assert.equal(cli(root, ['guard', '--hook'], 'not json').status, 0);
  assert.equal(cli(root, ['guard', '--hook'], '').status, 0);
  assert.equal(cli(root, ['guard', 'off']).status, 0);
  assert.equal(hook(root, 'Edit', { file_path: path.join(root, 'LICENSE') }).status, 0, 'guard off');
  assert.match(cli(root, ['guard', 'on']).stdout, /Guard: on\. 2 blocking path rule\(s\), 1 warn-only/);
});

test('the guard hook is wired for Claude Code (tagteam run and tagteam install claude)', () => {
  assert.ok(HOOKS.some(([e, m, c]) => e === 'PreToolUse' && /Edit/.test(m) && /Write/.test(m) && c === 'tagteam guard --hook'));
  const root = makeRepo();
  installClaude(root);
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'tagteam guard --hook');
});

test('constraint --warn-only is saved as warn', () => {
  const root = makeRepo();
  assert.equal(cli(root, ['constraint', 'Heads up on docs', '--paths', 'docs/**', '--warn-only']).status, 0);
  assert.deepEqual(store.readConstraints(root), [{ text: 'Heads up on docs', paths: ['docs/**'], enforce: 'warn' }]);
});

test('verify: compare covers every claim', () => {
  assert.deepEqual(compare('pass', 'pass'), { ok: true, verdict: 'as claimed: pass' });
  assert.equal(compare('pass', 'fail').ok, false);
  assert.match(compare('fail', 'pass').verdict, /pass now/);
  assert.match(compare('not_run', 'fail').verdict, /FAIL now/);
});

const node = (code) => `"${process.execPath}" -e "${code}"`;

test('verify: runs the command, records the result, and the next agent sees it', () => {
  const root = makeRepo();
  store.ensureProject(root);
  const h = capture(root, { source: 'agent', fields: { task: { title: 't' }, next_action: 'x', tests: { command: node('process.exit(1)'), result: 'pass' } } });
  assert.match(contextPack(root), /has not been re-run/);
  const run = runTests(root, h.tests.command, { stdio: 'ignore' });
  assert.equal(run.code, 1);
  const v = recordVerification(root, h, h.tests.command, run);
  assert.equal(v.actual, 'fail');
  assert.equal(v.ok, false);
  assert.equal(readVerification(root).handoff_id, h.id);
  assert.match(contextPack(root), /Test check \(re-run by tagteam verify.*\n.*FAIL\. claimed pass, but the tests FAIL now/);
  // A newer handoff makes the old check irrelevant.
  capture(root, { source: 'agent', fields: { task: { title: 't' }, next_action: 'y', tests: { command: 'npm test', result: 'pass' } } });
  assert.match(contextPack(root), /has not been re-run/);
});

test('verify: a command that hangs is stopped and counts as a failure', () => {
  const root = makeRepo();
  const r = runTests(root, node('setTimeout(()=>{},60000)'), { timeoutMs: 1500, stdio: 'ignore' });
  assert.equal(r.timedOut, true);
});

test('verify CLI: needs --yes without a terminal, exit 2 on a false pass, 0 when the claim holds', () => {
  const root = makeRepo();
  store.ensureProject(root);
  assert.match(cli(root, ['verify']).stderr, /names no test command/);
  capture(root, { source: 'agent', fields: { task: { title: 't' }, next_action: 'x', tests: { command: node('process.exit(1)'), result: 'pass' } } });
  const noYes = cli(root, ['verify']);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /Pass --yes/);
  const bad = cli(root, ['verify', '--yes']);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stdout, /claimed pass, but the tests FAIL now/);
  capture(root, { source: 'agent', fields: { task: { title: 't' }, next_action: 'x', tests: { command: node('process.exit(0)'), result: 'pass' } } });
  const good = cli(root, ['verify', '--yes', '--timeout', '30']);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /as claimed: pass/);
});

// Found live: Codex on Windows wrote "$env:NODE_OPTIONS = '...'; npm.cmd test", which cmd.exe cannot run,
// and verify reported a false "FAIL". A command that cannot run proves nothing; PowerShell syntax runs in PowerShell.
test('verify: a command that cannot run is "unknown", never a test failure', () => {
  const root = makeRepo();
  const r = runTests(root, 'tagteam-no-such-command-xyz', { stdio: 'ignore' });
  assert.equal(r.couldNotRun, true);
  assert.deepEqual(compare('pass', 'unknown').ok, null);
  store.ensureProject(root);
  const h = capture(root, { source: 'agent', fields: { task: { title: 't' }, next_action: 'x', tests: { command: 'tagteam-no-such-command-xyz', result: 'pass' } } });
  const v = recordVerification(root, h, h.tests.command, r);
  assert.equal(v.actual, 'unknown');
  assert.match(contextPack(root), /COULD NOT RUN\. the command could not be run here/);
  const out = cli(root, ['verify', '--yes']);
  assert.equal(out.status, 1, 'exit 1 (nothing checked), not 2 (false claim)');
  assert.match(out.stdout, /\? tagteam verify: the command could not be run/);
});

test('verify: PowerShell-style commands are detected and, on Windows, run in PowerShell', () => {
  const ps = "$env:NODE_OPTIONS = '--preserve-symlinks'; npm.cmd test";
  assert.equal(shellFor(ps, 'win32'), 'powershell');
  assert.equal(shellFor(ps, 'linux'), 'default');
  assert.equal(shellFor('npm test', 'win32'), 'default');
  if (process.platform !== 'win32') return;
  const root = makeRepo();
  const ok = runTests(root, `$env:TT_X = '1'; & "${process.execPath}" -e "process.exit(process.env.TT_X === '1' ? 0 : 1)"`, { stdio: 'ignore' });
  assert.equal(ok.shell, 'powershell');
  assert.equal(ok.code, 0);
  const bad = runTests(root, `$env:TT_X = '1'; & "${process.execPath}" -e "process.exit(4)"`, { stdio: 'ignore' });
  assert.equal(bad.code, 4);
  assert.equal(bad.couldNotRun, false);
});
