# Microsoft Teams example

A Bot Framework bot that sends each Teams message to one ASOR agent through the `asor` CLI and posts the answer back.
Each Teams conversation becomes one A2A context, so follow-up questions keep the agent's memory.

## Setup

1. Build asor at the repo root: `npm install && npm run build`.
2. Create an **Azure Bot** resource with the single-tenant app type. Note its App ID, a client secret, and your tenant id. Add the **Microsoft Teams** channel.
3. Expose the bot:
   - **Local:** use a dev tunnel, e.g. `devtunnel host -p 3978 --allow-anonymous`.
   - **Hosted:** deploy it anywhere that runs Node 22.

   Set the Azure Bot's messaging endpoint to `https://<host>/api/messages`.
4. Copy `.env.example` to `.env` and fill it in, then:

   ```bash
   npm install
   npm start
   ```

5. Install it in Teams. The quickest route is the Teams Developer Portal: create an app manifest that points at your bot's App ID.

## Security notes

- **Allow-list.** Only the Entra ID object ids in `TEAMS_ALLOWED_AAD_IDS` get answers.
- **Safe spawning.** The runner uses no shell, sends the message on stdin, and puts `--` before the agent name. It also strips `MicrosoftApp*` and `TEAMS_*` from the environment of the asor process.
- **Workday access is shared.** Everyone who can message the bot gets the Workday integration user's access, so scope that user narrowly.
