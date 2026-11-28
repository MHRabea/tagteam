// Wire tagteam into agents. Every writer is idempotent: re-running replaces only tagteam's own entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, writeFile } from './store.js';

const TEMPLATE = fileURLToPath(new URL('../templates/handoff.md', import.meta.url));
const SKILL = fileURLToPath(new URL('../templates/skill/SKILL.md', import.meta.url));
// Also matches hooks from the pre-rename name (acm) so re-installing replaces them.
const isOurs = (command) => /^(tagteam|acm)\s/.test(command ?? '');

export function mergeHook(settings, event, matcher, command) {
  settings.hooks ??= {};
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command)) }))
    .filter((g) => g.hooks.length);
  groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  settings.hooks[event] = groups;
  return settings;
}

// [event, matcher, command]: shared with the launcher so Claude Code de-duplicates identical commands.
export const HOOKS = [
  ['SessionStart', 'startup|resume|compact', 'tagteam resume --hook'],
  ['PreCompact', null, 'tagteam capture --auto --reason precompact'],
  ['SessionEnd', null, 'tagteam capture --auto --reason session_end'],
  // Blocks edits to paths a constraint protects, before they happen.
  ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'tagteam guard --hook'],
];

export function installClaude(root) {
  // Hooks go in settings.local.json: per-developer and git-ignored by Claude Code.
  const settingsFile = path.join(root, '.claude', 'settings.local.json');
  const s = readJson(settingsFile, {});
  for (const [event, matcher, command] of HOOKS) mergeHook(s, event, matcher, command);
  // Pre-approve our own .mcp.json entry so there is no approval prompt.
  s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers ?? []), 'tagteam'])];
  writeJson(settingsFile, s);

  const mcpFile = path.join(root, '.mcp.json');
  const m = readJson(mcpFile, {});
  m.mcpServers ??= {};
  const old = m.mcpServers.acm; // entry written before the rename
  if (old && [old.command, ...(old.args ?? [])].includes('acm')) delete m.mcpServers.acm;
  // Windows cannot spawn the npm .cmd shim directly.
  m.mcpServers.tagteam = process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'tagteam', 'mcp'] } : { command: 'tagteam', args: ['mcp'] };
  writeJson(mcpFile, m);

  const cmdFile = path.join(root, '.claude', 'commands', 'handoff.md');
  writeFile(cmdFile, fs.readFileSync(TEMPLATE, 'utf8'));
  const skillFile = path.join(root, '.claude', 'skills', 'tagteam', 'SKILL.md');
  writeFile(skillFile, fs.readFileSync(SKILL, 'utf8'));

  return [
    `Hooks:   ${settingsFile}`,
    `MCP:     ${mcpFile}`,
    `Command: ${cmdFile}  (/handoff)`,
    `Skill:   ${skillFile}  (tagteam)`,
    'Restart Claude Code in this repo.',
  ];
}

const START = '<!-- tagteam:start -->';
const END = '<!-- tagteam:end -->';

export const AGENT_BLOCK = `## Session continuity (tagteam)
- At session start, run \`tagteam resume\` and read the output. It holds the current task, constraints, decisions and drift warnings for this repo.
- Never break a listed constraint. If drift is reported, check the handoff against the code before acting on it.
- Before you stop, save a handoff: call the \`save_handoff\` tool of the \`tagteam\` MCP server if you have it; otherwise pipe JSON to \`tagteam capture --json --agent <your-name>\`.
  Fields: task {title, goal, acceptance[]}, completed[], in_progress[], next_action, known_issues[], tests {command, result: pass|fail|not_run, notes}, decisions[{decision, why}], constraints[{text, paths[]}].`;

export function upsertBlock(text, block) {
  const b = `${START}\n${block.trim()}\n${END}`;
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i >= 0 && j > i) return text.slice(0, i) + b + text.slice(j + END.length);
  return (text.trimEnd() ? `${text.trimEnd()}\n\n` : '') + `${b}\n`;
}

const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

export function installCodex(root) {
  const f = path.join(root, 'AGENTS.md');
  const legacy = /\n*<!-- acm:start -->[\s\S]*?<!-- acm:end -->\n?/; // block written before the rename
  writeFile(f, upsertBlock(readText(f).replace(legacy, '\n'), AGENT_BLOCK));
  return [
    `Updated ${f}`,
    'Optional MCP: add to ~/.codex/config.toml →  [mcp_servers.tagteam]  command = "tagteam"  args = ["mcp"]',
  ];
}

export function installCursor(root) {
  const f = path.join(root, '.cursor', 'rules', 'tagteam.mdc');
  writeFile(f, `---\ndescription: Session continuity via tagteam\nalwaysApply: true\n---\n\n${AGENT_BLOCK}\n`);
  return [`Wrote ${f}`, 'Optional MCP: add "tagteam" (command: tagteam, args: ["mcp"]) to .cursor/mcp.json'];
}
