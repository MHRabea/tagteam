// Guard: stop an agent from editing a path a constraint protects, before the edit happens.
// Runs as a Claude Code PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit. Writes made through a
// shell (Bash) are not visible here; `tagteam status`, `tagteam check` and the GitHub Action catch those.
import path from 'node:path';
import * as store from './store.js';
import { matchesPath } from './handoff.js';

const guardFile = (root) => path.join(store.projectDir(root), 'guard.json');

export const guardEnabled = (root) => process.env.TAGTEAM_GUARD !== 'off' && store.readJson(guardFile(root), { enabled: true }).enabled !== false;

export function setGuard(root, enabled) {
  store.writeJson(guardFile(root), { enabled, changed_at: new Date().toISOString() });
}

// Path of the file a tool call writes, relative to the repo with forward slashes; null when outside the repo.
export function targetPath(root, input = {}) {
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof raw !== 'string' || !raw) return null;
  const abs = path.resolve(input.cwd ?? root, raw);
  const rel = path.relative(root, abs); // case-insensitive on Windows
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// The rule that blocks this edit, or null. Rules saved with enforce: 'warn' never block.
export function blockingRule(root, file) {
  if (!file || !guardEnabled(root)) return null;
  for (const c of store.allConstraints(root)) {
    if (c.enforce === 'warn' || !c.paths?.length) continue;
    if (c.paths.some((p) => matchesPath(p, file))) return c;
  }
  return null;
}

export function denyMessage(file, rule) {
  return [
    `tagteam blocked this edit to ${file}.`,
    `It is protected by the rule "${rule.text}" (paths: ${rule.paths.join(', ')}).`,
    'Do not try to change it another way (shell commands, copies, renames).',
    'If the change is really needed, stop and ask the user. They can allow it with `tagteam guard off` or remove the rule.',
  ].join(' ');
}
