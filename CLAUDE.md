# CLAUDE.md — asor-cli (ASORtoCLI)

## Purpose
This is an open-source tool, public at **github.com/gilfila/asor-cli**, that **generates one dedicated CLI per Workday ASOR agent**.
- **Picking agents:** `asor ui` is a local web picker. The terminal equivalent is `asor wrap`.
- **What it does:** it connects to a tenant, lists the agents registered in the Agent System of Record, and lets you try them.
- **What you get:** a zero-dependency package per agent (bin + `SKILL.md` + `tool.json`). Slack, Teams, Claude Code, or cron can drive that agent through a shell command.
- **For exploring:** `asor invoke` talks to any agent directly.
- **Transport:** calls go over A2A JSON-RPC.
- **Not affiliated with Workday.**

## Stack
- **Language:** TypeScript on Node 22+, ESM.
- **Dependencies:** none at runtime, and that is a hard rule, because `asor wrap` vendors `dist/src/*.js` into every generated CLI. The dev dependencies are `typescript` and `@types/node`.
- **Tests:** `node:test`, run against a mock tenant (`mock/server.ts`).

## Run / Build / Test
```bash
npm install          # also builds (prepare)
npm test             # clean + build + node --test dist/test/**/*.test.js  (54 tests)
npm run build && node dist/src/cli.js ui   # the picker (needs ASOR_* or a saved profile; npm run mock for a fake tenant)
npm run mock         # fake tenant on :4010; prints the ASOR_* env to export
node examples/shared/demo.mjs   # bot-runner end-to-end against the mock
```
The build writes to `dist/{src,test,mock}`. The bin is `dist/src/cli.js`. `scripts/copy-assets.mjs` copies `src/ui/page.html` into dist, because tsc only emits .js.

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
  - `wrap.ts`: the generator and per-surface recipes (`surfaceSnippets`). `NOT_VENDORED` keeps the ui, cli, wrap, and index modules out of generated CLIs.
  - `ui/`: `asor ui`. It has a `server.ts` (127.0.0.1 only, session token, Host check, nonce CSP, rolls back a failed login), a `page.html` (vanilla JS; all tenant data goes through textContent), and a `zip.ts` (stored-only ZIP writer).
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

## Last turn / Pending (2026-09-24, v0.2.0)
**Refocused the project on one CLI per agent,** at Tony's request ("I need a CLI that has access to a particular agent").

**Added `asor ui`,** a local web picker. It lets you:
- connect a tenant through a form,
- browse and filter agents,
- try an agent in a chat (with input-required follow-ups),
- generate a CLI for one agent, or for several at once,
- copy per-surface recipes, or download the CLI as a `.zip`.

The UI was verified visually in both light and dark mode against the mock tenant.

**`asor wrap` changes:**
- With no agent it shows an interactive picker.
- `--out` now defaults to `./asor-agents/<cmd>`.
- `asor generate` is an alias.

**Fixed a bug:** login verification used to let `ASOR_*` env override the entered profile. The new `verifySavedProfile` checks the profile as entered.

**Also:** the README was reframed with a screenshot at `docs/asor-ui.png`, the version is 0.2.0, and there are 54 green tests.

**Open (carried over):**
- **Never run against a real tenant.** Next step: `asor login`, then `asor whoami`, then `asor ui`. The known 401 blocker is in `hive/buzz-workday-asor/LIVE_SETUP_PROGRESS.md`. Things to confirm:
  - the list shape,
  - which token URL works,
  - how Workday-native agents show up.
- **The Slack and Teams examples are syntax-checked only.**
- **npm publish has not been done.** Check the name first and ask Tony.
- **Possible next features:**
  - `asor mcp` (serve a generated agent as an MCP tool),
  - an Agent Gateway invoker,
  - JWT-bearer auth,
  - a "regenerate all" flow for when agents change in ASOR.
