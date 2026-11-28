# Changelog

## 0.3.1 (unreleased)

Fixes found by a live end-to-end run: real Claude Code → real Codex 0.172 → real Claude Code on one task.

- **Claude Code did not start when a handoff with a task existed.** The start prompt came right after
  `--mcp-config <file>`, which takes several files in Claude Code 2.1.330, so the prompt was read as a config
  path. The prompt now comes first.
- **Codex could not save handoffs non-interactively.** tagteam now passes
  `mcp_servers.tagteam.default_tools_approval_mode="approve"` for its own MCP server (its tools only write
  tagteam's data), so `codex exec` no longer rejects `save_handoff`, and interactive Codex does not ask each time.
- **`tagteam verify` no longer reports a false FAIL** for a command that could not run. A PowerShell-style
  command (`$env:X = ...; npm test`, as Codex writes on Windows) runs in PowerShell; a command the shell cannot
  find is reported as "could not run, nothing proven" (exit 1), not as a failing test (exit 2).
- The handoff's `tests.command` asks agents for a command runnable from the repo root.
- `/handoff` copies installed under the pre-rename name (`acm`) are updated.

## 0.3.0 (2026-11-28)

- **Edit guard (prevention).** A Claude Code `PreToolUse` hook (`tagteam guard --hook`, wired by `tagteam run`
  and `tagteam install claude`) refuses Edit/Write/MultiEdit/NotebookEdit calls on paths a constraint protects
  and tells the agent why. Tested with real Claude Code: the file is untouched and the agent asks the user.
  Shell writes and agents without hooks are still caught by `status`, `check` and the GitHub Action.
  **Behaviour change:** existing path constraints now block edits in Claude Code. Use `--warn-only` for a rule
  that should only warn, or `tagteam guard off` to pause the guard in a repo.
- **`tagteam verify`.** Re-runs the handoff's test command (after showing it and asking, or with `--yes`),
  compares with the claimed result, and exits 2 on a false "pass". The next agent's context shows the re-run
  result, and labels an unverified result as a claim.
- `tagteam guard [on|off]` lists blocking and warn-only rules; `tagteam constraint --warn-only`.
- 109 tests.

## 0.2.0 (2026-11-28)

- **Auto-switch on a usage limit.** `tagteam --auto-switch` (or `"autoSwitch": true` in `profiles.json`)
  starts the next profile by itself when the session ended on a usage or rate limit. The limit is read from
  the end of the agent's own transcript (Claude Code limit and API-error messages, Codex error events), so a
  chat about rate limits never triggers it. Each profile is auto-skipped at most once per run. Without the
  flag, tagteam now says when a session ended on a limit and still asks.
- **Handoff check.** Handoffs are checked for a task, one concrete next action, test status and progress.
  The MCP `save_handoff` tool returns the gaps to the agent so it can save again; the context pack and
  `tagteam status` list remaining gaps. Advisory: it never changes an exit code.
- **Team rules.** `tagteam constraint ... --shared` (and `add_constraint` with `shared: true`) saves the rule
  in `.tagteam/constraints.json` in the repo, so every teammate's agent and CI get it. Local and shared
  rules are merged; this is the only file tagteam writes in a repo, and only when asked.
- **`tagteam check [--base ref]`** for CI and pre-push: files changed on the branch against the rules, exit 2
  on a hit, GitHub annotations under Actions. Needs no saved handoff.
- **GitHub Action** (`uses: MHRabea/tagteam@v0.2.0`): fails a pull request that touches a protected path.
- README leads with the full loop; 100 tests.

## 0.1.5 (2026-11-26)

- New `tagteam` Agent Skill: tells Claude Code when to read the context, record constraints and decisions,
  save a handoff, and run `tagteam status` before committing. `tagteam run` installs it at
  `~/.claude/skills/tagteam/SKILL.md`; `tagteam install claude` puts it in the repo's `.claude/skills/`.
- Tests never write to the real `~/.claude`.

## 0.1.4 (2026-11-26)

- Ready for the official MCP Registry: `server.json` and `mcpName` (`io.github.MHRabea/tagteam`).
  Clients can run the server with `npx -y tagteam-ai mcp`.
- The MCP server reports the package version instead of a fixed `0.1.0`.

## 0.1.3 (2026-11-26)

The changes listed under 0.1.1. First release published from GitHub Actions through npm trusted
publishing, with provenance. 0.1.1 and 0.1.2 were tagged but never reached npm (the release workflow's
npm was too old, then the trusted publisher was not yet set up).

## 0.1.2 (not published)

## 0.1.1 (not published)

- The summarizer no longer turns its own instructions, or a pasted credential, into project
  constraints, decisions or next steps.
- `tagteam profile list` shows the API endpoint of summarizer-only profiles.
- README: 30-second demo GIF.
- First release published from GitHub Actions with npm provenance.

## 0.1.0 (2026-11-26)

First release.

- `tagteam run`: start Claude Code, Codex or any command with the saved context; on exit make sure a
  handoff exists (agent-written, summarizer-written or git state) and offer the next profile.
- Git-verified handoffs with drift detection, path-bound guardrails, and redaction.
- Profiles and presets: `claude`, `claude-api`, `codex`, `deepseek`, `openai`, and the
  summarizer-only `grok` and `gemini`.
- Keys in the OS key store: DPAPI (Windows), Keychain (macOS), Secret Service (Linux).
- Saves are locked per repo, so parallel agents and hooks never overwrite each other.
- Handoff files carry a format version (`schema`), so later releases can migrate them.
- `tagteam doctor` checks node, git, agents, keys and the repo.
- Redaction covers xAI, Google/Gemini, Stripe, GitLab, npm, Hugging Face, SendGrid, Slack webhooks,
  Basic auth, `x-api-key` headers, JSON/JS `"apiKey": "..."` and Azure connection strings.
- Tests: the full `run` loop against fake Claude Code and Codex binaries (real hooks, real MCP) and a
  mock provider (429, 401, 503, malformed JSON, timeouts); a redaction corpus; `npm run contract`
  checks the installed agents still accept tagteam's flags. A nightly workflow runs it on the
  latest agent releases.
- MCP server with `get_context`, `save_handoff`, `add_decision`, `add_constraint`,
  `update_memory`, `list_handoffs`.
