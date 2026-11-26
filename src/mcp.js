// stdio MCP server: any MCP client (Claude Code, Codex, Cursor, ...) reads and writes the same handoffs.
// Never write to stdout here; it carries the protocol.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as store from './store.js';
import { gitRoot, remoteUrl } from './git.js';
import { redact, redactDeep } from './redact.js';
import { capture, contextPack, handoffFields, HandoffInput } from './handoff.js';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export async function startMcp(cwd) {
  const root = gitRoot(cwd);
  if (!root) throw new Error(`tagteam mcp must run inside a git repository (cwd: ${cwd})`);
  store.ensureProject(root, redact(remoteUrl(root)));

  const server = new McpServer({ name: 'tagteam', version: VERSION });
  const clientName = () => server.server.getClientVersion()?.name;

  server.registerTool(
    'get_context',
    { description: 'Current task, constraints, decisions, project memory and drift warnings for this repo. Call at session start.' },
    async () => text(contextPack(root) || 'No saved context yet for this repo.'),
  );

  server.registerTool(
    'save_handoff',
    {
      description: 'Save a structured handoff so the next session or agent can continue. Call before stopping or when context is getting long.',
      inputSchema: { ...handoffFields, agent: z.string().optional().describe('Your agent name, e.g. claude-code, codex') },
    },
    async ({ agent, ...fields }) => {
      const h = capture(root, { source: 'agent', reason: 'manual', agent: agent || clientName(), fields: HandoffInput.parse(fields) });
      return text(`Saved handoff ${h.id} at ${h.git.branch ?? 'no branch'}@${h.git.head?.slice(0, 7) ?? 'none'}.`);
    },
  );

  server.registerTool(
    'add_decision',
    { description: 'Record an architecture or design decision and why it was made.', inputSchema: { decision: z.string(), why: z.string().optional() } },
    async (d) => {
      store.addDecision(root, redactDeep({ date: new Date().toISOString().slice(0, 10), ...d }));
      return text('Decision saved.');
    },
  );

  server.registerTool(
    'add_constraint',
    {
      description: 'Record a rule from the user that must never be broken. paths: globs of files the rule protects (guardrail warnings fire when they change).',
      inputSchema: { text: z.string(), paths: z.array(z.string()).optional() },
    },
    async (c) => {
      store.addConstraint(root, redactDeep(c));
      return text('Constraint saved.');
    },
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Update slow-changing project memory (architecture, rules, business logic). mode=append adds a section; mode=replace rewrites the file.',
      inputSchema: { content: z.string(), mode: z.enum(['append', 'replace']).default('append') },
    },
    async ({ content, mode }) => {
      const clean = redact(content);
      store.writeMemory(root, mode === 'replace' ? `${clean.trim()}\n` : `${store.readMemory(root).trimEnd()}\n\n${clean.trim()}\n`);
      return text('Memory updated.');
    },
  );

  server.registerTool(
    'list_handoffs',
    { description: 'List recent handoffs (newest first).', inputSchema: { limit: z.number().int().min(1).max(50).default(10) } },
    async ({ limit }) => {
      const rows = store.listHandoffs(root).slice(0, limit).map((id) => {
        const h = store.readHandoff(root, id);
        return `${id}  ${h.source}  ${h.reason}  ${h.task?.title ?? '-'}`;
      });
      return text(rows.join('\n') || 'No handoffs yet.');
    },
  );

  await server.connect(new StdioServerTransport());
}
