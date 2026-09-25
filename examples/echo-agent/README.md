# Echo agent: a free, stateless A2A test agent

A dependency-free [A2A](https://a2a-protocol.org) (v0.3, JSON-RPC) agent you can register in ASOR to test asor-cli end to end, from ASOR lookup through the A2A call to a generated CLI. It needs no Workday tools and no database.

It's deployed at **https://asor-echo-agent.vercel.app** (agent card: [`/.well-known/agent-card.json`](https://asor-echo-agent.vercel.app/.well-known/agent-card.json)). It runs on Vercel's free Hobby plan, which can't incur charges. If the plan's limits are hit, the endpoint just fails.

| You send | It answers |
|---|---|
| `hello` | `Echo: hello` (completed task) |
| `hello` with `--skill shout` | `Echo: HELLO` |
| anything containing `ask` | `input-required`: "Which year do you mean?". Reply with the same `--context-id` and `--task-id`. |
| anything containing `fail` | a failed task (exit code 5) |
| `--stream` | the same answer, streamed as Server-Sent Events |

## Deploy your own

```bash
cd examples/echo-agent
npx vercel deploy --prod      # Vercel Hobby (free); no build step, no dependencies
```

Then set `url` in [`asor-card.json`](asor-card.json) to `https://<your-project>.vercel.app/api/a2a`, and register it:

```bash
asor agents register --file examples/echo-agent/asor-card.json
asor agents list
asor wrap echo-test          # → ./asor-agents/asor-cli-echo-test
```

## Notes

- **ASOR needs one `workdayConfig` entry per skill.** Without one, registration fails with *"Ensure that each skill in workdayConfig has a matching skills entry with the same skill ID."* `asor agents register` adds a default entry (`Mode=Delegate`, no Workday resources) for any skill that lacks one.
- **Nothing is stored.** A follow-up carries its `taskId`, and that's all the agent needs, so `tasks/get` always answers "task not found". Tasks are never left running.
- **Requests are capped at 8 KB,** and the function times out after 10 s.
