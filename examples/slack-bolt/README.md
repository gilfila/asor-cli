# Slack example

A [Bolt](https://tools.slack.dev/bolt-js/) app in Socket Mode that puts ASOR agents in Slack by running the `asor` CLI.

| In Slack | What happens |
|---|---|
| `/asor list` | Lists the tenant's agents (only you see it) |
| `/asor benefits-helper when is open enrollment?` | Asks that agent (only you see it) |
| `@asor when is open enrollment?` | Asks `ASOR_DEFAULT_AGENT` and answers in a thread. Replies in the thread continue the conversation, including `input-required` follow-ups. |

## Setup

1. Build asor at the repo root: `npm install && npm run build`.
2. Create a Slack app from this manifest (**api.slack.com/apps → Create New App → From a manifest**):

   ```yaml
   display_information:
     name: asor
   features:
     bot_user:
       display_name: asor
     slash_commands:
       - command: /asor
         description: Ask a Workday agent
         usage_hint: "list | <agent> <message>"
   oauth_config:
     scopes:
       bot: [app_mentions:read, chat:write, commands, channels:history, groups:history]
   settings:
     event_subscriptions:
       bot_events: [app_mention, message.channels, message.groups]
     socket_mode_enabled: true
   ```

3. Install the app to your workspace. Copy the bot token (`xoxb-`), then create an app-level token (`xapp-`) with `connections:write`.
4. Copy `.env.example` to `.env` and fill it in, then:

   ```bash
   npm install
   npm start
   ```

## Security notes

- **Allow-list.** Only user ids in `SLACK_ALLOWED_USER_IDS` can use the bot. If the list is empty, nobody can.
- **No shell.** The runner (`../shared/asor-runner.mjs`) spawns asor without a shell and sends the user's text on stdin. It also puts `--` before the agent name, so Slack text can never become a command or a flag.
- **Secrets stay put.** `SLACK_*` variables are removed from the child's environment. asor only sees the `ASOR_*` variables.
- **Answers are ephemeral.** `/asor` replies are visible only to the person who asked. Mention replies go in a thread, so only invite the bot to channels where that content is appropriate.
- **Workday access is shared.** The Workday integration user's permissions apply to everyone who can talk to the bot. Scope that user to exactly what the bot should see.
