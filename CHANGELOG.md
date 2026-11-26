# Changelog

## 0.1.1 (2026-11-26)

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
