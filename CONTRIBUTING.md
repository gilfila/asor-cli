# Contributing

Thanks for helping. Issues and PRs are welcome, especially reports from real Workday tenants. Please redact tenant names, ids, and anything else that could identify a customer.

## Ground rules

- **No runtime dependencies.** `asor wrap` copies the compiled runtime into every generated CLI, so it has to stay dependency-free. Use Node built-ins such as `fetch`, `node:util` `parseArgs`, and `node:test`.
- **The bot contract is an API.** Treat these as breaking changes that need a major version: the `--json` envelope fields, the exit codes, and the `tool.json` shape.
- **Every behavior gets a test against the mock tenant** (`mock/server.ts`). If a real tenant behaves differently from the mock, change the mock first so it reproduces that behavior.
- **Never log secrets.** Mask anything credential-like with `mask()` from `src/config.ts`.

## Workflow

```bash
npm install
npm test            # tsc build + node:test (dist/test/**/*.test.js)
npm run mock        # interactive mock tenant
node examples/shared/demo.mjs
```

## Layout

| Path | |
|---|---|
| `src/cli.ts` | Command router, help, and exit codes |
| `src/config.ts`, `src/auth.ts` | Profiles, env resolution, refresh-token exchange, rotation, and the token cache |
| `src/asor.ts` | ASOR API client and HTTP error hints |
| `src/a2a.ts`, `src/invoke.ts` | A2A JSON-RPC client (send, stream/SSE, tasks/get) and the invoker interface |
| `src/resolve.ts` | Resolves an agent reference (id, name, slug, or substring) to a card |
| `src/run-invoke.ts` | Shared invoke-and-print logic, including the JSON envelope |
| `src/wrap.ts`, `src/wrapped.ts` | The `asor wrap` generator and the runtime of the generated CLIs |
| `mock/server.ts` | Fake tenant: token endpoint, ASOR API, A2A agents |
| `examples/` | Slack, Teams, and Claude Code integrations |
