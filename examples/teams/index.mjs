// A Microsoft Teams bot (Bot Framework) that answers with a Workday ASOR agent through the asor CLI.
// Each Teams conversation maps to one A2A context, so follow-up messages keep the agent's memory.
import express from 'express';
import { ActivityHandler, CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext } from 'botbuilder';
import { askAgent } from '../shared/asor-runner.mjs';

const { PORT = '3978', ASOR_DEFAULT_AGENT, ASOR_WRAPPED_BIN, TEAMS_ALLOWED_AAD_IDS = '' } = process.env;
if (!ASOR_DEFAULT_AGENT && !ASOR_WRAPPED_BIN) {
  console.error('Set ASOR_DEFAULT_AGENT (agent id or slug) or ASOR_WRAPPED_BIN (a CLI from `asor wrap`).');
  process.exit(1);
}

// Reads MicrosoftAppId / MicrosoftAppPassword / MicrosoftAppType / MicrosoftAppTenantId from the environment.
const adapter = new CloudAdapter(new ConfigurationBotFrameworkAuthentication(process.env));
adapter.onTurnError = async (context, error) => {
  console.error('[onTurnError]', error);
  await context.sendActivity('Sorry, something went wrong talking to Workday.');
};

/** Entra ID object ids allowed to use the bot. Empty = nobody (Workday data is sensitive). */
const allowed = new Set(TEAMS_ALLOWED_AAD_IDS.split(',').map((s) => s.trim()).filter(Boolean));
const conversations = new Map(); // conversation.id -> { contextId, pendingTaskId }

class AsorBot extends ActivityHandler {
  constructor() {
    super();
    this.onMessage(async (context, next) => {
      const from = context.activity.from?.aadObjectId;
      if (!from || !allowed.has(from)) {
        await context.sendActivity('You are not allowed to use this Workday agent.');
        return next();
      }
      const message = TurnContext.removeRecipientMention(context.activity)?.trim() ?? context.activity.text?.trim();
      if (!message) return next();

      await context.sendActivity({ type: 'typing' });
      const key = context.activity.conversation.id;
      const convo = conversations.get(key) ?? {};
      const result = await askAgent({
        ...(ASOR_WRAPPED_BIN ? { wrappedBin: ASOR_WRAPPED_BIN } : { agent: ASOR_DEFAULT_AGENT }),
        message,
        contextId: convo.contextId,
        taskId: convo.pendingTaskId,
      });
      conversations.set(key, {
        contextId: result.contextId ?? convo.contextId,
        pendingTaskId: result.state === 'input-required' ? result.taskId : undefined,
      });

      if (result.ok) await context.sendActivity(result.text || '(the agent returned no text)');
      else await context.sendActivity(`⚠️ ${result.error?.message ?? 'Something went wrong.'}`);
      await next();
    });
  }
}

const bot = new AsorBot();
const app = express();
app.post('/api/messages', express.json(), (req, res) => adapter.process(req, res, (context) => bot.run(context)));
app.listen(Number(PORT), () => console.log(`asor Teams bot listening on http://localhost:${PORT}/api/messages`));
