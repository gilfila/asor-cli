# asor-cli

**Use Workday ASOR agents from anything that can run a command.**

`asor` logs into a Workday tenant, lists the agents registered in the **Agent System of Record (ASOR)**, and calls them over the [A2A protocol](https://a2a-protocol.org). It can also **wrap a single agent as its own CLI**: a small package with a tool definition and a `SKILL.md`. You can hand that package to a Slack bot, a Teams bot, Claude Code, a cron job, or a CI pipeline, and it can use the agent without knowing anything about Workday.

```text
                ┌──────────── Workday tenant ────────────┐
 asor login ──▶ │ OAuth token  ──▶  ASOR /agentDefinition │
                └───────────────────────┬────────────────┘
                                        │ agent card: name, skills, url
 asor invoke ─────────── A2A JSON-RPC ──▼──▶  the agent's endpoint
 asor wrap   ──▶ benefits-helper  (bin + tool.json + SKILL.md)
                        ▲
      Slack · Teams · Claude Code · cron · CI · anything with a shell
```

> **Status: early (0.1).** The full test suite runs against the bundled mock tenant. The ASOR endpoints and headers come from Workday's published [ASOR API spec (v1.2)](https://github.com/Workday/asor) and from working registration code. Please [open an issue](https://github.com/gilfila/asor-cli/issues) with what you see on a real tenant.
>
> This is an independent open-source project. It is **not affiliated with or endorsed by Workday**.

## Install

```bash
npm install -g github:gilfila/asor-cli    # needs Node.js 22+
asor --help
```

To install from a clone instead, run `npm install && npm run build && npm link`.

## Quickstart

```bash
asor login                      # host, tenant alias, API client id/secret, refresh token
asor whoami                     # checks the token exchange and the ASOR call
asor agents list
asor agents get benefits-helper
asor invoke benefits-helper "When does open enrollment start?"
```

You can try it without a tenant using the bundled mock tenant:

```bash
npm run mock        # prints the ASOR_* variables to export, then leave it running
asor agents list
asor invoke echo "hello"
asor invoke echo --stream "hello"
```

## Commands

| Command | What it does |
|---|---|
| `asor login [--profile p]` | Saves credentials to a profile that only you can read. It prompts for anything missing, and `--from-env` imports the `ASOR_*` variables. |
| `asor whoami` | Shows the resolved config with secrets masked, then tests the token exchange and an ASOR call. The errors include fix-it hints. |
| `asor profiles` / `asor logout` | Lists or deletes saved profiles. |
| `asor agents list` | Lists agents with provider, skills, and whether each is **invocable** (has an A2A endpoint). |
| `asor agents get <agent>` | Shows the full definition and skills. |
| `asor agents register --file card.json` | Registers or updates an agent. ASOR upserts when name, provider, and version match. |
| `asor invoke <agent> [message]` | Asks the agent. The prompt comes from the argument, or from **stdin**. |
| `asor wrap <agent> --out dir` | Generates a standalone CLI for one agent. |

`<agent>` can be an id, the exact name, a slug (`benefits-helper`), or any unique part of the name.

### `invoke` options

| Option | |
|---|---|
| `--json` | Prints one JSON envelope: `{ok, agent, contextId, taskId, state, text, artifacts, error}`. |
| `--stream` | Uses `message/stream` (SSE). With `--json` the output is JSON Lines, and the last line is the envelope, tagged `"type":"result"`. |
| `--context-id <id>` | Continues a conversation. |
| `--task-id <id>` | Answers a task that is in `input-required`. |
| `--skill <id>` | Targets a skill. It is sent as message metadata `skillId`. |
| `--timeout <s>` | Sets the timeout. The default is 120. Long-running tasks are polled with `tasks/get`. |
| `--agent-auth none\|workday\|bearer` | Sets the credential sent to the **agent's** endpoint (see Security). |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | OK. This includes `input-required`: check `state`. |
| 1 | Unexpected error |
| 2 | Usage error or ambiguous agent name |
| 3 | Auth or config problem. Don't retry. |
| 4 | Agent not found, or not invocable |
| 5 | The agent's task failed, was rejected, or timed out |

## Wrap an agent for any surface

```bash
asor wrap benefits-helper --out ./benefits-helper
```

The command generates this package:

```text
benefits-helper/
  bin/benefits-helper.js   CLI pinned to the agent (no dependencies; Node 22+)
  lib/                     the asor runtime, vendored
  tool.json                function-calling tool definition (JSON Schema input + how to invoke)
  SKILL.md                 drop-in skill for Claude Code and other agents
  README.md
  agent-card.json          the definition it was generated from
```

```bash
npm install -g ./benefits-helper
benefits-helper ask "When does open enrollment start?"
echo "When does open enrollment start?" | benefits-helper ask --json
benefits-helper info
benefits-helper skills
```

### Surface recipes

| Surface | How |
|---|---|
| **Slack** | [`examples/slack-bolt`](examples/slack-bolt): Bolt in Socket Mode, with `/asor list`, `/asor <agent> <msg>`, and threaded conversations. |
| **Microsoft Teams** | [`examples/teams`](examples/teams): a Bot Framework bot. One Teams conversation maps to one A2A context. |
| **Claude Code / agents** | [`examples/claude-skill`](examples/claude-skill): copy the wrapped `SKILL.md` into `.claude/skills/`. |
| **Any LLM tool-calling bot** | Register `tool.json`, run `invocation.command` with the message on stdin, and return `text`. |
| **Scripts / cron / CI** | `echo "..." \| asor invoke <agent> --json \| jq -r .text`. Use the exit code to decide what happens next. |
| **Node code** | `import { createContext, resolveAgent, a2aInvoker } from 'asor-cli'`. This skips the subprocess entirely. |

The bot examples share [`examples/shared/asor-runner.mjs`](examples/shared/asor-runner.mjs), a small, safe way to call the CLI from a bot. Run `node examples/shared/demo.mjs` to exercise it against the mock tenant.

## Tenant setup

`asor` authenticates with the OAuth 2.0 **refresh-token grant** against your tenant's agent host.

| Setting | Default |
|---|---|
| Host | `us.agent.workday.com`. Use your data center's agent host. |
| Token URL | `https://{host}/auth/oauth2/{tenant}/token` |
| ASOR API | `https://{host}/asor/v1` |
| Tenant header | `wd-agent-tenant-alias: {tenant}` |

To prepare the tenant (task names vary slightly by release):

1. **Create an integration user.** Create an Integration System User (or Agent Service User) for the bot. Put it in a security group that has:
   - **Setup: Agents** (View) to list and get agents,
   - **Development**, only if you will use `agents register`.
2. **Register an API client.** Register an API client for integrations with the **Agent System of Record** scope. Also add any functional-area scopes your agents' Workday tools need.
3. **Issue a refresh token.** Issue one for the integration user under *Manage Refresh Tokens for Integrations*.
4. **Log in.** Run `asor login` with the tenant alias, client id, client secret, and refresh token, then run `asor whoami`.

If your tenant uses a different token endpoint, such as the classic `https://{host}/ccx/oauth2/{tenant}/token`, set `--token-url` or `ASOR_TOKEN_URL`. If you already have an access token from elsewhere, set `ASOR_ACCESS_TOKEN` to skip the exchange.

If Workday **rotates** the refresh token, `asor` saves the new one to your profile. When the token came from `ASOR_REFRESH_TOKEN`, the new one can't be saved, so asor prints a warning and you have to update the secret yourself.

### Environment variables

Bots usually run on environment variables alone, with no config file. The variables override the saved profile field by field.

| Variable | |
|---|---|
| `ASOR_TENANT`, `ASOR_CLIENT_ID`, `ASOR_CLIENT_SECRET`, `ASOR_REFRESH_TOKEN` | Credentials |
| `ASOR_HOST`, `ASOR_TOKEN_URL`, `ASOR_BASE_URL` | Endpoints |
| `ASOR_ACCESS_TOKEN` | A pre-minted token. The exchange is skipped. |
| `ASOR_PROFILE`, `ASOR_CONFIG_DIR` | Profile selection and config location. The config lives in `%APPDATA%\asor-cli` on Windows and `~/.config/asor-cli` elsewhere. |
| `ASOR_AGENT_AUTH`, `ASOR_AGENT_TOKEN` | Credential for agent endpoints |
| `ASOR_NO_TOKEN_CACHE=1` | Turns off the on-disk access-token cache |

## How invocation works

ASOR agent definitions are A2A **Agent Cards**. The CLI takes the card's `url`, or a `JSONRPC` entry in `additionalInterfaces`, and speaks A2A JSON-RPC to it:

- `message/send` with `blocking: true`,
- `tasks/get` polling for long-running tasks,
- `message/stream` when you pass `--stream`.

Agents with no callable endpoint are still listed, with `invocable: no`. This typically means Workday-built agents that run inside the tenant. The invoker is behind a small interface, so other transports can be added later (Workday Agent Gateway, MCP).

## Security

- **Secrets stay on disk with owner-only permissions.** They live in a mode-0600 profile and a separate token cache. Neither is printed; `whoami` masks them.
- **Prompts can stay off the command line.** They can come from stdin, which keeps them out of process listings and shell history. The bot runner always does this, spawns without a shell, and puts `--` before the agent name.
- **Your Workday token isn't forwarded by default.** An agent's `url` may point at a third party, so `--agent-auth` defaults to `none`. Choose `workday` only for endpoints you trust with that token, or use `bearer` with `ASOR_AGENT_TOKEN`.
- **Workday access is shared.** A bot gives everyone who can talk to it the integration user's Workday access. Scope that user narrowly, and use the allow-lists in the examples.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
npm install
npm test          # builds, then runs node:test against the mock tenant
npm run mock      # mock tenant on :4010 (set PORT to change)
```

The runtime has no dependencies: it uses native `fetch`, `node:util` `parseArgs`, and `node:test`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
