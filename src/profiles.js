// Agent profiles: which agent binary to run, with which provider env, and an encrypted API key.
// Subscription logins stay in the agent's own native flow; tagteam never reads or stores them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { home, readJson, writeJson } from './store.js';

// api: what the summarizer calls with the same key. format: 'anthropic' | 'openai' (chat completions).
export const PRESETS = {
  claude: { agent: 'claude', note: 'Claude Code with your normal login (no key stored)' },
  'claude-api': {
    agent: 'claude',
    keyEnv: 'ANTHROPIC_API_KEY',
    api: { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
  },
  deepseek: {
    agent: 'claude',
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    // Values from DeepSeek's "Integrate with Claude Code" guide.
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
    },
    api: { format: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  },
  // Codex with its own login (ChatGPT plan or `codex login`); no key stored.
  codex: { agent: 'codex' },
  openai: {
    agent: 'codex',
    provider: { base_url: 'https://api.openai.com/v1', wire_api: 'responses' },
    api: { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
  },
  // Summarizer only. Tested 2026-11 as an agent and failed: Claude Code 2.1.330 on xAI /v1/messages
  // ("Invalid message role"), Codex 0.172 on xAI Responses (namespace tools, web_search args, encrypted compaction).
  grok: {
    agent: 'none',
    api: { format: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.20-0309-non-reasoning' },
  },
  // Summarizer only: writes handoffs, never launched as an agent.
  gemini: {
    agent: 'none',
    api: { format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest' },
  },
};

export const AGENTS = ['claude', 'codex', 'custom', 'none'];
export const needsKey = (p) => Boolean(p.keyEnv || p.provider || p.agent === 'none');

const file = () => path.join(home(), 'profiles.json');
export const readConfig = () => readJson(file(), { profiles: {}, chain: [] });
export function writeConfig(cfg) {
  writeJson(file(), cfg);
  if (process.platform !== 'win32') fs.chmodSync(file(), 0o600);
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function buildProfile(name, opts = {}) {
  if (!NAME.test(name)) throw new Error(`Invalid profile name: ${name}`);
  const preset = PRESETS[opts.preset || name];
  if (opts.preset && !preset) throw new Error(`Unknown preset: ${opts.preset}. Presets: ${Object.keys(PRESETS).join(', ')}`);
  const p = structuredClone(preset ?? {});
  delete p.note;
  if (opts.agent) p.agent = opts.agent;
  if (!p.agent) throw new Error('Pass --agent claude|codex|custom|none (or use a preset name).');
  if (!AGENTS.includes(p.agent)) throw new Error(`Unknown agent: ${p.agent}`);
  if (opts.model) p.model = opts.model;
  if (opts.baseUrl) {
    if (p.agent === 'claude') {
      p.env = { ...p.env, ANTHROPIC_BASE_URL: opts.baseUrl };
      p.keyEnv ??= 'ANTHROPIC_AUTH_TOKEN';
    } else if (p.agent === 'codex') p.provider = { wire_api: 'responses', ...p.provider, base_url: opts.baseUrl };
  }
  if (opts.command) p.command = opts.command;
  if (p.agent === 'custom' && !p.command) throw new Error('A custom profile needs --command "<agent command>".');
  if (opts.summaryModel && p.api) p.api.model = opts.summaryModel;
  return p;
}

export function saveProfile(name, profile, key) {
  const cfg = readConfig();
  if (key) profile.key = encryptKey(key, name);
  else if (cfg.profiles[name]?.key) profile.key = cfg.profiles[name].key; // re-adding keeps the stored key
  cfg.profiles[name] = profile;
  if (profile.agent !== 'none' && !cfg.chain.includes(name)) cfg.chain.push(name);
  writeConfig(cfg);
  return profile;
}

export function removeProfile(name) {
  const cfg = readConfig();
  if (!cfg.profiles[name]) throw new Error(`No profile named ${name}`);
  deleteKey(cfg.profiles[name].key);
  delete cfg.profiles[name];
  cfg.chain = cfg.chain.filter((n) => n !== name);
  writeConfig(cfg);
}

export function setChain(names) {
  const cfg = readConfig();
  const missing = names.filter((n) => !cfg.profiles[n]);
  if (missing.length) throw new Error(`Unknown profile(s): ${missing.join(', ')}`);
  const summaryOnly = names.filter((n) => cfg.profiles[n].agent === 'none');
  if (summaryOnly.length) throw new Error(`Summarizer-only profile(s) cannot be in the chain: ${summaryOnly.join(', ')}`);
  cfg.chain = names;
  writeConfig(cfg);
}

// --- Key storage -----------------------------------------------------------
// profiles.json holds only a reference or ciphertext, never a plain key:
//   dpapi:<base64>        Windows DPAPI (CurrentUser): only this Windows user can decrypt
//   keychain:<account>    macOS login Keychain (service "tagteam")
//   secret:<account>      Linux Secret Service via secret-tool (GNOME Keyring, KWallet)
//   plain:<key>           only when TAGTEAM_KEY_STORE=plain is set (CI, containers without a keyring)
// Keys travel over stdin, never argv, so they never show up in process listings.
const SERVICE = 'tagteam';
export const keyStore = {
  run: (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
};

export function keyBackend(platform = process.platform) {
  const forced = process.env.TAGTEAM_KEY_STORE;
  if (forced) {
    if (!['dpapi', 'keychain', 'secret', 'plain'].includes(forced)) throw new Error(`Unknown TAGTEAM_KEY_STORE: ${forced}`);
    return forced;
  }
  return { win32: 'dpapi', darwin: 'keychain', linux: 'secret' }[platform] ?? null;
}

const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const PS_PROTECT =
  'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,"CurrentUser"))';
const PS_UNPROTECT =
  'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,"CurrentUser"))';
const ps = (script, input) => keyStore.run('powershell.exe', [...PS, script], input).trim();

// The Keychain account: unique per profile and per tagteam home, so test homes never touch real keys.
const account = (name) => `${name}@${createHash('sha1').update(home()).digest('hex').slice(0, 8)}`;
// `security -i` reads one command per line from stdin; API keys are printable ASCII without quotes.
const securityQuote = (v) => {
  if (!/^[!-~]+$/.test(v) || /["\\]/.test(v)) throw new Error('This key has characters the macOS Keychain command line cannot take (spaces, quotes or backslashes).');
  return `"${v}"`;
};

const missingTool = (tool, e) =>
  e.code === 'ENOENT' ? new Error(`${tool} was not found. Install it, or set TAGTEAM_KEY_STORE=plain to store keys unencrypted (not recommended).`) : e;

export function encryptKey(key, name = 'default') {
  const backend = keyBackend();
  if (backend === 'dpapi') return `dpapi:${ps(PS_PROTECT, key)}`;
  if (backend === 'plain') return `plain:${key}`;
  const acct = account(name);
  try {
    if (backend === 'keychain') {
      keyStore.run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${securityQuote(acct)} -w ${securityQuote(key)}\n`);
      return `keychain:${acct}`;
    }
    if (backend === 'secret') {
      keyStore.run('secret-tool', ['store', `--label=tagteam ${name}`, 'service', SERVICE, 'account', acct], key);
      return `secret:${acct}`;
    }
  } catch (e) {
    throw missingTool(backend === 'keychain' ? 'security' : 'secret-tool (libsecret-tools)', e);
  }
  throw new Error(`No key store for ${process.platform}. Set TAGTEAM_KEY_STORE=plain to store keys unencrypted (not recommended).`);
}

export function decryptKey(stored) {
  if (!stored) return null;
  const i = stored.indexOf(':');
  const [kind, value] = [stored.slice(0, i), stored.slice(i + 1)];
  if (kind === 'dpapi') return ps(PS_UNPROTECT, value);
  if (kind === 'plain') return value;
  try {
    if (kind === 'keychain') return keyStore.run('security', ['find-generic-password', '-s', SERVICE, '-a', value, '-w'], '').trim() || null;
    if (kind === 'secret') return keyStore.run('secret-tool', ['lookup', 'service', SERVICE, 'account', value], '').trim() || null;
  } catch (e) {
    if (e.code === 'ENOENT') throw missingTool(kind === 'keychain' ? 'security' : 'secret-tool', e);
    return null; // entry deleted from the keychain: same as no key
  }
  throw new Error('Unknown key format in profiles.json');
}

// Remove a key from the OS store when its profile goes. Ciphertext and plain keys live in profiles.json only.
export function deleteKey(stored) {
  if (!stored) return;
  const value = stored.slice(stored.indexOf(':') + 1);
  try {
    if (stored.startsWith('keychain:')) keyStore.run('security', ['delete-generic-password', '-s', SERVICE, '-a', value], '');
    if (stored.startsWith('secret:')) keyStore.run('secret-tool', ['clear', 'service', SERVICE, 'account', value], '');
  } catch {} // already gone
}

// Read a secret from the terminal without echoing it.
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('No terminal for key input. Use --key-stdin and pipe the key.'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      err ? reject(err) : resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\b' || ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
