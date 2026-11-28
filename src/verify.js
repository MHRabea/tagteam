// `tagteam verify`: re-run the test command a handoff names and compare it with what the handoff claims.
// The command was written by an agent (or a summarizer reading a transcript), so it only ever runs after the
// user has seen it and said yes; it is never run automatically.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './store.js';
import { gitState } from './git.js';

const file = (root) => path.join(store.projectDir(root), 'verification.json');

export const readVerification = (root) => store.readJson(file(root), null);

// Agents on Windows often write PowerShell ("$env:X = 'y'; npm test"), which cmd.exe cannot run.
const POWERSHELL = /\$env:|^\s*\$\w+\s*=|\b(Set|Get|Invoke|Remove|New)-[A-Z]\w+/;
export const shellFor = (command, platform = process.platform) => (platform === 'win32' && POWERSHELL.test(command) ? 'powershell' : 'default');

// The shell could not find the command at all, so no test ran. Exit codes are not enough on their own:
// cmd.exe started by Node returns 1 for an unknown command, so the shell's own message is checked too.
const NOT_FOUND_CODES = new Set([9009, 127]);
const NOT_FOUND_TEXT = /is not recognized as (an internal or external command|the name of a cmdlet)|command not found|CommandNotFoundException/i;

export function runTests(root, command, { timeoutMs = 600_000, stdio = 'inherit', platform = process.platform } = {}) {
  const started = Date.now();
  const shell = shellFor(command, platform);
  // stderr is captured to spot "command not found", then passed through so the user still sees it.
  const opts = { cwd: root, stdio: [stdio, stdio, 'pipe'], timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const r =
    shell === 'powershell'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${command} }; exit $LASTEXITCODE`], opts)
      : spawnSync(command, { ...opts, shell: true });
  if (stdio === 'inherit' && r.stderr) process.stderr.write(r.stderr);
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const notFound = NOT_FOUND_CODES.has(r.status) || (r.status !== 0 && NOT_FOUND_TEXT.test(String(r.stderr ?? '').slice(0, 4000)));
  const couldNotRun = !timedOut && (Boolean(r.error) || notFound);
  return { code: r.status, shell, timedOut, couldNotRun, ms: Date.now() - started, error: r.error && !timedOut ? r.error.message : undefined };
}

// claimed: pass | fail | not_run. actual: pass | fail | unknown (the command could not be run).
export function compare(claimed, actual) {
  if (actual === 'unknown') return { ok: null, verdict: 'the command could not be run here (not found, or written for another shell), so nothing was proven either way' };
  if (claimed === actual) return { ok: true, verdict: `as claimed: ${actual}` };
  if (claimed === 'pass') return { ok: false, verdict: 'claimed pass, but the tests FAIL now' };
  if (claimed === 'fail') return { ok: true, verdict: 'claimed fail, and the tests pass now (fixed since, or the claim was wrong)' };
  return { ok: true, verdict: `not run by the previous agent; they ${actual === 'pass' ? 'pass' : 'FAIL'} now` };
}

export function recordVerification(root, h, command, run) {
  const actual = run.couldNotRun ? 'unknown' : run.code === 0 && !run.timedOut ? 'pass' : 'fail';
  const claimed = h.tests?.result ?? 'not_run';
  const v = {
    handoff_id: h.id,
    at: new Date().toISOString(),
    command,
    shell: run.shell,
    claimed,
    actual,
    ...(run.timedOut ? { note: 'timed out' } : {}),
    head: gitState(root).head,
    ...compare(claimed, actual),
  };
  store.writeJson(file(root), v);
  return v;
}
