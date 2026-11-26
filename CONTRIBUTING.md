# Contributing

Thanks for helping. Issues, provider reports and pull requests are all welcome.

## Setup

```
git clone https://github.com/MHRabea/tagteam
cd tagteam
npm ci
npm test
npm link        # puts your checkout on PATH as `tagteam`
```

Node 20 or newer. No build step: the CLI runs straight from `src/`.

## Before you open a pull request

- `npm test` passes. New behaviour comes with a test; the run loop has fake agents
  (`test/fixtures/fake-agent.cjs`) and a mock provider (`test/mock-provider.js`) so tests never need a real key.
- Agent flags changed? Run `npm run contract` with the agent installed.
- Never commit keys, transcripts or `~/.tagteam` data. Redaction patterns live in `src/redact.js`,
  with samples in `test/redact-corpus.test.js`. A new secret format needs a sample there.
- Keep dependencies at two (`@modelcontextprotocol/sdk`, `zod`) unless there is no reasonable alternative.

## Reporting results with a provider

Tried tagteam with an agent or provider that is not in the presets table? Open a
"Support an agent or provider" issue with what worked and what did not. These reports decide the next presets.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
