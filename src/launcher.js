// `tagteam run`: start an agent with the saved context, make sure a handoff exists when it exits,
// then offer the next profile in the chain. Nothing is written into the user's repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { home, projectId, latestHandoff, writeJson, writeFile } from './store.js';
import { gitState } from './git.js';
import { capture, contextPack } from './handoff.js';
import { mergeHook, HOOKS } from './install.js';
import { readConfig, decryptKey, needsKey } from './profiles.js';
import { readTranscript, recentUserMessages, findCodexTranscript } from './transcript.js';
import { summarize } from './summarize.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/handoff.md', import.meta.url));
export const SKILL = fileURLToPath(new URL('../templates/skill/SKILL.md', import.meta.url));
const toml = (s) => JSON.stringify(s); // a JSON string is a valid TOML basic string

const CLAUDE_START = 'Continue the task from the tagteam session context. Check any drift warnings against the code first. Run /handoff before you stop.';
const SAVE_FIELDS =
  'task {title, goal, acceptance[]}, completed[], in_progress[], next_action, known_issues[], tests {command, result: pass|fail|not_run}, decisions[{decision, why}], constraints[{text, paths[]}]';
// Instructions appended to the context for agents without hooks. Without MCP the agent saves through the CLI.
const footer = (viaMcp, agent) => `---
You are continuing work in this repo. The context above comes from tagteam (session continuity).
Never break the listed constraints. If drift is listed, verify the handoff against the code first. Then continue with the next action.
Before you finish, save a handoff: ${
  viaMcp
    ? 'call the tagteam MCP tool save_handoff with what you did and the next action.'
    : `pipe a JSON object to \`tagteam capture --json --agent ${agent}\` with fields: ${SAVE_FIELDS}.`
}`;

// Windows: npm installs agents as .cmd shims, which Node cannot spawn without a shell.
// Run the shim's JS entry with node instead, so arguments (the context prompt) need no shell quoting.
export function resolveCommand(name) {
  if (process.platform !== 'win32') {
    const found = (process.env.PATH || '').split(path.delimiter).filter(Boolean).some((d) => {
      try {
        fs.accessSync(path.join(d, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (!found) throw new Error(`"${name}" is not installed or not on PATH.`);
    return { cmd: name, pre: [] };
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, `${name}.exe`);
    if (fs.existsSync(exe)) return { cmd: exe, pre: [] };
    const shim = path.join(dir, `${name}.cmd`);
    if (fs.existsSync(shim)) {
      // npm shims point at a JS entry (run with node) or a native .exe (run directly).
      // The entry is the last quoted %dp0% path; standard shims mention "%dp0%\node.exe" first.
      const m = [...fs.readFileSync(shim, 'utf8').matchAll(/"%dp0%\\([^"]+?\.(js|exe))"/gi)].at(-1);
      if (m?.[2].toLowerCase() === 'exe') return { cmd: path.join(dir, m[1]), pre: [] };
      if (m) return { cmd: process.execPath, pre: [path.join(dir, m[1])] };
    }
  }
  throw new Error(`"${name}" is not installed or not on PATH.`);
}

function teamEnv(root) {
  return { TAGTEAM_ROOT: root, ...(process.env.TAGTEAM_HOME ? { TAGTEAM_HOME: process.env.TAGTEAM_HOME } : {}) };
}

// Hooks + MCP for Claude Code passed with --settings / --mcp-config instead of files in the repo.
// Hook commands match `tagteam install claude`, so Claude Code de-duplicates them if both are present.
export function claudeRuntime(root) {
  const dir = path.join(home(), 'runtime');
  const settings = path.join(dir, 'claude-settings.json');
  const s = {};
  for (const [event, matcher, command] of HOOKS) mergeHook(s, event, matcher, command);
  writeJson(settings, s);
  const mcp = path.join(dir, `claude-mcp-${projectId(root)}.json`);
  writeJson(mcp, { mcpServers: { tagteam: { command: process.execPath, args: [CLI, 'mcp'], env: teamEnv(root) } } });

  // The /handoff command and the tagteam skill live at user level, so they work in every repo
  // and nothing is written into the user's repo.
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  installUserFile(path.join(config, 'commands', 'handoff.md'), TEMPLATE, 'tagteam capture --json');
  installUserFile(path.join(config, 'skills', 'tagteam', 'SKILL.md'), SKILL, 'name: tagteam');
  return { settings, mcp };
}

// Write our template unless the user has their own file there: replace only a file that carries our marker.
export function installUserFile(file, template, marker) {
  const ours = fs.readFileSync(template, 'utf8');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === null || (existing !== ours && existing.includes(marker))) writeFile(file, ours);
}

// Drop variables inherited from a parent agent session (tagteam run inside a Claude Code terminal):
// nested-session markers always, and Anthropic auth/endpoint vars when the profile brings its own.
export function cleanEnv(base, p) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k)) continue;
    if (p.keyEnv && /^ANTHROPIC_/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function buildLaunch(p, root, key, name = p.agent) {
  const env = { ...cleanEnv(process.env, p), ...p.env, ...teamEnv(root) };
  const pack = contextPack(root);
  const hasTask = Boolean(latestHandoff(root)?.task);

  if (p.agent === 'claude') {
    if (p.keyEnv) env[p.keyEnv] = key;
    const rt = claudeRuntime(root);
    const args = ['--settings', rt.settings, '--mcp-config', rt.mcp];
    if (p.model) args.push('--model', p.model);
    if (hasTask) args.push(CLAUDE_START);
    return { ...resolveCommand('claude'), args, env };
  }

  if (p.agent === 'codex') {
    const args = [];
    const c = (kv) => args.push('-c', kv);
    if (p.provider) {
      env.TAGTEAM_PROVIDER_KEY = key;
      c('model_provider="tagteam"');
      c('model_providers.tagteam.name="tagteam"');
      c(`model_providers.tagteam.base_url=${toml(p.provider.base_url)}`);
      c('model_providers.tagteam.env_key="TAGTEAM_PROVIDER_KEY"');
      c(`model_providers.tagteam.wire_api=${toml(p.provider.wire_api || 'responses')}`);
    }
    // mcp: false for providers that reject Codex's MCP tool format (xAI: "unknown variant namespace").
    if (p.mcp !== false) {
      c(`mcp_servers.tagteam.command=${toml(process.execPath)}`);
      c(`mcp_servers.tagteam.args=[${toml(CLI)}, "mcp"]`);
      c(`mcp_servers.tagteam.env={${Object.entries(teamEnv(root)).map(([k, v]) => `${k}=${toml(v)}`).join(', ')}}`);
    } else {
      args.push('--add-dir', home()); // let `tagteam capture` write its data from inside the sandbox
    }
    for (const f of p.codex?.disable ?? []) args.push('--disable', f);
    for (const kv of p.codex?.config ?? []) c(kv);
    if (p.model) args.push('-m', p.model);
    args.push(`${pack || 'No saved context yet for this repo.'}\n\n${footer(p.mcp !== false, name)}`);
    return { ...resolveCommand('codex'), args, env };
  }

  // custom: the user's own command line; {context_file} is replaced with a file holding the context pack.
  const ctxFile = path.join(home(), 'runtime', `context-${projectId(root)}.md`);
  writeFile(ctxFile, `${pack}\n\n${footer(false, name)}\n`);
  if (p.keyEnv) env[p.keyEnv] = key;
  // The path goes through an env var, never into the command text, so no character in it can be run by the shell.
  env.TAGTEAM_CONTEXT_FILE = ctxFile;
  const ref = process.platform === 'win32' ? '"%TAGTEAM_CONTEXT_FILE%"' : '"$TAGTEAM_CONTEXT_FILE"';
  return { cmd: p.command.replaceAll('{context_file}', ref), pre: [], args: [], env, shell: true };
}

function launch(spec, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, [...spec.pre, ...spec.args], { cwd: root, env: spec.env, stdio: 'inherit', shell: spec.shell ?? false });
    // Ctrl+C belongs to the agent while it runs.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    child.on('error', (e) => {
      process.off('SIGINT', ignore);
      reject(e);
    });
    child.on('exit', (code) => {
      process.off('SIGINT', ignore);
      resolve(code ?? 0);
    });
  });
}

// Order to try summarizers in. The profile that just stopped goes last: it may be rate limited or out of credit.
export function summarizerOrder(cfg, current) {
  const summaryOnly = Object.keys(cfg.profiles).filter((n) => cfg.profiles[n].agent === 'none');
  const order = [cfg.summarizer, ...cfg.chain.filter((n) => n !== current), ...summaryOnly, current];
  return [...new Set(order)].filter((n) => n && cfg.profiles[n]?.api && cfg.profiles[n]?.key);
}

// Did the agent itself save a handoff during this run (directly, or carried into a later auto save)?
export function agentSavedSince(h, started) {
  if (!h) return false;
  if (h.source !== 'auto') return Date.parse(h.created_at) >= started;
  return Boolean(h.fields_at && Date.parse(h.fields_at) >= started);
}

export async function ensureHandoff(root, { name, p, started, summary, cfg, log = console.log }) {
  const latest = latestHandoff(root);
  if (agentSavedSince(latest, started) && latest.source !== 'summary') {
    log(`✓ tagteam: the agent saved handoff ${latest.carried_from || latest.id}`);
    return latest;
  }
  const fresh = latest && Date.parse(latest.created_at) >= started;
  const tp = p.agent === 'claude' ? (fresh ? latest.transcript_path : null) : p.agent === 'codex' ? findCodexTranscript(started) : null;
  const transcript = tp ? readTranscript(tp) : [];
  const hasWork = transcript.length || gitState(root).dirty_files.length;

  for (const s of summary && hasWork ? summarizerOrder(cfg, name) : []) {
    const { api, key } = cfg.profiles[s];
    log(`… tagteam: writing the handoff with ${s} (sends the redacted transcript and diff; turn off with --no-summary)`);
    try {
      const fields = await summarize({ api, key: decryptKey(key), root, transcript, prev: latest });
      const h = capture(root, { source: 'summary', reason: 'switch', agent: `${name} (summary: ${s})`, fields, transcript_path: tp });
      log(`✓ tagteam: handoff ${h.id} saved. Next: ${h.next_action}`);
      return h;
    } catch (e) {
      log(`! tagteam: ${s} failed (${e.message.slice(0, 160)}). Trying the next one.`);
    }
  }
  const h = capture(root, { source: 'auto', reason: 'switch', agent: name, recent_user_messages: tp ? recentUserMessages(tp) : undefined, transcript_path: tp });
  log(`✓ tagteam: handoff ${h.id} saved (git state${tp ? ' + last messages' : ''}).`);
  return h;
}

export const nextInChain = (chain, current) => (chain.length ? chain[(chain.indexOf(current) + 1) % chain.length] : null);

async function askNext(cfg, next) {
  if (!process.stdin.isTTY || !next) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const agents = Object.keys(cfg.profiles).filter((n) => cfg.profiles[n].agent !== 'none');
  const a = (await rl.question(`\nContinue with "${next}"? [Enter = yes · n = stop · or type a profile: ${agents.join(', ')}] `)).trim();
  rl.close();
  if (!a) return next;
  if (/^(n|no|q|quit|stop)$/i.test(a)) return null;
  if (agents.includes(a)) return a;
  console.log(`Unknown profile "${a}". Stopping.`);
  return null;
}

// ask and log are replaceable so the whole loop can run under test without a terminal.
export async function run(root, { profile, summary = true, ask = askNext, log = console.log } = {}) {
  const cfg = readConfig();
  if (!Object.keys(cfg.profiles).length) throw new Error('No profiles yet. Start with: tagteam profile add claude');
  let name = profile || cfg.chain[0];
  while (name) {
    const p = cfg.profiles[name];
    if (!p) throw new Error(`No profile named "${name}". See: tagteam profile list`);
    if (p.agent === 'none') throw new Error(`"${name}" is a summarizer-only profile; it cannot run as an agent.`);
    const key = needsKey(p) ? decryptKey(p.key) : null;
    if (needsKey(p) && !key) throw new Error(`Profile "${name}" has no API key. Run: tagteam profile add ${name} --key`);

    const started = Date.now();
    log(`\n▶ tagteam: starting ${name} (${p.agent}) in ${root}`);
    const code = await launch(buildLaunch(p, root, key, name), root);
    log(`\n■ tagteam: ${name} exited (code ${code}).`);
    await ensureHandoff(root, { name, p, started, summary, cfg, log });
    name = await ask(cfg, nextInChain(cfg.chain, name));
  }
}
