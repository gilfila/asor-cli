// A Slack app that puts Workday ASOR agents in Slack, through the asor CLI.
//
//   /asor list                     -> agents in the tenant
//   /asor <agent> <message>        -> ask an agent (agent = id or slug, e.g. benefits-helper)
//   @bot <message>                 -> ask ASOR_DEFAULT_AGENT, threaded; replies in the thread continue the conversation
//
// Runs in Socket Mode, so no public URL is needed. See README.md for the Slack app manifest.
import bolt from '@slack/bolt';
import { askAgent, listAgents } from '../shared/asor-runner.mjs';

const { App } = bolt;
const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_ALLOWED_USER_IDS = '',
  SLACK_ALLOWED_CHANNEL_IDS = '',
  ASOR_DEFAULT_AGENT,
  ASOR_WRAPPED_BIN, // optional: a CLI from `asor wrap`; pins the bot to that one agent
} = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('Set SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-). See README.md.');
  process.exit(1);
}

const allowedUsers = new Set(SLACK_ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean));
const allowedChannels = new Set(SLACK_ALLOWED_CHANNEL_IDS.split(',').map((s) => s.trim()).filter(Boolean));

/** Workday data is sensitive. An empty allow-list denies everyone. */
function allowed(user, channel) {
  return allowedUsers.has(user) && (allowedChannels.size === 0 || allowedChannels.has(channel));
}

/** Slack thread -> A2A conversation, so replies in a thread keep the agent's context. In memory only. */
const threads = new Map();

function format(result) {
  if (result.ok && result.state === 'input-required') return `${result.text}\n_(the agent needs more information — reply in this thread)_`;
  if (result.ok) return result.text || '_(the agent returned no text)_';
  return `:warning: ${result.error?.message ?? 'Something went wrong.'}${result.error?.hint ? `\n_${result.error.hint}_` : ''}`;
}

const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });

app.command('/asor', async ({ command, ack, respond }) => {
  await ack();
  if (!allowed(command.user_id, command.channel_id)) return respond({ response_type: 'ephemeral', text: 'You are not allowed to use Workday agents here.' });

  const text = command.text.trim();
  if (!text || text === 'help') {
    return respond({ response_type: 'ephemeral', text: '`/asor list` · `/asor <agent> <message>`' });
  }
  if (text === 'list') {
    const agents = await listAgents();
    if (!Array.isArray(agents)) return respond({ response_type: 'ephemeral', text: format(agents) });
    const lines = agents.map((a) => `• *${a.name}*${a.invocable ? '' : ' _(not invocable)_'} — ${a.description || 'no description'}`);
    return respond({ response_type: 'ephemeral', text: lines.join('\n') || 'No agents registered.' });
  }

  const [agent, ...rest] = text.split(/\s+/);
  const message = rest.join(' ');
  if (!message) return respond({ response_type: 'ephemeral', text: 'Usage: `/asor <agent> <message>`' });
  const result = await askAgent({ agent, message });
  return respond({ response_type: 'ephemeral', text: format(result) });
});

async function handleThreadedMessage({ user, channel, text, ts, thread_ts }, say) {
  if (!allowed(user, channel)) return;
  const message = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!message) return;
  const threadTs = thread_ts ?? ts;
  const convo = threads.get(threadTs) ?? {};
  const result = await askAgent({
    ...(ASOR_WRAPPED_BIN ? { wrappedBin: ASOR_WRAPPED_BIN } : { agent: ASOR_DEFAULT_AGENT }),
    message,
    contextId: convo.contextId,
    taskId: convo.pendingTaskId,
  });
  threads.set(threadTs, {
    contextId: result.contextId ?? convo.contextId,
    pendingTaskId: result.state === 'input-required' ? result.taskId : undefined,
  });
  await say({ text: format(result), thread_ts: threadTs });
}

app.event('app_mention', async ({ event, say }) => {
  if (!ASOR_DEFAULT_AGENT && !ASOR_WRAPPED_BIN) {
    return say({ text: 'Set ASOR_DEFAULT_AGENT (or ASOR_WRAPPED_BIN) to talk to an agent by mention. `/asor <agent> <message>` works anyway.', thread_ts: event.ts });
  }
  await handleThreadedMessage(event, say);
});

// Follow-ups in a thread the bot already answered don't need another @mention.
app.message(async ({ message, say }) => {
  if (message.subtype || !message.thread_ts || !threads.has(message.thread_ts)) return;
  await handleThreadedMessage(message, say);
});

await app.start();
console.log('asor Slack bot is running (Socket Mode).');
