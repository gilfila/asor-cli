// The A2A agent card, served at /.well-known/agent-card.json (and on GET /api/a2a).
// The same fields are what `asor agents register` sends to ASOR (see ../asor-card.json).
export function agentCard(req) {
  const host = req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost';
  const origin = `https://${host}`;
  return {
    protocolVersion: '0.3.0',
    name: 'asor-cli Echo Test',
    description: 'A stateless test agent for asor-cli. It echoes what you send. Say "ask" to get a follow-up question, or "fail" to see a failed task.',
    url: `${origin}/api/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    provider: { organization: 'asor-cli (open source)', url: 'https://github.com/gilfila/asor-cli' },
    documentationUrl: 'https://github.com/gilfila/asor-cli/tree/main/examples/echo-agent',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo the message back.', tags: ['test'], examples: ['hello there'] },
      { id: 'shout', name: 'Shout', description: 'Echo the message back in capitals.', tags: ['test'], examples: ['make this loud'] },
    ],
  };
}

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(JSON.stringify(agentCard(req)));
}
