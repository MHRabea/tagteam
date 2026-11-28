import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

// null when git exits non-zero (no commits yet, unknown sha, not an ancestor, ...).
export function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

export function gitRoot(cwd) {
  const r = tryGit(cwd, 'rev-parse', '--show-toplevel');
  return r ? path.resolve(r) : null;
}

export const remoteUrl = (root) => tryGit(root, 'remote', 'get-url', 'origin');

// Parse `git status --porcelain=v1 -z`. Renames/copies carry an extra NUL field (the old path).
export function parseStatusZ(out) {
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return files;
}

export function gitState(root) {
  const head = tryGit(root, 'rev-parse', 'HEAD');
  const branch = tryGit(root, 'symbolic-ref', '--short', 'HEAD') ?? (head ? 'DETACHED' : null);
  const status = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const diffArgs = head ? ['diff', 'HEAD'] : ['diff'];
  const diff = tryGit(root, ...diffArgs) ?? '';
  const stat = tryGit(root, ...diffArgs, '--shortstat') ?? '';
  // shortcut: hash covers tracked diff + status list, not untracked file contents; hash those if edits to new files must count as drift.
  const diff_hash = createHash('sha1').update(diff).update('\0').update(status).digest('hex').slice(0, 16);
  return { branch, head, dirty_files: parseStatusZ(status), diff_stat: stat.trim(), diff_hash };
}

export const isAncestor = (root, sha) => tryGit(root, 'merge-base', '--is-ancestor', sha, 'HEAD') !== null;

export function commitsSince(root, sha) {
  const n = tryGit(root, 'rev-list', '--count', `${sha}..HEAD`);
  return n === null ? null : Number(n);
}

export function filesChangedSince(root, sha) {
  const out = tryGit(root, 'diff', '--name-only', sha, 'HEAD');
  return out === null ? null : out.split('\n').filter(Boolean);
}

// Files changed on this branch since it left <base> (three-dot: merge-base..HEAD), like a PR diff.
export function filesChangedInRange(root, base) {
  const out = tryGit(root, 'diff', '--name-only', `${base}...HEAD`);
  return out === null ? null : out.split('\n').filter(Boolean);
}
