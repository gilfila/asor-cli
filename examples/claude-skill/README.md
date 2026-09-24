# Claude Code / agent-skill example

Coding agents that can run shell commands, such as Claude Code, Codex, or any agent SDK with a Bash tool, can use a wrapped ASOR agent as a **skill**.

```bash
# 1. Generate a CLI for the agent. It includes a ready-made SKILL.md.
asor wrap benefits-helper --out ./tools/benefits-helper

# 2. Put the command on PATH (or reference bin/benefits-helper.js directly)
npm install -g ./tools/benefits-helper

# 3. Install the skill for Claude Code (project-scoped)
mkdir -p .claude/skills/benefits-helper
cp ./tools/benefits-helper/SKILL.md .claude/skills/benefits-helper/SKILL.md
```

Set `ASOR_TENANT`, `ASOR_CLIENT_ID`, `ASOR_CLIENT_SECRET`, and `ASOR_REFRESH_TOKEN` in the agent's environment, or run `asor login` once on the machine.

When Claude decides the task needs that agent, it runs `printf '%s' "..." | benefits-helper ask --json` and reads the JSON envelope. [`SKILL.md.example`](SKILL.md.example) shows what `asor wrap` generates for the mock "Echo Agent".

## Other LLM hosts

`tool.json` in the wrapped package is a function-calling tool definition with a JSON Schema for `input_schema`. Register it with any tool-calling model: the Claude API, OpenAI, Bedrock, or Vertex. When the model calls the tool:

1. Run `invocation.command` with `invocation.args`.
2. Write the `message` argument to stdin and turn the optional fields into the flags listed in `invocation.flags`.
3. Return the envelope's `text` (or the whole envelope) as the tool result.
