---
name: tagteam
description: Session continuity for coding work with tagteam. Use at the start of a session in a repo that has tagteam context, when the user states a rule or makes a design decision worth keeping, before you stop or when the context is getting long, before committing, and whenever the user mentions a handoff, switching agents, continuing earlier work, or tagteam.
---

# tagteam: keep the work continuous across sessions and agents

tagteam saves a structured, git-verified handoff per repo so the next session (this agent or another one: Claude Code, Codex, DeepSeek, ...) continues without re-explaining. Its MCP server is named `tagteam`; the same actions exist on the `tagteam` CLI.

## At the start of a session

- The SessionStart hook usually injects a "Session context (tagteam)" block. If it is missing, call the `get_context` tool (or run `tagteam resume`).
- **Drift first.** If the context lists drift ("new commits since the handoff", "uncommitted changes differ"), read the changed files before trusting the handoff. Tell the user what changed.
- **Constraints are binding.** Never break a listed constraint. If a constraint names paths, do not edit those files without the user's explicit go-ahead. If tagteam blocks an edit, do not work around it (shell commands, copies, renames): tell the user which rule blocked it and ask.
- If the context says the test result "has not been re-run", run the tests before relying on it.
- Start from the handoff's **Next action** unless the user asks for something else.

## While working

- The user states a lasting rule ("don't touch the gateway", "no new dependencies"): call `add_constraint` with the rule and, when it protects specific files, `paths` globs. Pass `shared: true` only when the user wants the rule for the whole team: it goes into `.tagteam/constraints.json` in the repo, where teammates and CI (`tagteam check`) see it.
- You and the user settle a design choice: call `add_decision` with the decision and why.
- Stable facts about the project (architecture, conventions, how to run things) belong in `update_memory`, not in a handoff.

## Before you stop, and when the context gets long

Call `save_handoff`. Fill it from what actually happened, not from plans:

- `task`: title, goal, acceptance criteria.
- `completed`: finished steps, naming files and functions.
- `in_progress`: what is started and where it stopped.
- `next_action`: ONE concrete step someone can start without reading this session.
- `known_issues`: failing tests by name, errors quoted exactly, open questions.
- `tests`: the last command you ran and its real result (`pass`, `fail`, or `not_run`).

If `save_handoff` answers with "Gaps the next agent will hit", fill in the ones you know and save again. Never invent progress or test results. Save a handoff before a long-running or risky step too: if the session dies, the next agent starts from there.

## Before committing

Run `tagteam status` (or `tagteam check --base main` to check the whole branch against the constraints). Exit code 2 means drift or a guardrail hit: show the user the warnings and do not commit files that break a constraint without their go-ahead.

## Without the MCP server

Pipe the same JSON to the CLI: `tagteam capture --json --agent <your-name>`. `tagteam log` lists handoffs and `tagteam show` prints the latest.
