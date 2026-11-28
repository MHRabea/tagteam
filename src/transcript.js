// Read agent transcripts (Claude Code and Codex JSONL) into [{ role, text }]. No LLM needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Harness-injected text (slash-command wrappers, reminders, Codex environment context).
const WRAPPER = /^<(command-|local-command|system-reminder|user-prompt-submit-hook|bash-|environment_context|user_instructions|turn_aborted)/;

const partsText = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((p) => ['text', 'input_text', 'output_text'].includes(p.type)).map((p) => p.text).join('\n')
      : '';

function entry(e) {
  // Claude Code: { type: 'user'|'assistant', message: { role, content } }
  if ((e.type === 'user' || e.type === 'assistant') && e.message) {
    if (e.isMeta || e.isCompactSummary || e.isSidechain) return null;
    return { role: e.message.role, text: partsText(e.message.content) };
  }
  // Codex rollout: { type: 'response_item', payload: { type: 'message', role, content } } (older files: no wrapper)
  const m = e.type === 'response_item' ? e.payload : e;
  if (m?.type === 'message' && (m.role === 'user' || m.role === 'assistant')) return { role: m.role, text: partsText(m.content) };
  return null;
}

export function readTranscript(file) {
  let text;
  try {
    // shortcut: reads the whole transcript; stream from the end if transcripts reach hundreds of MB.
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = entry(e);
    const t = m?.text?.trim();
    if (!t || WRAPPER.test(t) || (m.role !== 'user' && m.role !== 'assistant')) continue;
    out.push({ role: m.role, text: t });
  }
  return out;
}

export function recentUserMessages(file, n = 5, max = 500) {
  return readTranscript(file)
    .filter((m) => m.role === 'user')
    .slice(-n)
    .map((m) => (m.text.length > max ? `${m.text.slice(0, max)}…` : m.text));
}

// Newest Codex rollout file written since `since` (ms). Newer Codex builds may keep history in SQLite only: then null.
export function findCodexTranscript(since) {
  const dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    if (!String(n).endsWith('.jsonl')) continue;
    const f = path.join(dir, String(n));
    const t = fs.statSync(f).mtimeMs;
    if (t >= since && (!best || t > best.t)) best = { f, t };
  }
  return best?.f ?? null;
}

// Did the session end on a usage/rate limit? Looks only at the last message the agent produced
// (Claude Code) or the last error event (Codex), so a chat that merely mentions rate limits never matches.
const LIMIT =
  /(usage limit|limit reached|(hit|reached) your (usage |weekly |daily )?limit|rate[ _-]?limit|\b429\b|credit balance is too low|insufficient[ _]quota|quota exceeded|out of credits?)/i;

export function detectLimit(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim()).slice(-40).reverse();
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex: { type: 'event_msg', payload: { type: 'error', message } }
    if (e.type === 'event_msg' && e.payload?.type === 'error') {
      const m = String(e.payload.message ?? '');
      return LIMIT.test(m) ? m.slice(0, 200) : null;
    }
    if (e.type === 'assistant' && e.message && !e.isSidechain) {
      const t = partsText(e.message.content).trim();
      if (!t) continue; // tool-use only turn: keep looking back for the last text
      return LIMIT.test(t) && (e.isApiErrorMessage || t.length < 300) ? t.slice(0, 200) : null;
    }
    if (e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'assistant') return null;
  }
  return null;
}
