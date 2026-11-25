// `tagteam doctor`: check everything tagteam depends on, without printing any secret.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { home, isRegistered, latestHandoff, projectDir } from './store.js';
import { gitRoot, tryGit } from './git.js';
import { readConfig, decryptKey, needsKey, keyBackend } from './profiles.js';
import { resolveCommand, summarizerOrder } from './launcher.js';

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

function version(spec) {
  const r = spawnSync(spec.cmd, [...spec.pre, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0];
}

// deps lets tests replace the slow or machine-specific parts.
export function diagnose(cwd = process.cwd(), deps = {}) {
  const { resolve = resolveCommand, getVersion = version, decrypt = decryptKey } = deps;
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? OK : FAIL, 'node', `v${process.versions.node}${major >= 20 ? '' : ' (tagteam needs 20 or newer)'}`);

  const gitV = tryGit(cwd, '--version');
  add(gitV ? OK : FAIL, 'git', gitV ?? 'not found on PATH');

  try {
    fs.mkdirSync(home(), { recursive: true });
    fs.accessSync(home(), fs.constants.W_OK);
    add(OK, 'data folder', home());
  } catch (e) {
    add(FAIL, 'data folder', `${home()} is not writable (${e.code})`);
  }

  const backend = keyBackend();
  if (!backend) add(WARN, 'key store', `none for ${process.platform}; keys cannot be saved (set TAGTEAM_KEY_STORE=plain to allow unencrypted keys)`);
  else add(backend === 'plain' ? WARN : OK, 'key store', backend === 'plain' ? 'plain text (TAGTEAM_KEY_STORE=plain)' : backend);

  const root = gitV ? gitRoot(cwd) : null;
  if (!root) add(WARN, 'repo', `${cwd} is not inside a git repository`);
  else if (!isRegistered(root)) add(WARN, 'repo', `${root} is not registered yet (tagteam init, or just run tagteam)`);
  else {
    const lock = path.join(projectDir(root), '.lock');
    if (fs.existsSync(lock)) add(WARN, 'repo', `a lock file is present: ${lock} (delete it if no tagteam process is running)`);
    else {
      try {
        const h = latestHandoff(root);
        add(OK, 'repo', `${root}${h ? `, latest handoff ${h.id}` : ', no handoff yet'}`);
      } catch (e) {
        add(FAIL, 'repo', e.message);
      }
    }
  }

  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    add(FAIL, 'profiles', e.message);
    return checks;
  }
  const names = Object.keys(cfg.profiles);
  if (!names.length) add(WARN, 'profiles', 'none yet (tagteam profile add claude)');

  const versions = new Map();
  for (const n of names) {
    const p = cfg.profiles[n];
    const problems = [];
    let detail = p.agent;
    if (p.agent === 'claude' || p.agent === 'codex') {
      if (!versions.has(p.agent)) {
        try {
          versions.set(p.agent, getVersion(resolve(p.agent)) ?? 'installed (version unknown)');
        } catch (e) {
          versions.set(p.agent, null);
        }
      }
      const v = versions.get(p.agent);
      if (v) detail += ` ${v}`;
      else problems.push(`${p.agent} is not installed or not on PATH`);
    }
    if (needsKey(p)) {
      if (!p.key) problems.push(`no API key (tagteam profile add ${n} --key)`);
      else {
        try {
          if (!decrypt(p.key)) problems.push(`the stored key cannot be read (tagteam profile add ${n} --key)`);
          else detail += ', key ok';
        } catch (e) {
          problems.push(`the stored key cannot be read: ${e.message.split('\n')[0]}`);
        }
      }
    }
    add(problems.length ? FAIL : OK, `profile ${n}`, problems.length ? `${detail}: ${problems.join('; ')}` : detail);
  }

  if (names.length) {
    add(cfg.chain.length ? OK : WARN, 'chain', cfg.chain.length ? cfg.chain.join(' → ') : 'empty (tagteam chain a,b)');
    const s = summarizerOrder(cfg, null);
    add(s.length ? OK : WARN, 'summarizer', s.length ? s.join(', ') : 'none; handoffs after a limit hit will hold only git state and your last messages');
  }

  // Node's built-in fetch ignores proxy variables, so the summarizer cannot get through a corporate proxy yet.
  const proxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].find((k) => process.env[k]);
  if (proxy) add(WARN, 'proxy', `${proxy} is set, but the summarizer does not use proxies yet; it may fail behind this proxy`);
  return checks;
}

const ICON = { [OK]: '✓', [WARN]: '!', [FAIL]: '✗' };

export function printDoctor(checks, log = console.log) {
  for (const c of checks) log(`${ICON[c.status]} ${c.name.padEnd(18)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === FAIL).length;
  const warns = checks.filter((c) => c.status === WARN).length;
  log(`\n${fails ? `${fails} problem(s)` : 'No problems'}${warns ? `, ${warns} warning(s)` : ''}.`);
  return fails ? 1 : 0;
}
