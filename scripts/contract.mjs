// Contract check: do the installed Claude Code and Codex still accept every flag tagteam passes?
// Run it after an agent update, and nightly in CI against the latest releases.
// Usage: node scripts/contract.mjs [--require claude,codex]   (--require fails when an agent is missing)
import { spawnSync } from 'node:child_process';
import { resolveCommand } from '../src/launcher.js';

// Flags tagteam's launcher uses for each agent (src/launcher.js buildLaunch).
const CONTRACT = {
  claude: ['--settings', '--mcp-config', '--model'],
  codex: ['--config', '--add-dir', '--disable', '--model'],
};

const i = process.argv.indexOf('--require');
const required = i > 0 ? process.argv[i + 1].split(',') : [];
let failed = false;

for (const [agent, flags] of Object.entries(CONTRACT)) {
  let spec;
  try {
    spec = resolveCommand(agent);
  } catch {
    const must = required.includes(agent);
    console.log(`${must ? '✗' : '-'} ${agent}: not installed${must ? '' : ' (skipped)'}`);
    failed ||= must;
    continue;
  }
  const call = (...a) => spawnSync(spec.cmd, [...spec.pre, ...a], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const version = (call('--version').stdout || '').trim().split('\n')[0] || 'unknown version';
  const help = call('--help');
  const text = `${help.stdout}${help.stderr}`;
  const missing = flags.filter((f) => !new RegExp(`(^|[\\s,])${f}\\b`, 'm').test(text));
  if (help.status !== 0 || missing.length) {
    failed = true;
    console.log(`✗ ${agent} ${version}: ${help.status !== 0 ? `--help exited ${help.status}` : `missing ${missing.join(', ')}`}`);
  } else {
    console.log(`✓ ${agent} ${version}: ${flags.join(' ')}`);
  }
}
process.exitCode = failed ? 1 : 0;
