// End-to-end check of the bot runner against the mock tenant, with no Slack or Teams needed:
//   npm run build && node examples/shared/demo.mjs
import { startMockServer } from '../../dist/mock/server.js';
import { askAgent, listAgents } from './asor-runner.mjs';

const mock = await startMockServer();
Object.assign(process.env, mock.env, { SLACK_BOT_TOKEN: 'xoxb-should-not-leak' });

try {
  const agents = await listAgents();
  console.log('agents:', agents.map((a) => `${a.name}${a.invocable ? '' : ' (not invocable)'}`).join(', '));

  const first = await askAgent({ agent: 'echo', message: 'hello from a bot; $(whoami) `id` "quotes"' });
  console.log('reply:', first.text);

  const injected = await askAgent({ agent: '--agent-auth', message: 'hi' });
  console.log('flag injection attempt:', injected.ok ? 'UNEXPECTEDLY OK' : `rejected (${injected.error.kind})`);

  const question = await askAgent({ agent: 'echo', message: 'please ask me something' });
  console.log(`state: ${question.state} -> "${question.text}"`);
  const answer = await askAgent({ agent: 'echo', message: 'I meant 2026', contextId: question.contextId, taskId: question.taskId });
  console.log(`follow-up: ${answer.state} -> "${answer.text}"`);
} finally {
  await mock.close();
}
