# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). You will get a reply within 7 days.

## What tagteam handles

| Data | Where it lives | Protection |
|---|---|---|
| API keys | OS key store: Windows DPAPI, macOS Keychain, Linux Secret Service | `profiles.json` holds only ciphertext or a reference. Keys reach agents through environment variables, and reach OS tools through stdin, never through command-line arguments |
| Handoffs, memory, decisions | `~/.tagteam/projects/<id>/` | Secrets are redacted before anything is written. Nothing is written into your repo |
| Transcript excerpts | Sent to the summarizer profile you configured, only when an agent stops without saving a handoff | Redacted first. Off with `--no-summary` |

tagteam never reads, stores or switches subscription logins (Claude, ChatGPT). Native-login
profiles use the agent's own login.

## Known limits

- Redaction is pattern based. It catches common key formats, tokens, passwords in URLs,
  `KEY=value` secrets and private keys, but it cannot recognise every secret. Review what
  you put in constraints and memory.
- Handoff text is written by AI agents and loaded into the next agent as context. Treat it like
  any other repo content an agent reads; tagteam does not make it trusted.
- `TAGTEAM_KEY_STORE=plain` stores keys unencrypted. Use it only in throwaway CI or containers.
