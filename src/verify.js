// `tagteam verify`: re-run the test command a handoff names and compare it with what the handoff claims.
// The command was written by an agent (or a summarizer reading a transcript), so it only ever runs after the
// user has seen it and said yes; it is never run automatically.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './store.js';
import { gitState } from './git.js';

const file = (root) => path.join(store.projectDir(root), 'verification.json');

export const readVerification = (root) => store.readJson(file(root), null);

export function runTests(root, command, { timeoutMs = 600_000, stdio = 'inherit' } = {}) {
  const started = Date.now();
  const r = spawnSync(command, { cwd: root, shell: true, stdio, timeout: timeoutMs, encoding: 'utf8' });
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return { code: r.status, timedOut, ms: Date.now() - started, error: r.error && !timedOut ? r.error.message : undefined };
}

// claimed: pass | fail | not_run. actual: pass | fail.
export function compare(claimed, actual) {
  if (claimed === actual) return { ok: true, verdict: `as claimed: ${actual}` };
  if (claimed === 'pass') return { ok: false, verdict: 'claimed pass, but the tests FAIL now' };
  if (claimed === 'fail') return { ok: true, verdict: 'claimed fail, and the tests pass now (fixed since, or the claim was wrong)' };
  return { ok: true, verdict: `not run by the previous agent; they ${actual === 'pass' ? 'pass' : 'FAIL'} now` };
}

export function recordVerification(root, h, command, run) {
  const actual = run.code === 0 && !run.timedOut ? 'pass' : 'fail';
  const claimed = h.tests?.result ?? 'not_run';
  const v = {
    handoff_id: h.id,
    at: new Date().toISOString(),
    command,
    claimed,
    actual,
    ...(run.timedOut ? { note: 'timed out' } : {}),
    head: gitState(root).head,
    ...compare(claimed, actual),
  };
  store.writeJson(file(root), v);
  return v;
}
