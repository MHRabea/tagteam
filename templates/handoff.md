---
description: Save a structured handoff so the next session (any agent) continues without re-explaining
---

Save a handoff for this repo now. Call the `save_handoff` tool of the `tagteam` MCP server. Fill it from what actually happened in this session, not from plans:

- `task`: title, goal, acceptance criteria.
- `completed`: concrete finished steps. Name files and functions.
- `in_progress`: work started but not done, and where it stopped.
- `next_action`: ONE concrete next step that someone can start without reading this session. Example: "Fix the failing `retry renews once` test in `test/billing.test.js`; the scheduler enqueues twice."
- `known_issues`: failing tests by name, errors quoted exactly, open questions.
- `tests`: the last test command you ran and its real result. Use `not_run` if none ran.
- `decisions`: only new design decisions from this session, each with why.
- `constraints`: only new rules the user stated that must not be broken. Add `paths` globs when a rule protects specific files.

If the tool answers with gaps (for example "No test status"), fill in the ones you know and save again. Do not invent progress. If the MCP tool is not available, pipe the same JSON to `tagteam capture --json --agent claude-code` with Bash.

$ARGUMENTS
