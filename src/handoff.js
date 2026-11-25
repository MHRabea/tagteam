// Handoff model: capture, drift + guardrail checks, and the context pack rendered for agents.
import { z } from 'zod';
import * as store from './store.js';
import { gitState, isAncestor, commitsSince, filesChangedSince } from './git.js';
import { redactDeep } from './redact.js';

const strList = z.array(z.string()).default([]);

// Raw zod shape: reused as the MCP save_handoff input schema.
export const handoffFields = {
  task: z
    .object({ title: z.string(), goal: z.string().optional(), acceptance: strList })
    .describe('The task being worked on'),
  completed: strList.describe('Concrete steps finished in this session'),
  in_progress: strList.describe('Work started but not finished'),
  next_action: z.string().describe('The single next concrete step, specific enough to start without re-reading the session'),
  known_issues: strList.describe('Failing tests, errors, open questions'),
  tests: z
    .object({
      command: z.string().optional(),
      result: z.enum(['pass', 'fail', 'not_run']),
      notes: z.string().optional(),
    })
    .optional(),
  decisions: z
    .array(z.object({ decision: z.string(), why: z.string().optional() }))
    .default([])
    .describe('New architecture or design decisions made this session'),
  constraints: z
    .array(z.object({ text: z.string(), paths: z.array(z.string()).optional() }))
    .default([])
    .describe('New user rules that must not be broken; paths are globs the rule protects'),
};
export const HandoffInput = z.object(handoffFields);

const AGENT_KEYS = ['task', 'completed', 'in_progress', 'next_action', 'known_issues', 'tests'];

export const newId = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

// Auto handoffs carry the last agent-written fields forward and remember the git
// state those fields were written against (fields_git), so drift is measured from there.
// source: 'agent' (agent wrote it), 'summary' (tagteam summarizer wrote it), 'auto' (mechanical: git + messages only).
export function buildHandoff({ source, reason, agent, session_id, fields, git, recent_user_messages, transcript_path, prev }) {
  const now = new Date();
  const h = {
    id: newId(now),
    created_at: now.toISOString(),
    source,
    reason,
    agent: agent || 'unknown',
    session_id: session_id || null,
  };
  if (source !== 'auto') {
    for (const k of AGENT_KEYS) if (fields?.[k] !== undefined) h[k] = fields[k];
  } else if (prev) {
    for (const k of AGENT_KEYS) if (prev[k] !== undefined) h[k] = prev[k];
    if (prev.source !== 'auto') {
      h.carried_from = prev.id;
      h.fields_at = prev.created_at;
      h.fields_git = prev.git;
    } else if (prev.carried_from) {
      h.carried_from = prev.carried_from;
      h.fields_at = prev.fields_at;
      h.fields_git = prev.fields_git;
    }
  }
  h.git = git;
  if (recent_user_messages?.length) h.recent_user_messages = recent_user_messages;
  if (transcript_path) h.transcript_path = transcript_path;
  return h;
}

export function capture(root, { source = 'auto', reason = 'manual', agent, session_id, fields, recent_user_messages, transcript_path } = {}) {
  const git = gitState(root); // outside the lock: git can take a while on big repos
  return store.withLock(root, () => {
    const clean = redactDeep(
      buildHandoff({ source, reason, agent, session_id, fields, git, recent_user_messages, transcript_path, prev: store.latestHandoff(root) }),
    );
    const saved = store.saveHandoff(root, clean);
    const date = clean.created_at.slice(0, 10);
    for (const d of fields?.decisions ?? []) store.addDecision(root, redactDeep({ date, ...d }));
    for (const c of fields?.constraints ?? []) store.addConstraint(root, redactDeep(c));
    return saved;
  });
}

const short = (sha) => (sha ? sha.slice(0, 7) : 'none');
const list = (items, max = 8) => items.slice(0, max).join(', ') + (items.length > max ? ` (+${items.length - max} more)` : '');

// Compare the git state a handoff was written against with the live repo.
export function computeDrift(root, h, now, at = Date.now()) {
  const base = h.fields_git || h.git;
  if (!base) return [];
  const w = [];
  if (base.branch !== now.branch) w.push(`Branch changed: handoff was on "${base.branch}", now on "${now.branch}".`);
  if (base.head && now.head && base.head !== now.head) {
    if (!isAncestor(root, base.head)) {
      w.push(`HEAD is ${short(now.head)} and the handoff commit ${short(base.head)} is not in its history (rebase, reset or branch switch).`);
    } else {
      const n = commitsSince(root, base.head);
      const files = filesChangedSince(root, base.head) ?? [];
      w.push(`${n} new commit(s) since the handoff, touching ${files.length} file(s)${files.length ? `: ${list(files)}` : ''}.`);
    }
  } else if (!base.head && now.head) {
    w.push('Commits were made since the handoff (repo had no commits then).');
  }
  const was = new Set(base.dirty_files);
  const is = new Set(now.dirty_files);
  const added = now.dirty_files.filter((f) => !was.has(f));
  const gone = base.dirty_files.filter((f) => !is.has(f));
  // diff_hash is relative to HEAD, so it only proves a change while HEAD is unchanged.
  if (added.length || gone.length || (base.head === now.head && base.diff_hash !== now.diff_hash)) {
    let msg = 'Uncommitted changes differ from the handoff.';
    if (added.length) msg += ` Newly modified: ${list(added)}.`;
    if (gone.length) msg += ` No longer modified: ${list(gone)}.`;
    w.push(msg);
  }
  const days = Math.floor((at - Date.parse(h.fields_at || h.created_at)) / 86_400_000);
  if (days >= 1) w.push(`Handoff summary is ${days} day(s) old.`);
  return w;
}

export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// A path without glob characters protects itself and everything under it.
export function matchesPath(pattern, file) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const f = file.replace(/\\/g, '/');
  if (!/[*?]/.test(p)) return f === p || f.startsWith(`${p}/`);
  return globToRegExp(p).test(f);
}

export function checkGuardrails(constraints, files) {
  return constraints
    .filter((c) => c.paths?.length)
    .map((c) => ({ constraint: c.text, files: files.filter((f) => c.paths.some((p) => matchesPath(p, f))) }))
    .filter((v) => v.files.length);
}

// Files touched since the handoff: committed since its HEAD plus current uncommitted changes.
export function touchedFiles(root, h, now) {
  const base = h?.fields_git || h?.git;
  const committed = base?.head && base.head !== now.head ? filesChangedSince(root, base.head) ?? [] : [];
  return [...new Set([...committed, ...now.dirty_files])];
}

const bullets = (items) => items.map((x) => `- ${x}`).join('\n');

export function renderHandoff(h) {
  const out = [];
  if (h.task) {
    out.push(`## Current task: ${h.task.title}`);
    if (h.task.goal) out.push(`Goal: ${h.task.goal}`);
    if (h.task.acceptance?.length) out.push(`Acceptance:\n${bullets(h.task.acceptance)}`);
  }
  if (h.completed?.length) out.push(`### Completed\n${bullets(h.completed)}`);
  if (h.in_progress?.length) out.push(`### In progress\n${bullets(h.in_progress)}`);
  if (h.next_action) out.push(`### Next action\n${h.next_action}`);
  if (h.known_issues?.length) out.push(`### Known issues\n${bullets(h.known_issues)}`);
  if (h.tests) {
    const t = h.tests;
    out.push(`### Tests\n${t.result}${t.command ? ` — \`${t.command}\`` : ''}${t.notes ? `\n${t.notes}` : ''}`);
  }
  const g = h.git;
  if (g) {
    const dirty = g.dirty_files.length ? `, uncommitted: ${list(g.dirty_files)}` : ', clean tree';
    out.push(`### Git at save\n${g.branch ?? 'no branch'} @ ${short(g.head)}${dirty}${g.diff_stat ? ` (${g.diff_stat})` : ''}`);
  }
  if (h.recent_user_messages?.length) {
    out.push(`### Last user messages (auto capture)\n${bullets(h.recent_user_messages.map((m) => m.replace(/\s+/g, ' ')))}`);
  }
  const by = h.carried_from ? `task fields from ${h.carried_from}` : `${h.source}, ${h.agent}`;
  out.push(`_Handoff ${h.id} (${h.reason}; ${by})_`);
  return out.join('\n\n');
}

export function contextPack(root) {
  const h = store.latestHandoff(root);
  const now = gitState(root);
  const constraints = store.readConstraints(root);
  const decisions = store.readDecisions(root);
  const memory = store.readMemory(root).trim();
  const drift = h ? computeDrift(root, h, now) : [];
  const guard = checkGuardrails(constraints, touchedFiles(root, h, now));

  const out = [];
  if (drift.length) out.push(`## ⚠ Drift since handoff — verify before trusting it\n${bullets(drift)}`);
  if (guard.length) {
    out.push(`## ⚠ Guardrail warnings\n${bullets(guard.map((g) => `"${g.constraint}" — touched: ${list(g.files)}`))}`);
  }
  if (constraints.length) {
    out.push(`## Constraints (do not violate)\n${bullets(constraints.map((c) => c.text + (c.paths?.length ? ` [${c.paths.join(', ')}]` : '')))}`);
  }
  if (h) out.push(renderHandoff(h));
  if (decisions.length) {
    out.push(`## Recent decisions\n${bullets(decisions.slice(-10).map((d) => `${d.date}: ${d.decision}${d.why ? ` — ${d.why}` : ''}`))}`);
  }
  if (memory && memory !== store.MEMORY_TEMPLATE.trim()) out.push(memory);
  if (!out.length) return '';
  out.unshift('# Session context (tagteam)');
  out.push('Before you stop, save a handoff with /handoff (or the tagteam MCP tool save_handoff).');
  return out.join('\n\n') + '\n';
}

export function statusReport(root) {
  const h = store.latestHandoff(root);
  const now = gitState(root);
  const drift = h ? computeDrift(root, h, now) : [];
  const guard = checkGuardrails(store.readConstraints(root), touchedFiles(root, h, now));
  const out = [h ? `Latest handoff: ${h.id} (${h.source}, ${h.reason})` : 'No handoff saved yet.'];
  out.push(drift.length ? `Drift:\n${bullets(drift)}` : h ? 'Drift: none' : '');
  out.push(guard.length ? `Guardrails:\n${bullets(guard.map((g) => `"${g.constraint}" — touched: ${list(g.files)}`))}` : 'Guardrails: ok');
  return { text: out.filter(Boolean).join('\n'), ok: !drift.length && !guard.length };
}
