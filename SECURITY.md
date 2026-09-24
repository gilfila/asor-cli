# Security policy

`asor-cli` handles Workday OAuth credentials and can connect enterprise HR and finance data to chat surfaces. Please report security issues privately. Use [GitHub private vulnerability reporting](https://github.com/gilfila/asor-cli/security/advisories/new) rather than a public issue.

## Scope

In scope:
- credential handling (profiles, token cache, rotation, masking),
- leakage of tokens to agent endpoints,
- argument or shell injection through the CLI or the example bot runner,
- the safety of generated wrappers.

The security of Workday itself, of individual agents, and of Slack or Teams is out of scope. Report those to the vendor.

## Design notes

- Profiles and the token cache are written with mode `0600`, and the directory with `0700`. On Windows they live under the user's `%APPDATA%`.
- The Workday access token is sent to an agent endpoint only when `--agent-auth workday` (or `ASOR_AGENT_AUTH=workday`) is set explicitly.
- The example bots enforce allow-lists, spawn without a shell, pass user text on stdin, and strip their own secrets from the child environment.
