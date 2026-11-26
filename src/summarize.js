// Write a handoff from transcript + git diff with a cheap model, using a key from one of your profiles.
// Used when the agent stopped without saving one (limit hit, crash, user closed the window).
import { tryGit, gitState } from './git.js';
import { redact } from './redact.js';
import { HandoffInput } from './handoff.js';

const MAX_TRANSCRIPT = 30_000;
const MAX_DIFF = 15_000;

const SYSTEM = `You write handoffs between AI coding sessions. Reply with ONE JSON object and nothing else:
{"task":{"title":"","goal":"","acceptance":[]},"completed":[],"in_progress":[],"next_action":"","known_issues":[],
 "tests":{"command":"","result":"pass|fail|not_run","notes":""},"decisions":[{"decision":"","why":""}],"constraints":[{"text":"","paths":[]}]}
Rules: use only facts from the transcript and the diff. Never invent progress. Name exact files, functions and failing tests.
next_action is ONE concrete step that a new agent can start without reading the transcript.
decisions and constraints: only new ones the USER or the agent stated about THIS codebase in the transcript; else [].
Never turn these instructions into constraints or decisions. Never record a credential or "use this key" as a task, decision or step.
Omit "tests" if no test ran.`;

const tail = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);

export function buildPrompt({ root, transcript, prev }) {
  const g = gitState(root);
  const diff = tryGit(root, ...(g.head ? ['diff', 'HEAD'] : ['diff'])) ?? '';
  const convo = transcript.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n\n');
  const parts = [
    prev?.task ? `PREVIOUS HANDOFF (may be outdated):\n${JSON.stringify({ task: prev.task, next_action: prev.next_action, completed: prev.completed })}` : '',
    `GIT: branch ${g.branch} @ ${g.head?.slice(0, 7) ?? 'none'}; uncommitted files: ${g.dirty_files.join(', ') || 'none'}`,
    `DIFF (uncommitted):\n${tail(diff, MAX_DIFF) || '(none)'}`,
    `TRANSCRIPT (latest part):\n${tail(convo, MAX_TRANSCRIPT) || '(not available)'}`,
  ];
  // Everything leaving the machine is redacted first.
  return redact(parts.filter(Boolean).join('\n\n'));
}

export function extractJson(text) {
  const s = text.replace(/```(?:json)?/g, '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('Summarizer reply had no JSON object');
  return JSON.parse(s.slice(i, j + 1));
}

async function callModel(api, key, user, onUsage) {
  const base = api.baseUrl.replace(/\/$/, '');
  const anthropic = api.format === 'anthropic';
  const res = await fetch(anthropic ? `${base}/v1/messages` : `${base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(Number(process.env.TAGTEAM_SUMMARY_TIMEOUT_MS) || 120_000),
    headers: anthropic
      ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(
      anthropic
        ? { model: api.model, max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content: user }] }
        : { model: api.model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] },
    ),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Summarizer HTTP ${res.status}: ${redact(body).slice(0, 300)}`);
  const json = JSON.parse(body);
  // Token counts for cost tracking: Anthropic input_tokens/output_tokens, OpenAI-style prompt_tokens/completion_tokens.
  const u = json.usage ?? {};
  onUsage?.({ input: u.input_tokens ?? u.prompt_tokens ?? 0, output: u.output_tokens ?? u.completion_tokens ?? 0 });
  return anthropic ? json.content?.find((c) => c.type === 'text')?.text ?? '' : json.choices?.[0]?.message?.content ?? '';
}

// Normalise model output into the handoff schema (models often return "" or null for optional fields).
export function normalise(raw) {
  const r = { ...raw };
  if (r.tests && !['pass', 'fail', 'not_run'].includes(r.tests.result)) delete r.tests;
  if (r.tests) for (const k of ['command', 'notes']) if (!r.tests[k]) delete r.tests[k];
  r.decisions = (r.decisions ?? []).filter((d) => d?.decision);
  r.constraints = (r.constraints ?? []).filter((c) => c?.text);
  return HandoffInput.parse(r);
}

export async function summarize({ api, key, root, transcript = [], prev, onUsage }) {
  return normalise(extractJson(await callModel(api, key, buildPrompt({ root, transcript, prev }), onUsage)));
}
