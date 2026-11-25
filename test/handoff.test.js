import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, commit, write } from './helpers.js';
import * as store from '../src/store.js';
import { gitState } from '../src/git.js';
import { capture, computeDrift, contextPack, checkGuardrails, matchesPath, touchedFiles } from '../src/handoff.js';

const fields = {
  task: { title: 'Retry refactor', acceptance: [] },
  completed: ['scheduler'],
  in_progress: [],
  next_action: 'Fix retry test',
  known_issues: [],
  decisions: [{ decision: 'Use idempotency keys', why: 'dupes' }],
  constraints: [{ text: 'Do not touch gateway', paths: ['src/gateway/**'] }],
};

function setup() {
  const root = makeRepo();
  store.ensureProject(root);
  const h = capture(root, { source: 'agent', agent: 'test', fields });
  return { root, h };
}

test('clean repo has no drift', () => {
  const { root, h } = setup();
  assert.deepEqual(computeDrift(root, h, gitState(root)), []);
});

test('new commit is reported as drift with file names', () => {
  const { root, h } = setup();
  write(root, 'b.txt', 'x');
  commit(root, 'b');
  const d = computeDrift(root, h, gitState(root));
  assert.equal(d.length, 1);
  assert.match(d[0], /1 new commit\(s\).*b\.txt/);
});

test('uncommitted change is reported as drift', () => {
  const { root, h } = setup();
  write(root, 'a.txt', 'changed\n');
  const d = computeDrift(root, h, gitState(root));
  assert.match(d.join('\n'), /Uncommitted changes differ.*Newly modified: a\.txt/);
});

test('uncommitted change is still reported after new commits', () => {
  const { root, h } = setup();
  write(root, 'b.txt', 'x');
  commit(root, 'b');
  write(root, 'a.txt', 'changed\n');
  assert.match(computeDrift(root, h, gitState(root)).join('\n'), /1 new commit[\s\S]*Newly modified: a\.txt/);
});

test('old handoff is flagged by age', () => {
  const { root, h } = setup();
  const d = computeDrift(root, h, gitState(root), Date.now() + 3 * 86_400_000);
  assert.match(d.join('\n'), /3 day\(s\) old/);
});

test('auto capture carries agent fields and measures drift from the agent save', () => {
  const { root, h } = setup();
  write(root, 'a.txt', 'changed\n');
  const auto = capture(root, { source: 'auto', reason: 'precompact' });
  assert.equal(auto.next_action, 'Fix retry test');
  assert.equal(auto.carried_from, h.id);
  assert.deepEqual(auto.fields_git, h.git);
  // a second auto save keeps pointing at the original agent handoff
  const auto2 = capture(root, { source: 'auto', reason: 'session_end' });
  assert.equal(auto2.carried_from, h.id);
  assert.match(computeDrift(root, auto2, gitState(root)).join('\n'), /a\.txt/);
});

test('decisions and constraints from a handoff are stored once', () => {
  const { root } = setup();
  capture(root, { source: 'agent', fields });
  assert.equal(store.readConstraints(root).length, 1);
  assert.equal(store.readDecisions(root).length, 2);
});

test('guardrail fires when a protected path is touched', () => {
  const { root, h } = setup();
  write(root, 'src/gateway/pay.js', 'x');
  const g = checkGuardrails(store.readConstraints(root), touchedFiles(root, h, gitState(root)));
  assert.deepEqual(g, [{ constraint: 'Do not touch gateway', files: ['src/gateway/pay.js'] }]);
  assert.match(contextPack(root), /Guardrail warnings[\s\S]*src\/gateway\/pay\.js/);
});

test('path matching: globs and plain directories', () => {
  assert.ok(matchesPath('src/gateway/**', 'src/gateway/a/b.js'));
  assert.ok(matchesPath('src/**/*.sql', 'src/x/y/z.sql'));
  assert.ok(matchesPath('src/**/*.sql', 'src/z.sql'));
  assert.ok(!matchesPath('src/*.js', 'src/a/b.js'));
  assert.ok(matchesPath('src/payments', 'src/payments/x.js'));
  assert.ok(!matchesPath('src/payments', 'src/payments-old/x.js'));
  assert.ok(matchesPath('.\\src\\a.js', 'src/a.js'));
});

test('context pack renders task, constraints and next action', () => {
  const { root } = setup();
  const pack = contextPack(root);
  assert.match(pack, /Current task: Retry refactor/);
  assert.match(pack, /Next action\nFix retry test/);
  assert.match(pack, /Do not touch gateway \[src\/gateway\/\*\*\]/);
  assert.doesNotMatch(pack, /Drift/);
});
