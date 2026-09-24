# CLAUDE.md — asor-cli (ASORtoCLI)

## Purpose
This is an open-source CLI, public at **github.com/gilfila/asor-cli**. It does three things:
- logs into a Workday tenant,
- lists the agents registered in the **Agent System of Record (ASOR)**,
- invokes them over **A2A JSON-RPC**.

`asor wrap <agent>` also generates a standalone CLI for one agent, bundled with `tool.json` and `SKILL.md`. Slack, Teams, Claude Code, or cron can then use that agent through a shell command. It is not affiliated with Workday.

## Stack
- **Language:** TypeScript on Node 22+, ESM.
- **Dependencies:** none at runtime, and that is a hard rule, because `asor wrap` vendors `dist/src/*.js` into every generated CLI. The dev dependencies are `typescript` and `@types/node`.
- **Tests:** `node:test`, run against a mock tenant (`mock/server.ts`).

## Run / Build / Test
```bash
npm install          # also builds (prepare)
npm test             # clean + tsc + node --test dist/test/**/*.test.js  (44 tests)
npm run mock         # fake tenant on :4010; prints the ASOR_* env to export
node examples/shared/demo.mjs   # bot-runner end-to-end against the mock
```
The build writes to `dist/{src,test,mock}`. The bin is `dist/src/cli.js`.

## Structure
- **`src/`**
  - `cli.ts`: router, help, exit codes
  - `config.ts`: profiles and `ASOR_*` env
  - `auth.ts`: refresh-token exchange, rotation, on-disk token cache
  - `asor.ts`: `/asor/v1/agentDefinition` client with error hints
  - `a2a.ts`: JSON-RPC send, SSE stream, `tasks/get`
  - `invoke.ts`: `Invoker` interface and `a2aInvoker`
  - `resolve.ts`: agent reference resolution by id, name, slug, or substring
  - `run-invoke.ts`: shared output and the JSON envelope
  - `wrap.ts`: the generator
  - `wrapped.ts`: runtime of the generated CLIs
  - `index.ts`: library exports
- **`examples/`**
  - `shared/asor-runner.mjs`: safe spawn helper (no shell, stdin prompt, `--` before the agent, strips bot secrets)
  - `slack-bolt/`, `teams/`, `claude-skill/`

## Conventions
- **API facts.** They come from the Workday/asor v1.2 spec and `hive/buzz-workday-asor/register.mjs`:
  - host `us.agent.workday.com`
  - header `wd-agent-tenant-alias`
  - token URL `https://{host}/auth/oauth2/{tenant}/token`
- **The bot contract is stable API:**
  - the `--json` envelope `{ok, agent, contextId, taskId, state, text, artifacts, error}`
  - exit codes 0/1/2/3/4/5
  - the `tool.json` shape
- **The Workday token is never forwarded to agent endpoints by default** (`--agent-auth none`).
- **Keep `src/version.ts` in sync with package.json.** A test enforces it.

## Last turn / Pending (2026-09-24)
**Built v0.1.0 from scratch.**
- Commands: login, whoami, profiles, logout, `agents list|get|register`, invoke (send, stream, polling, input-required follow-ups), wrap.
- Also built the mock tenant, 44 green tests, the Slack, Teams and Claude-skill examples, docs, and CI (ubuntu and windows, Node 22 and 24).
- Created the public GitHub repo `gilfila/asor-cli` and pushed.

**Open:**
- **Never run against a real tenant.** The next step is `asor login` plus `asor whoami` on a real tenant. The known 401 blocker for ASOR credentials is in `hive/buzz-workday-asor/LIVE_SETUP_PROGRESS.md`. Things to confirm there:
  - the `GET /agentDefinition` list shape (the code handles a bare array or `{total, data}`),
  - whether the refresh-token grant works on the agent host's token URL, or whether `--token-url` needs the `ccx` one,
  - how Workday-native agents appear (they are probably `invocable: no`).
- **The Slack and Teams examples are syntax-checked only.** Nobody has run them against live Slack or Teams.
- **npm publish has not been done.** Check the `asor-cli` name first and ask Tony.
- **Possible next features:**
  - an MCP server mode (`asor mcp`) that exposes ASOR agents as MCP tools,
  - a Workday Agent Gateway invoker for native agents,
  - JWT-bearer (x509) auth.
