# Changelog

## 0.2.0 — 2026-09-24

The project's focus is now **one CLI per agent**.

- **`asor ui`:** a local agent picker (loopback-only, protected by a session token) where you:
  - connect a tenant,
  - browse ASOR agents,
  - try them in a chat,
  - generate a CLI for one or many,
  - copy per-surface recipes, or download the CLI as a `.zip`.
- **`asor wrap` improvements:**
  - With no agent, it shows an interactive picker that accepts `1,3`, `1-3`, or `all`.
  - `--out` is optional and defaults to `./asor-agents/<command>`.
  - `asor generate` is a new alias.
  - It prints install and usage recipes.
- **Smaller generated CLIs:** they no longer vendor the generator, the UI, or the `asor` router.
- **Fix:** `asor login` now verifies the profile exactly as entered. Before, `ASOR_*` environment variables could override it during verification, so bad credentials could pass.

## 0.1.0 — 2026-09-24

The first release.

- **Login and profiles.** `asor login`, `whoami`, `profiles`, and `logout`. Login uses the refresh-token grant. Rotated refresh tokens are saved, and the access-token cache lives on disk.
- **Agents.** `asor agents list|get|register` against the Workday ASOR API (`/asor/v1/agentDefinition`).
- **Invoke.** `asor invoke` speaks A2A JSON-RPC (`message/send`, `message/stream`, and `tasks/get` polling). It supports stdin prompts, a `--json` envelope, and stable exit codes.
- **Wrap.** `asor wrap` generates a standalone CLI for one agent, together with a `tool.json` and a `SKILL.md`.
- **Mock tenant and examples.** A mock tenant for tests and demos, plus Slack (Bolt), Teams (Bot Framework), and Claude Code examples.
