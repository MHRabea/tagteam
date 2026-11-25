import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
import { redact } from '../src/redact.js';
import { recentUserMessages } from '../src/transcript.js';
import { mergeHook, upsertBlock } from '../src/install.js';
import { parseStatusZ } from '../src/git.js';

test('redacts common secrets and keeps normal text', () => {
  const cases = [
    'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'DATABASE_PASSWORD=hunter2',
    'api_key: "s3cr3t"',
    'postgres://admin:pa55word@db.local:5432/app',
    'Authorization: Bearer abcdefghijklmnop.qrstuv',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const r = redact(c);
    assert.match(r, /\[REDACTED\]/, c);
    assert.doesNotMatch(r, /hunter2|pa55word|s3cr3t|MIIE|ghp_abc|sk-ant|AKIAAB/, c);
  }
  assert.equal(redact('Fix the retry test in billing.js'), 'Fix the retry test in billing.js');
  assert.equal(redact('postgres://db.local/app'), 'postgres://db.local/app');
});

test('reads last user messages and skips tool results and wrappers', () => {
  const f = path.join(tmp('tagteam-tr-'), 't.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.deepEqual(recentUserMessages(f), ['first', 'second']);
  assert.deepEqual(recentUserMessages(f, 1), ['second']);
  assert.deepEqual(recentUserMessages(path.join(f, 'missing')), []);
});

test('mergeHook keeps user hooks and replaces only tagteam hooks', () => {
  const s = { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: 'tagteam capture --old' }] }] } };
  mergeHook(s, 'PreCompact', null, 'tagteam capture --auto');
  mergeHook(s, 'PreCompact', null, 'tagteam capture --auto');
  const cmds = s.hooks.PreCompact.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(cmds, ['echo mine', 'tagteam capture --auto']);
});

test('upsertBlock appends once and then replaces in place', () => {
  const once = upsertBlock('# Repo\n', 'v1');
  assert.equal(once, '# Repo\n\n<!-- tagteam:start -->\nv1\n<!-- tagteam:end -->\n');
  const twice = upsertBlock(`${once}\nfooter\n`, 'v2');
  assert.equal(twice, '# Repo\n\n<!-- tagteam:start -->\nv2\n<!-- tagteam:end -->\n\nfooter\n');
});

test('parses porcelain -z including renames', () => {
  assert.deepEqual(parseStatusZ(' M a.js\0R  new.js\0old.js\0?? dir/n w.txt\0'), ['a.js', 'new.js', 'dir/n w.txt']);
});
