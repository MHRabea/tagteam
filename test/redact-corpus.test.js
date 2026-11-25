// Redaction corpus: real-world secret shapes that must never reach disk or a summarizer,
// and ordinary coding text that must survive untouched. All secrets here are fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep } from '../src/redact.js';

// [label, text, the secret part that must disappear]
const LEAKS = [
  ['openai project key', 'key is sk-proj-AbCdEf0123456789AbCdEf0123456789', 'sk-proj-AbCdEf0123456789'],
  ['anthropic key', 'ANTHROPIC=sk-ant-api03-AbCdEf0123456789AbCdEf-xyz', 'AbCdEf0123456789AbCdEf'],
  ['deepseek key', 'use sk-0123456789abcdef0123456789abcdef', 'sk-0123456789abcdef'],
  ['xai key', 'grok: xai-AbCdEf0123456789AbCdEf0123456789AbCdEf', 'xai-AbCdEf0123456789'],
  ['google api key', 'gemini AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW', 'AIzaSyA1b2C3d4E5f6G7h8'],
  ['stripe live key', 'STRIPE sk_live_51H8xYzAbCdEf0123456789', 'sk_live_51H8xYzAbCdEf'],
  ['stripe restricted key', 'rk_live_51H8xYzAbCdEf0123456789', 'rk_live_51H8xYz'],
  ['github classic token', 'ghp_AbCdEf0123456789AbCdEf0123456789AbCd', 'ghp_AbCdEf0123456789'],
  ['github fine-grained', 'github_pat_11AbCdEf0123456789_AbCdEf0123456789AbCdEf', 'github_pat_11AbCdEf'],
  ['gitlab token', 'glpat-AbCdEf0123456789AbCd', 'glpat-AbCdEf0123456789'],
  ['npm token', '//registry.npmjs.org/:_authToken=npm_AbCdEf0123456789AbCdEf0123456789AbCd', 'npm_AbCdEf0123456789'],
  ['hugging face token', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'hf_AbCdEfGhIjKlMnOp'],
  ['slack bot token', 'xoxb-123456789012-1234567890123-AbCdEf0123456789', 'xoxb-123456789012'],
  ['slack webhook', 'https://hooks.slack.com/services/T0000/B0000/AbCdEf0123456789AbCd', 'AbCdEf0123456789AbCd'],
  ['sendgrid key', 'SG.AbCdEf0123456789AbCd.AbCdEf0123456789AbCdEf0123456789AbCdEf01234', 'AbCdEf0123456789AbCdEf0123456789'],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['aws secret in config', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N'],
  ['bearer header', 'Authorization: Bearer abcdef0123456789abcdef0123456789', 'abcdef0123456789abcdef'],
  ['basic auth header', 'Authorization: Basic dXNlcjpodW50ZXIyaHVudGVyMg==', 'dXNlcjpodW50ZXIy'],
  ['x-api-key header', 'x-api-key: 7f3a9c2e5b1d4f6a8c0e2b4d6f8a0c2e', '7f3a9c2e5b1d4f6a'],
  ['json apiKey', '{"apiKey": "7f3a9c2e5b1d4f6a8c0e2b4d6f8a0c2e"}', '7f3a9c2e5b1d4f6a'],
  ['json password', '{"password":"hunter2hunter2"}', 'hunter2hunter2'],
  ['js object secret', "const cfg = { clientSecret: 'Zx9Yw8Vu7Ts6Rq5Po4' }", 'Zx9Yw8Vu7Ts6Rq5Po4'],
  ['env file', 'DB_PASSWORD=s3cr3t-P@ss', 's3cr3t-P@ss'],
  ['yaml', 'stripe_secret_key: whsec_AbCdEf0123456789', 'whsec_AbCdEf0123456789'],
  ['postgres url', 'DATABASE_URL=postgres://app:Pa55w0rd!@db.internal:5432/app', 'Pa55w0rd!'],
  ['mongodb srv url', 'mongodb+srv://admin:Pa55w0rd@cluster0.abcde.mongodb.net/test', 'Pa55w0rd'],
  ['azure storage', 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=AbCdEf0123456789AbCdEf0123456789==;EndpointSuffix=core.windows.net', 'AbCdEf0123456789AbCdEf'],
  ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA'],
];

const SAFE = [
  'Fix the retry test in billing.js',
  'postgres://db.local/app',
  'The token bucket refills every second; see src/rate-limit.ts',
  'Run npm test, then git push origin main',
  'Rename passwordField to passwordInput in LoginForm.tsx',
  'const sk = skip ? 1 : 0;',
  'commit 3f2a9c1e5b7d and branch feature/sk-123-login',
  'https://github.com/MHRabea/tagteam/issues/12',
  'If the session token expires, call refresh() again.',
];

for (const [label, text, secret] of LEAKS) {
  test(`redacts: ${label}`, () => {
    const out = redact(text);
    assert.ok(!out.includes(secret), `leaked in: ${out}`);
    assert.match(out, /\[REDACTED\]/);
  });
}

// Known, accepted false positive: any value assigned to a secret-looking name is hidden,
// e.g. `API_KEY_HEADER = "x-api-key"`. Hiding a constant costs little; leaking a key costs a lot.
test('keeps ordinary coding text', () => {
  for (const s of SAFE) assert.equal(redact(s), s);
});

test('redacts inside nested handoff objects', () => {
  const h = redactDeep({ known_issues: ['curl -H "x-api-key: 7f3a9c2e5b1d4f6a8c0e2b4d6f8a0c2e"'], tests: { notes: 'sk-proj-AbCdEf0123456789AbCdEf0123456789' } });
  assert.ok(!JSON.stringify(h).includes('7f3a9c2e5b1d'));
  assert.ok(!JSON.stringify(h).includes('sk-proj-AbCd'));
});

test('redaction is idempotent', () => {
  for (const [, text] of LEAKS) assert.equal(redact(redact(text)), redact(text));
});
