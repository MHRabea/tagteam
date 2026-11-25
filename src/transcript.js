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
