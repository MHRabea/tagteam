// Production hardening: handoff format version, the save lock, shell-safe custom launches,
// OS key stores (stubbed) and `tagteam doctor`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers.js';
import * as store from '../src/store.js';
import { capture } from '../src/handoff.js';
import { buildProfile, saveProfile, removeProfile, readConfig, encryptKey, decryptKey, keyStore, keyBackend } from '../src/profiles.js';
import { buildLaunch } from '../src/launcher.js';
import { diagnose, printDoctor } from '../src/doctor.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/concurrent-save.mjs', import.meta.url));

test('handoffs carry the format version; older files migrate, newer ones are refused', () => {
  const root = makeRepo();
  store.ensureProject(root);
  const h = capture(root, { source: 'agent', fields: { next_action: 'x' } });
  assert.equal(h.schema, store.SCHEMA);
  assert.equal(store.latestHandoff(root).schema, store.SCHEMA);

  assert.equal(store.migrate({ id: 'old' }).schema, 1);
  assert.throws(() => store.migrate({ id: 'new', schema: store.SCHEMA + 1 }), /Update: npm i -g tagteam-ai/);
});

test('two saves with the same id keep both handoffs', () => {
  const root = makeRepo();
  store.ensureProject(root);
  const a = store.saveHandoff(root, { id: 'same-id', created_at: new Date().toISOString() });
  const b = store.saveHandoff(root, { id: 'same-id', created_at: new Date().toISOString() });
  assert.equal(a.id, 'same-id');
  assert.equal(b.id, 'same-id-2');
  assert.equal(store.latestHandoff(root).id, 'same-id-2');
  assert.deepEqual(store.listHandoffs(root).sort(), ['same-id', 'same-id-2']);
});

test('parallel processes saving into one repo lose nothing', async () => {
  const root = makeRepo();
  store.ensureProject(root);
  const workers = 4;
  const each = 5;
  const runs = Array.from({ length: workers }, (_, w) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [FIXTURE, root, String(w), String(each)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    }),
  );
  await Promise.all(runs);
  assert.equal(store.listHandoffs(root).length, workers * each);
  assert.equal(store.readDecisions(root).length, workers * each);
  assert.equal(fs.existsSync(path.join(store.projectDir(root), '.lock')), false);
});

test('a stale lock left by a crashed process is taken over', () => {
  const root = makeRepo();
  store.ensureProject(root);
  const lock = path.join(store.projectDir(root), '.lock');
  fs.writeFileSync(lock, '99999\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(store.withLock(root, () => 'ran'), 'ran');
  assert.equal(fs.existsSync(lock), false);
});

test('the lock is re-entrant inside one process', () => {
  const root = makeRepo();
  store.ensureProject(root);
  assert.equal(store.withLock(root, () => store.withLock(root, () => 'inner')), 'inner');
});

test('custom profiles get the context path through an env var, never in the command text', () => {
  const root = makeRepo();
  store.ensureProject(root);
  const p = buildProfile('mine', { agent: 'custom', command: 'my-agent --prompt-file {context_file}' });
  const spec = buildLaunch(p, root, null, 'mine');
  assert.equal(spec.shell, true);
  assert.ok(fs.existsSync(spec.env.TAGTEAM_CONTEXT_FILE));
  assert.ok(!spec.cmd.includes(spec.env.TAGTEAM_CONTEXT_FILE));
  assert.match(spec.cmd, process.platform === 'win32' ? /"%TAGTEAM_CONTEXT_FILE%"$/ : /"\$TAGTEAM_CONTEXT_FILE"$/);
});

// Replace the OS tool runner and the backend for one test.
function withStore(backend, fn) {
  const calls = [];
  const secrets = new Map();
  const realRun = keyStore.run;
  const realBackend = process.env.TAGTEAM_KEY_STORE;
  process.env.TAGTEAM_KEY_STORE = backend;
  keyStore.run = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (cmd === 'security' && args[0] === '-i') {
      const m = /-a "([^"]+)" -w "([^"]+)"/.exec(input);
      secrets.set(m[1], m[2]);
      return '';
    }
    if (cmd === 'security' && args[0] === 'find-generic-password') return `${secrets.get(args[args.indexOf('-a') + 1]) ?? ''}\n`;
    if (cmd === 'secret-tool' && args[0] === 'store') return void secrets.set(args.at(-1), input);
    if (cmd === 'secret-tool' && args[0] === 'lookup') return secrets.get(args.at(-1)) ?? '';
    if (args[0] === 'delete-generic-password' || args[0] === 'clear') return void secrets.delete(args.at(-1));
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  try {
    return fn(calls, secrets);
  } finally {
    keyStore.run = realRun;
    if (realBackend === undefined) delete process.env.TAGTEAM_KEY_STORE;
    else process.env.TAGTEAM_KEY_STORE = realBackend;
  }
}

for (const backend of ['keychain', 'secret']) {
  test(`${backend}: the key goes over stdin, profiles.json holds only a reference, rm deletes it`, () =>
    withStore(backend, (calls, secrets) => {
      const KEY = 'sk-test-abc123';
      saveProfile('ks', buildProfile('ks', { preset: 'deepseek' }), KEY);
      const stored = readConfig().profiles.ks.key;
      assert.match(stored, new RegExp(`^${backend}:ks@[0-9a-f]{8}$`));
      assert.ok(!JSON.stringify(readConfig()).includes(KEY));
      for (const c of calls) assert.ok(!c.args.join(' ').includes(KEY), 'key must never be in argv');
      assert.equal(decryptKey(stored), KEY);
      removeProfile('ks');
      assert.equal(secrets.size, 0);
      assert.equal(decryptKey(stored), null);
    }));
}

test('keychain refuses keys that would break its command line', () =>
  withStore('keychain', () => {
    assert.throws(() => encryptKey('bad"key', 'x'), /Keychain/);
    assert.throws(() => encryptKey('has space', 'x'), /Keychain/);
  }));

test('key backend per platform, and an explicit override', () => {
  const real = process.env.TAGTEAM_KEY_STORE;
  delete process.env.TAGTEAM_KEY_STORE;
  try {
    assert.equal(keyBackend('win32'), 'dpapi');
    assert.equal(keyBackend('darwin'), 'keychain');
    assert.equal(keyBackend('linux'), 'secret');
    assert.equal(keyBackend('freebsd'), null);
    process.env.TAGTEAM_KEY_STORE = 'nope';
    assert.throws(() => keyBackend('linux'), /Unknown TAGTEAM_KEY_STORE/);
  } finally {
    if (real === undefined) delete process.env.TAGTEAM_KEY_STORE;
    else process.env.TAGTEAM_KEY_STORE = real;
  }
});

test('doctor reports a missing agent and an unreadable key as problems, never the key', () => {
  const root = makeRepo();
  store.ensureProject(root);
  saveProfile('doc-claude', buildProfile('doc-claude', { preset: 'claude' }), null);
  saveProfile('doc-ds', buildProfile('doc-ds', { preset: 'deepseek' }), 'sk-doctor-secret');
  const checks = diagnose(root, {
    resolve: () => {
      throw new Error('not installed');
    },
    getVersion: () => '1.0',
    decrypt: () => null,
  });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName['profile doc-claude'].status, 'fail');
  assert.match(byName['profile doc-claude'].detail, /not installed/);
  assert.match(byName['profile doc-ds'].detail, /cannot be read/);
  assert.equal(byName.repo.status, 'ok');
  const out = [];
  assert.equal(printDoctor(checks, (l) => out.push(l)), 1);
  assert.ok(!out.join('\n').includes('sk-doctor-secret'));

  const healthy = diagnose(root, { resolve: () => ({ cmd: 'x', pre: [] }), getVersion: () => '9.9', decrypt: () => 'k' });
  assert.equal(healthy.find((c) => c.name === 'profile doc-ds').status, 'ok');
  removeProfile('doc-claude');
  removeProfile('doc-ds');
});
