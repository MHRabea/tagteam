// Local storage under ~/.tagteam/projects/<id>/ (outside the user's repo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Handoff file format. Bump it when a field changes meaning, and add a step to migrate().
export const SCHEMA = 1;

export const home = () => process.env.TAGTEAM_HOME || path.join(os.homedir(), '.tagteam');

export function projectId(root) {
  const abs = path.resolve(root);
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export const projectDir = (root) => path.join(home(), 'projects', projectId(root));
const file = (root, ...parts) => path.join(projectDir(root), ...parts);

export function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${f}: ${e.message}`);
  }
}

// Write to a temp file then rename, so a crash never leaves a half-written file.
export function writeFile(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, f);
}

export const writeJson = (f, obj) => writeFile(f, JSON.stringify(obj, null, 2) + '\n');

export const MEMORY_TEMPLATE = `# Project memory
<!-- Slow-changing facts: architecture, rules, business logic. Edit by hand or via the tagteam MCP tool update_memory. -->
`;

export const isRegistered = (root) => fs.existsSync(file(root, 'project.json'));

export function ensureProject(root, remote = null) {
  const existing = readJson(file(root, 'project.json'), null);
  if (existing) return existing;
  const project = { root: path.resolve(root), remote, created_at: new Date().toISOString() };
  writeJson(file(root, 'project.json'), project);
  if (!fs.existsSync(file(root, 'memory.md'))) writeFile(file(root, 'memory.md'), MEMORY_TEMPLATE);
  return project;
}

export function readMemory(root) {
  try {
    return fs.readFileSync(file(root, 'memory.md'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}
export const writeMemory = (root, content) => writeFile(file(root, 'memory.md'), content);

export const readConstraints = (root) => readJson(file(root, 'constraints.json'), []);
export function addConstraint(root, c) {
  return withLock(root, () => {
    const list = readConstraints(root);
    if (list.some((x) => x.text === c.text)) return list;
    list.push(c);
    writeJson(file(root, 'constraints.json'), list);
    return list;
  });
}

export const readDecisions = (root) => readJson(file(root, 'decisions.json'), []);
export function addDecision(root, d) {
  return withLock(root, () => {
    const list = readDecisions(root);
    list.push(d);
    writeJson(file(root, 'decisions.json'), list);
    return list;
  });
}

// --- Lock -------------------------------------------------------------------
// Two agents (or a hook and the CLI) can save at the same time in one repo. Saves read the latest
// handoff and write a new one, so they run under an exclusive lock file. Re-entrant within a process.
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const held = new Map();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLock(root, fn) {
  const lock = file(root, '.lock');
  if (held.get(lock)) {
    held.set(lock, held.get(lock) + 1);
    try {
      return fn();
    } finally {
      held.set(lock, held.get(lock) - 1);
    }
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A crashed process leaves its lock behind; saves take milliseconds, so an old lock is stale.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}. Delete it if no tagteam process is running.`);
      sleep(25 + Math.random() * 50);
    }
  }
  held.set(lock, 1);
  try {
    return fn();
  } finally {
    held.delete(lock);
    fs.rmSync(lock, { force: true });
  }
}

// --- Handoffs ---------------------------------------------------------------
// Bring a handoff written by an older tagteam up to SCHEMA. Files with no schema field are version 1.
export function migrate(h) {
  if (!h) return h;
  const v = h.schema ?? 1;
  if (v > SCHEMA) throw new Error(`Handoff ${h.id} uses format ${v}; this tagteam reads up to ${SCHEMA}. Update: npm i -g tagteam-ai`);
  return { ...h, schema: SCHEMA };
}

// Returns the saved handoff. Two saves in the same millisecond get distinct ids (-2, -3, ...).
export function saveHandoff(root, h) {
  let id = h.id;
  for (let n = 2; fs.existsSync(file(root, 'handoffs', `${id}.json`)); n++) id = `${h.id}-${n}`;
  const out = { ...h, id, schema: SCHEMA };
  writeJson(file(root, 'handoffs', `${id}.json`), out);
  writeJson(file(root, 'latest.json'), out);
  return out;
}

export const latestHandoff = (root) => migrate(readJson(file(root, 'latest.json'), null));

export function readHandoff(root, id) {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid handoff id: ${id}`);
  return migrate(readJson(file(root, 'handoffs', `${id}.json`), null));
}

// Newest first. Ids are ISO timestamps, so name order is time order.
export function listHandoffs(root) {
  let names;
  try {
    names = fs.readdirSync(file(root, 'handoffs'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((n) => n.endsWith('.json')).sort().reverse().map((n) => n.slice(0, -5));
}
