// Fake `claude` / `codex` for the run-loop tests. It behaves like the real agents at the edges
// tagteam depends on: it reads the flags tagteam passes, runs the hook commands from --settings
// (Claude) and starts the MCP server tagteam describes (both), then exits the way FAKE_MODE says:
//   save    call the MCP tool save_handoff, exit 0
//   silent  edit a file, write a transcript, fire SessionEnd (Claude), exit 0 without a handoff
//   limit   like silent, exit 1 (an agent that hit its usage limit)
//   crash   edit a file, exit 3, no hook and no transcript
// Every run appends one JSON line to FAKE_LOG. It is started through a small wrapper named after
// the agent (claude.js / codex.js), so the agent is the wrapper's basename.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.env.FAKE_MODE) process.exit(0); // `node --test` also runs files under test/

const agent = path.basename(process.argv[1], '.js');
const args = process.argv.slice(2);
// FAKE_MODE is a comma list: run N of the test uses entry N (the last one repeats).
const runs = fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).length : 0;
const modes = process.env.FAKE_MODE.split(',');
const mode = modes[runs] ?? modes.at(-1);
const cwd = process.cwd();
const record = { agent, mode, args, cwd, env: {} };
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'TAGTEAM_PROVIDER_KEY', 'TAGTEAM_ROOT', 'CLAUDECODE']) {
  if (process.env[k] !== undefined) record.env[k] = process.env[k];
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function runHook(event, input) {
  const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'));
  const out = [];
  for (const group of settings.hooks?.[event] ?? []) {
    for (const h of group.hooks) {
      const r = spawnSync(h.command, { shell: true, cwd, env: process.env, input: JSON.stringify(input), encoding: 'utf8' });
      out.push({ command: h.command, status: r.status, stdout: r.stdout, stderr: r.stderr });
    }
  }
  return out;
}

// The MCP server command, as each agent would read it from what tagteam passed.
function mcpServer() {
  if (agent === 'claude') return JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.tagteam;
  const c = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const [k, ...v] = args[i + 1].split('=');
    c[k] = v.join('=');
  }
  if (!c['mcp_servers.tagteam.command']) return null;
  // The values are TOML; the ones tagteam writes are also valid JSON once the inline table is converted.
  const env = {};
  for (const m of c['mcp_servers.tagteam.env'].matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/g)) env[m[1]] = JSON.parse(m[2]);
  return { command: JSON.parse(c['mcp_servers.tagteam.command']), args: JSON.parse(c['mcp_servers.tagteam.args']), env };
}

async function saveViaMcp() {
  const sdk = path.join(__dirname, '..', '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
  const { Client } = require(path.join(sdk, 'index.js'));
  const { StdioClientTransport } = require(path.join(sdk, 'stdio.js'));
  const s = mcpServer();
  const transport = new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...s.env }, cwd, stderr: 'pipe' });
  const client = new Client({ name: `fake-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  const res = await client.callTool({
    name: 'save_handoff',
    arguments: {
      agent: `fake-${agent}`,
      task: { title: 'Fix prorate' },
      completed: [`step done by ${agent}`],
      next_action: `next step after ${agent}`,
    },
  });
  await client.close();
  return res.content?.[0]?.text;
}

function writeTranscript() {
  // FAKE_TRANSCRIPT: optional JSON file with [{ role, text }] to use instead of the default lines.
  const lines = process.env.FAKE_TRANSCRIPT ? JSON.parse(fs.readFileSync(process.env.FAKE_TRANSCRIPT, 'utf8')) : [
    { role: 'user', text: 'Fix the prorate bug in src/billing.js' },
    { role: 'assistant', text: 'I swapped the division in prorate(); tests still fail on rounding.' },
    // A secret pasted in chat: it must be redacted before the transcript reaches a summarizer.
    { role: 'user', text: 'use OPENAI_API_KEY=sk-proj-FAKE1234567890abcdefghijklmnop for the test' },
  ];
  if (agent === 'claude') {
    const f = path.join(process.env.FAKE_DIR, `claude-${Date.now()}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify({ type: l.role, message: { role: l.role, content: l.text } })).join('\n') + '\n');
    return f;
  }
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '25');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-${Date.now()}.jsonl`);
  const items = lines.map((l) => ({ type: 'response_item', payload: { type: 'message', role: l.role, content: [{ type: l.role === 'user' ? 'input_text' : 'output_text', text: l.text }] } }));
  fs.writeFileSync(f, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  return f;
}

async function main() {
  const session = { session_id: `fake-${process.pid}`, cwd };
  if (agent === 'claude') {
    const start = runHook('SessionStart', { ...session, source: 'startup' });
    record.context = start.map((h) => h.stdout).join('');
    record.hookErrors = start.filter((h) => h.status !== 0).map((h) => h.stderr);
  } else {
    record.context = args.at(-1);
  }

  if (mode !== 'save') fs.appendFileSync(path.join(cwd, 'src', 'billing.js'), `// edit by ${agent}\n`);
  let code = 0;
  if (mode === 'save') record.saved = await saveViaMcp();
  if (mode === 'silent' || mode === 'limit') {
    const tp = writeTranscript();
    if (agent === 'claude') runHook('SessionEnd', { ...session, transcript_path: tp, reason: 'exit' });
    code = mode === 'limit' ? 1 : 0;
  }
  if (mode === 'crash') code = 3;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(record) + '\n');
  process.exit(code);
}

main().catch((e) => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ...record, error: String(e.stack || e) }) + '\n');
  process.exit(99);
});
