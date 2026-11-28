#!/usr/bin/env node
import { parseArgs } from 'node:util';
import * as store from './store.js';
import { gitRoot, remoteUrl } from './git.js';
import { redact } from './redact.js';
import { capture, contextPack, statusReport, renderHandoff, HandoffInput, checkRange } from './handoff.js';
import { recentUserMessages } from './transcript.js';
import { installClaude, installCodex, installCursor } from './install.js';
import { PRESETS, readConfig, buildProfile, saveProfile, removeProfile, setChain, promptHidden, needsKey } from './profiles.js';

const HELP = `tagteam — git-verified session handoffs for AI coding agents

Usage:
  tagteam                               Start the first profile of your chain here (same as tagteam run)
  tagteam run [profile] [--no-summary] [--auto-switch]
                                        Start an agent with the saved context; on exit save a handoff and offer the next
                                        profile. --auto-switch: if it stopped on a usage limit, start the next one without asking
  tagteam profile add <name> [--key] [--preset p] [--agent claude|codex|custom] [--base-url u] [--model m] [--command c]
  tagteam profile list | rm <name>      Presets: ${Object.keys(PRESETS).join(', ')}
  tagteam chain a,b,c                   Profile order used when switching

  tagteam init                         Register the current git repo
  tagteam install claude|codex|cursor   Wire tagteam into an agent for this repo
  tagteam capture [--json] [--agent n]  Save a handoff (--json: read handoff fields from stdin)
  tagteam resume                        Print the context pack (task, constraints, drift)
  tagteam status                        Drift, guardrail and completeness report (exit 2 on drift or guardrail hits)
  tagteam check [--base <ref>]          CI/pre-push: files changed since <ref> (default origin/HEAD) vs constraints (exit 2 on hits)
  tagteam log                           List handoffs
  tagteam show [id]                     Show a handoff (default: latest)
  tagteam constraint "<text>" [--paths "a/**,b"] [--shared] [--warn-only]
                                        --shared: save in .tagteam/constraints.json (commit it). --warn-only: never block edits
  tagteam decision "<text>" [--why "..."]
  tagteam guard [on|off]                Block agent edits to protected paths (Claude Code hook; default on)
  tagteam verify [--yes] [--timeout s]  Re-run the handoff's test command and compare with what it claims (exit 2 on a false pass)
  tagteam mcp                           Start the MCP server (stdio)
  tagteam doctor                        Check node, git, agents, keys and the repo (exit 1 on problems)

Hook mode (used by installed hooks; reads hook JSON on stdin, never fails the agent):
  tagteam resume --hook
  tagteam capture --auto --reason precompact|session_end`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    auto: { type: 'boolean' },
    hook: { type: 'boolean' },
    json: { type: 'boolean' },
    reason: { type: 'string' },
    agent: { type: 'string' },
    paths: { type: 'string' },
    why: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    key: { type: 'boolean' },
    'key-stdin': { type: 'boolean' },
    preset: { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    command: { type: 'string' },
    'summary-model': { type: 'string' },
    'no-summary': { type: 'boolean' },
    'auto-switch': { type: 'boolean' },
    shared: { type: 'boolean' },
    'warn-only': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    timeout: { type: 'string' },
    base: { type: 'string' },
  },
});
const [cmd, ...args] = positionals;
const hookMode = Boolean(opt.auto || opt.hook);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid ${what} JSON on stdin: ${e.message}`);
  }
}

function requireRoot(cwd = process.cwd()) {
  const root = gitRoot(cwd);
  if (!root) throw new Error(`Not inside a git repository: ${cwd}`);
  return root;
}

const register = (root) => store.ensureProject(root, redact(remoteUrl(root)));

async function main() {
  if (opt.help || cmd === 'help') return console.log(HELP);
  if (!cmd && !Object.keys(readConfig().profiles).length) {
    return console.log(`${HELP}\n\nFirst run? Add a profile: tagteam profile add claude`);
  }

  switch (cmd ?? 'run') {
    case 'run': {
      const root = requireRoot();
      register(root);
      const { run } = await import('./launcher.js');
      return run(root, { profile: args[0], summary: !opt['no-summary'], autoSwitch: Boolean(opt['auto-switch'] || readConfig().autoSwitch) });
    }

    case 'profile': {
      const [sub, name] = args;
      if (sub === 'list') {
        const cfg = readConfig();
        if (!Object.keys(cfg.profiles).length) return console.log('No profiles. Try: tagteam profile add claude');
        for (const [n, p] of Object.entries(cfg.profiles)) {
          const where = p.provider?.base_url || p.env?.ANTHROPIC_BASE_URL || p.command || (p.agent === 'none' ? `${p.api?.baseUrl} (summarizer only)` : 'native login');
          const key = needsKey(p) ? (p.key ? 'key stored' : 'NO KEY') : 'no key needed';
          console.log(`${n.padEnd(14)} ${p.agent.padEnd(7)} ${(p.model ?? '-').padEnd(18)} ${where}  [${key}]`);
        }
        return console.log(`Chain: ${cfg.chain.join(' → ')}`);
      }
      if (sub === 'rm') {
        removeProfile(name);
        return console.log(`Removed ${name}.`);
      }
      if (sub !== 'add' || !name) throw new Error('Usage: tagteam profile add <name> | list | rm <name>');
      const p = buildProfile(name, {
        preset: opt.preset,
        agent: opt.agent,
        model: opt.model,
        baseUrl: opt['base-url'],
        command: opt.command,
        summaryModel: opt['summary-model'],
      });
      const keyed = needsKey(p);
      const had = Boolean(readConfig().profiles[name]?.key);
      let key = null;
      if (keyed && (opt.key || opt['key-stdin'] || !had)) {
        key = opt['key-stdin'] ? (await readStdin()).trim() : await promptHidden(`API key for ${name} (hidden): `);
        if (!key) throw new Error('Empty key.');
      }
      saveProfile(name, p, key);
      return console.log(`Saved "${name}" (${p.agent}, ${keyed ? 'key encrypted' : 'no key needed'}). Chain: ${readConfig().chain.join(' → ')}`);
    }

    case 'chain': {
      if (!args[0]) return console.log(readConfig().chain.join(' → ') || '(empty)');
      setChain(args[0].split(',').map((s) => s.trim()).filter(Boolean));
      return console.log(`Chain: ${readConfig().chain.join(' → ')}`);
    }

    case 'init': {
      const root = requireRoot();
      register(root);
      return console.log(`Registered ${root}\nData: ${store.projectDir(root)}`);
    }

    case 'install': {
      const root = requireRoot();
      register(root);
      const target = args[0];
      const fn = { claude: installClaude, codex: installCodex, cursor: installCursor }[target];
      if (!fn) throw new Error('Usage: tagteam install claude|codex|cursor');
      return console.log(fn(root).join('\n'));
    }

    case 'capture': {
      let hook = {};
      let fields;
      if (opt.auto) hook = parseJson((await readStdin()) || '{}', 'hook');
      if (opt.json) fields = HandoffInput.parse(parseJson(await readStdin(), 'handoff'));
      const root = opt.auto ? gitRoot(hook.cwd || process.cwd()) : requireRoot();
      if (!root) return; // hook fired outside a git repo: nothing to save
      register(root);
      const h = capture(root, {
        source: fields ? 'agent' : 'auto',
        reason: opt.reason || 'manual',
        agent: opt.agent || (opt.auto ? 'claude-code' : undefined),
        session_id: hook.session_id,
        fields,
        recent_user_messages: hook.transcript_path ? recentUserMessages(hook.transcript_path) : undefined,
        transcript_path: hook.transcript_path,
      });
      if (!opt.auto) console.log(`Saved handoff ${h.id}`);
      return;
    }

    case 'resume': {
      const hook = opt.hook ? parseJson((await readStdin()) || '{}', 'hook') : {};
      const root = opt.hook ? gitRoot(hook.cwd || process.cwd()) : requireRoot();
      if (!root || !store.isRegistered(root)) {
        if (!opt.hook) console.log('Project not registered. Run `tagteam init`.');
        return;
      }
      const pack = contextPack(root);
      if (pack) process.stdout.write(pack);
      else if (!opt.hook) console.log('No saved context yet.');
      return;
    }

    case 'status': {
      const root = requireRoot();
      const { text, ok } = statusReport(root);
      console.log(text);
      if (!ok) process.exitCode = 2;
      return;
    }

    case 'check': {
      const root = requireRoot();
      const base = opt.base || 'origin/HEAD';
      const { files, constraints, violations } = checkRange(root, base);
      const guarded = constraints.filter((c) => c.paths?.length).length;
      console.log(`tagteam check: ${files.length} changed file(s) since ${base}, ${guarded} path rule(s).`);
      if (!guarded) console.log('No path constraints found. Add shared ones with: tagteam constraint "<rule>" --paths "src/x/**" --shared');
      for (const v of violations) {
        console.log(`✗ "${v.constraint}"\n    touched: ${v.files.join(', ')}`);
        // GitHub Actions turns these into annotations on the PR's changed files.
        if (process.env.GITHUB_ACTIONS) for (const f of v.files) console.log(`::error file=${f},title=tagteam constraint::${v.constraint.replace(/[\r\n]+/g, ' ')}`);
      }
      if (violations.length) process.exitCode = 2;
      else console.log('✓ No protected path was touched.');
      return;
    }

    case 'guard': {
      const g = await import('./guard.js');
      if (opt.hook) {
        // PreToolUse hook: exit 2 with the reason on stderr blocks the tool call and tells the agent why.
        const hook = parseJson((await readStdin()) || '{}', 'hook');
        const root = gitRoot(hook.cwd || process.cwd());
        if (!root) return;
        const file = g.targetPath(root, { cwd: hook.cwd, ...hook.tool_input });
        const rule = g.blockingRule(root, file);
        if (!rule) return;
        console.error(g.denyMessage(file, rule));
        process.exitCode = 2;
        return;
      }
      const root = requireRoot();
      if (args[0] === 'on' || args[0] === 'off') {
        register(root);
        g.setGuard(root, args[0] === 'on');
      } else if (args[0]) throw new Error('Usage: tagteam guard [on|off]');
      const rules = store.allConstraints(root).filter((c) => c.paths?.length);
      const blocking = rules.filter((c) => c.enforce !== 'warn');
      console.log(`Guard: ${g.guardEnabled(root) ? 'on' : 'off'}${process.env.TAGTEAM_GUARD === 'off' ? ' (TAGTEAM_GUARD=off)' : ''}. ${blocking.length} blocking path rule(s), ${rules.length - blocking.length} warn-only.`);
      for (const c of rules) console.log(`  ${c.enforce === 'warn' ? 'warn ' : 'block'}  ${c.paths.join(', ')}  — ${c.text}${c.shared ? ' (shared)' : ''}`);
      return;
    }

    case 'verify': {
      const root = requireRoot();
      const { runTests, recordVerification } = await import('./verify.js');
      const h = store.latestHandoff(root);
      const command = h?.tests?.command;
      if (!command) throw new Error('The latest handoff names no test command to re-run.');
      console.log(`Handoff ${h.id} claims tests: ${h.tests.result}\nCommand from the handoff: ${command}`);
      if (!opt.yes) {
        if (!process.stdin.isTTY) throw new Error('Pass --yes to run it without a prompt (only for a command you trust).');
        const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
        const a = (await rl.question('Run this command in the repo? [y/N] ')).trim();
        rl.close();
        if (!/^y(es)?$/i.test(a)) return console.log('Not run.');
      }
      const secs = Number(opt.timeout ?? 600);
      if (!(secs > 0)) throw new Error('--timeout must be a number of seconds');
      const v = recordVerification(root, h, command, runTests(root, command, { timeoutMs: secs * 1000 }));
      const mark = v.ok === null ? '?' : v.ok ? '✓' : '✗';
      console.log(`\n${mark} tagteam verify: ${v.verdict}${v.note ? ` (${v.note})` : ''}. The next agent will see this result.`);
      // 2: the claim is false. 1: nothing could be checked (not a test failure).
      if (v.ok === false) process.exitCode = 2;
      else if (v.ok === null) process.exitCode = 1;
      return;
    }

    case 'log': {
      const root = requireRoot();
      const ids = store.listHandoffs(root).slice(0, 20);
      if (!ids.length) return console.log('No handoffs yet.');
      for (const id of ids) {
        const h = store.readHandoff(root, id);
        console.log(`${id}  ${h.source.padEnd(5)}  ${h.reason.padEnd(11)}  ${h.task?.title ?? '-'}`);
      }
      return;
    }

    case 'show': {
      const root = requireRoot();
      const h = !args[0] || args[0] === 'latest' ? store.latestHandoff(root) : store.readHandoff(root, args[0]);
      if (!h) throw new Error('Handoff not found.');
      return console.log(renderHandoff(h));
    }

    case 'constraint': {
      const root = requireRoot();
      if (!args[0]) throw new Error('Usage: tagteam constraint "<text>" [--paths "a/**,b"]');
      register(root);
      const paths = opt.paths?.split(',').map((p) => p.trim()).filter(Boolean);
      const c = { text: redact(args[0]), ...(paths?.length ? { paths } : {}), ...(opt['warn-only'] ? { enforce: 'warn' } : {}) };
      if (opt.shared) {
        store.addSharedConstraint(root, c);
        return console.log(`Shared constraint saved to ${store.sharedConstraintsFile(root)}. Commit it so teammates and CI (tagteam check) get it.`);
      }
      store.addConstraint(root, c);
      return console.log('Constraint saved.');
    }

    case 'decision': {
      const root = requireRoot();
      if (!args[0]) throw new Error('Usage: tagteam decision "<text>" [--why "..."]');
      register(root);
      store.addDecision(root, { date: new Date().toISOString().slice(0, 10), decision: redact(args[0]), ...(opt.why ? { why: redact(opt.why) } : {}) });
      return console.log('Decision saved.');
    }

    case 'doctor': {
      const { diagnose, printDoctor } = await import('./doctor.js');
      process.exitCode = printDoctor(diagnose());
      return;
    }

    case 'mcp': {
      const { startMcp } = await import('./mcp.js');
      return startMcp(process.env.TAGTEAM_ROOT || process.cwd());
    }

    default:
      throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`tagteam: ${e.message}`);
  // Hooks must never break the agent session.
  process.exitCode = hookMode ? 0 : 1;
});
