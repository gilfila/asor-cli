# Changelog

## Unreleased

- **`asor login --authorize`:** a browser sign-in using the OAuth Authorization Code grant with PKCE, which is how ASOR-scoped Workday API clients work.
  - It catches the code on a `http://localhost:<port>/…` redirect. For any other redirect URI (e.g. `https://cb.myworkday.com/cb1`) you paste the address you land on.
  - It saves the refresh token and verifies it with a live ASOR call.
- **Refresh-token expiry:** `asor whoami` shows the auth mode, when you signed in, and when the refresh token expires. An expired token (`invalid_grant`) now tells you to re-run `asor login --authorize`.
- **`agents list|get --json --redact`:** replaces ids, URLs, and names with stable placeholders, so live payloads can be shared or kept as test fixtures.
- **Browser opening on Windows:** it now uses the URL protocol handler rather than `cmd /c start`, so OAuth query strings are no longer mangled.
- **Token requests now send client credentials in the form body (`client_secret_post`) by default.** Workday's agent host rejects an HTTP Basic header alone with `{"error": "Invalid request"}`, which the first live sign-in against a real tenant hit. `--client-auth basic` / `ASOR_CLIENT_AUTH=basic` switches back, and a 400 `Invalid request` now suggests the other method.
- **The secret prompt no longer disappears on Windows** once you start typing.
- **Mock tenant:** it now supports `/auth/authorize/{tenant}` and the `authorization_code` grant, with PKCE and redirect-URI checks.

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
