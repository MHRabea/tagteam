// Live smoke test against real providers. Never prints key values.
// Usage:
//   node scripts/smoke.mjs <env-file> models              list models per provider (verifies keys)
//   node scripts/smoke.mjs <env-file> summarize [p=model]  run the real summarizer per provider
import fs from 'node:fs';
import { redact } from '../src/redact.js';
import { summarize } from '../src/summarize.js';
import { gitRoot } from '../src/git.js';
import { PRESETS } from '../src/profiles.js';

const [envFile, mode = 'models', ...overrides] = process.argv.slice(2);
if (!envFile) throw new Error('Usage: node scripts/smoke.mjs <env-file> models|summarize [provider=model ...]');

const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}

// Same endpoints and models as the presets, so the smoke test checks what users actually get.
const fromPreset = (preset, keyVar) => ({ keyVar, ...PRESETS[preset].api });
export const PROVIDERS = {
  anthropic: fromPreset('claude-api', 'ANTHROPIC_API_KEY'),
  openai: fromPreset('openai', 'OPENAI_API_KEY'),
  deepseek: fromPreset('deepseek', 'DEEPSEEK_API_KEY'),
  gemini: fromPreset('gemini', 'GEMINI_API_KEY'),
  xai: fromPreset('grok', 'XAI_API_KEY'),
};
for (const o of overrides) {
  const [p, model] = o.split('=');
  if (PROVIDERS[p]) PROVIDERS[p].model = model;
}

const headers = (p, key) =>
  p.format === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };

async function listModels(p, key) {
  const res = await fetch(`${p.baseUrl}${p.format === 'anthropic' ? '/v1/models?limit=100' : '/models'}`, { headers: headers(p, key), signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(body).slice(0, 200)}`);
  return JSON.parse(body).data.map((m) => m.id.replace(/^models\//, ''));
}

const root = gitRoot(process.cwd()); // any git repo works: the summarizer reads its git state
if (!root) throw new Error('Run the smoke test inside a git repository.');
let failures = 0;
// $ per million tokens [input, output], for the cost line only. Anthropic: claude-haiku-5-5 list price (2026-11).
const PRICE = { anthropic: [0.1, 0.5] };
const transcript = [
  { role: 'user', text: 'Read TASK.md and do step 1 only: fix prorate in src/billing.js.' },
  { role: 'assistant', text: 'prorate() computes diff * daysInPeriod / daysLeft; it should be diff * daysLeft / daysInPeriod. I will fix it and run npm test.' },
  { role: 'user', text: 'ok, but do not touch src/gateway.js' },
];

for (const [name, p] of Object.entries(PROVIDERS)) {
  const key = env[p.keyVar];
  if (!key) {
    console.log(`- ${name.padEnd(9)} skipped (no ${p.keyVar})`);
    continue;
  }
  try {
    if (mode === 'models') {
      const ids = await listModels(p, key);
      const cheap = ids.filter((id) => /mini|flash|haiku|fast|lite/i.test(id)).slice(0, 12);
      const has = p.model ? (ids.includes(p.model) ? `preset model ${p.model} ✓` : `preset model ${p.model} NOT FOUND`) : 'no preset model';
      console.log(`✓ ${name.padEnd(9)} ${ids.length} models; ${has}\n    cheap: ${cheap.join(', ')}`);
    } else {
      if (!p.model) throw new Error('no model; pass provider=model');
      const t = Date.now();
      let usage = { input: 0, output: 0 };
      const h = await summarize({ api: p, key, root, transcript, onUsage: (u) => (usage = u) });
      const price = PRICE[name];
      const cost = price ? ` ≈ $${((usage.input * price[0] + usage.output * price[1]) / 1e6).toFixed(5)}` : '';
      console.log(`✓ ${name.padEnd(9)} ${p.model} ${((Date.now() - t) / 1000).toFixed(1)}s, ${usage.input} in / ${usage.output} out tokens${cost} → next_action: ${h.next_action}`);
    }
  } catch (e) {
    failures++;
    console.log(`✗ ${name.padEnd(9)} ${redact(e.message).slice(0, 300)}`);
  }
}
process.exitCode = failures ? 1 : 0;
