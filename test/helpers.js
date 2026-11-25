import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitRoot } from '../src/git.js';

export const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Isolated TAGTEAM_HOME per test file so tests never touch ~/.tagteam.
process.env.TAGTEAM_HOME = tmp('tagteam-home-');
// CI runners on macOS/Linux have no unlocked keyring; tests that need one stub it (see production.test.js).
if (process.platform !== 'win32') process.env.TAGTEAM_KEY_STORE ??= 'plain';

export function makeRepo() {
  const dir = tmp('tagteam-repo-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');
  return gitRoot(dir);
}

export function commit(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg);
}

export const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
