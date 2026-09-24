/**
 * A fake Workday tenant for tests and demos: an OAuth token endpoint, the ASOR API, and two A2A agents.
 *
 *   npm run mock        # prints the env vars to point asor at it
 *
 * Agents:
 *   "Echo Agent"         answers "Echo: <message>". The words "slow", "fail", and "ask" in a message trigger
 *                        a polled task, a failed task, and an input-required task. It supports streaming.
 *   "Benefits Helper"    answers with a single A2A Message (no task).
 *   "Workday Native Bot" has no URL, so it is listed but not invocable.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const MOCK_TENANT = 'acme_dev1';
export const MOCK_CLIENT_ID = 'mock-client';
export const MOCK_CLIENT_SECRET = 'mock-secret';
export const MOCK_REFRESH_TOKEN = 'mock-refresh-1';

export interface MockOptions {
  port?: number;
  /** Issue a new refresh token on every exchange. */
  rotateRefreshToken?: boolean;
  /** Return agent lists in pages of this size with a `total`, to exercise paging. */
  pageSize?: number;
  /** Require this bearer token on the A2A endpoints. */
  agentToken?: string;
}

export interface MockState {
  tokenExchanges: number;
  asorRequests: Array<{ method: string; path: string; tenant: string | undefined }>;
  a2aRequests: Array<{ method: string; authorization: string | undefined; body: unknown }>;
  validRefreshTokens: Set<string>;
  validAccessTokens: Set<string>;
  lastIssuedRefreshToken: string;
}

export interface MockServer {
  url: string;
  env: Record<string, string>;
  state: MockState;
  close: () => Promise<void>;
}

interface Card {
  id: string;
  name: string;
  [k: string]: unknown;
}

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const state: MockState = {
    tokenExchanges: 0,
    asorRequests: [],
    a2aRequests: [],
    validRefreshTokens: new Set([MOCK_REFRESH_TOKEN]),
    validAccessTokens: new Set(),
    lastIssuedRefreshToken: MOCK_REFRESH_TOKEN,
  };
  let origin = '';
  const agents: Card[] = [];
  const tasks = new Map<string, { polls: number; mode: string; text: string; contextId: string }>();

  const seed = () => {
    agents.push(
      {
        id: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
        name: 'Echo Agent',
        description: 'Repeats what you say. Useful for testing the CLI plumbing.',
        url: `${origin}/a2a/echo`,
        version: '1.0.0',
        provider: { id: 'Provider=SELF-BUILT', descriptor: 'Acme Labs' },
        platform: { id: 'Platform=OTHER', descriptor: 'Other' },
        capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
          { id: 'echo', name: 'Echo', description: 'Echo the message back.', tags: [{ tag: 'test' }], examples: ['hello there'] },
          { id: 'shout', name: 'Shout', description: 'Echo the message back in capitals.', tags: ['test'] },
        ],
      },
      {
        id: '11112222333344445555666677778888',
        name: 'Benefits Helper',
        description: 'Answers questions about benefits enrollment.',
        url: `${origin}/a2a/benefits`,
        version: '2.1.0',
        provider: { organization: 'Acme HR Tech' },
        platform: 'Platform=AZURE',
        capabilities: { streaming: false },
        skills: [{ id: 'enrollment', name: 'Enrollment questions', description: 'Explains open enrollment dates and plan options.' }],
      },
      {
        id: '99990000aaaabbbbccccddddeeeeffff',
        name: 'Workday Native Bot',
        description: 'A Workday-built agent that runs inside the tenant.',
        version: '1.0.0',
        provider: { id: 'Provider=WORKDAY', descriptor: 'Workday' },
        platform: { id: 'Platform=WORKDAY', descriptor: 'Workday' },
        skills: [{ id: 'native', name: 'Native skill' }],
      },
    );
  };

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse, tenant: string) => {
    const body = new URLSearchParams(await readBody(req));
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    if (tenant !== MOCK_TENANT) return send(res, 404, { error: 'invalid_tenant' });
    if (basic !== `${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`) return send(res, 401, { error: 'invalid_client' });
    if (body.get('grant_type') !== 'refresh_token' || !state.validRefreshTokens.has(body.get('refresh_token') ?? '')) {
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
    }
    state.tokenExchanges += 1;
    const accessToken = `mock-access-${randomUUID()}`;
    state.validAccessTokens.add(accessToken);
    const out: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 };
    if (opts.rotateRefreshToken) {
      state.validRefreshTokens.delete(body.get('refresh_token')!);
      const next = `mock-refresh-${state.tokenExchanges + 1}`;
      state.validRefreshTokens.add(next);
      state.lastIssuedRefreshToken = next;
      out.refresh_token = next;
    }
    send(res, 200, out);
  };

  const handleAsor = async (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) => {
    const tenant = req.headers['wd-agent-tenant-alias'] as string | undefined;
    state.asorRequests.push({ method: req.method ?? '', path, tenant });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!state.validAccessTokens.has(token)) return send(res, 401, { error: 'invalid_token' });
    if (tenant !== MOCK_TENANT) return send(res, 403, { error: 'Tenant alias header missing or wrong' });

    if (path === '/agentDefinition' && req.method === 'GET') {
      if (opts.pageSize) {
        const offset = Number(query.get('offset') ?? 0);
        const limit = Math.min(Number(query.get('limit') ?? opts.pageSize), opts.pageSize);
        return send(res, 200, { total: agents.length, data: agents.slice(offset, offset + limit) });
      }
      return send(res, 200, { total: agents.length, data: agents });
    }
    if (path === '/agentDefinition' && req.method === 'POST') {
      const card = JSON.parse(await readBody(req)) as Card;
      const existing = agents.find((a) => a.name === card.name && a.version === card.version);
      if (existing) {
        Object.assign(existing, card, { id: existing.id });
        return send(res, 201, existing);
      }
      const created = { ...card, id: randomUUID().replace(/-/g, '') };
      agents.push(created);
      return send(res, 201, created);
    }
    const m = /^\/agentDefinition\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const agent = agents.find((a) => a.id === decodeURIComponent(m[1]!));
      return agent ? send(res, 200, agent) : send(res, 404, { error: 'Agent definition not found' });
    }
    send(res, 404, { error: 'not found' });
  };

  const taskObject = (id: string, contextId: string, stateName: string, text?: string, artifactText?: string) => ({
    kind: 'task',
    id,
    contextId,
    status: {
      state: stateName,
      ...(text ? { message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text }] } } : {}),
    },
    ...(artifactText ? { artifacts: [{ artifactId: 'answer', parts: [{ kind: 'text', text: artifactText }] }] } : {}),
  });

  const echoText = (text: string, skill?: string) => `Echo: ${skill === 'shout' ? text.toUpperCase() : text}`;

  const handleA2A = async (req: IncomingMessage, res: ServerResponse, agent: string) => {
    const raw = await readBody(req);
    let rpc: { id?: unknown; method?: string; params?: any };
    try {
      rpc = JSON.parse(raw);
    } catch {
      return send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    state.a2aRequests.push({ method: rpc.method ?? '', authorization: req.headers.authorization, body: rpc });
    if (opts.agentToken && req.headers.authorization !== `Bearer ${opts.agentToken}`) return send(res, 401, { error: 'unauthorized' });
    const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
    const fail = (code: number, message: string) => send(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });

    const message = rpc.params?.message;
    const text: string = (message?.parts ?? []).filter((p: any) => p.kind === 'text').map((p: any) => p.text).join(' ');
    const contextId: string = message?.contextId ?? randomUUID();
    const skill: string | undefined = message?.metadata?.skillId;

    if (agent === 'benefits') {
      if (rpc.method !== 'message/send') return fail(-32601, 'Method not found');
      return reply({ kind: 'message', role: 'agent', messageId: randomUUID(), contextId, parts: [{ kind: 'text', text: `Open enrollment runs Nov 1-15. You asked: ${text}` }] });
    }

    // echo agent
    if (rpc.method === 'tasks/get') {
      const id = rpc.params?.id as string;
      const t = tasks.get(id);
      if (!t) return fail(-32001, 'Task not found');
      t.polls += 1;
      if (t.polls < 2) return reply(taskObject(id, t.contextId, 'working', 'Still thinking…'));
      return reply(taskObject(id, t.contextId, 'completed', undefined, echoText(t.text)));
    }

    if (rpc.method === 'message/send') {
      const taskId = message?.taskId ?? randomUUID();
      if (/\bfail\b/i.test(text)) return reply(taskObject(taskId, contextId, 'failed', 'Something went wrong on purpose.'));
      if (/\bask\b/i.test(text) && !message?.taskId) return reply(taskObject(taskId, contextId, 'input-required', 'Which year do you mean?'));
      if (/\bslow\b/i.test(text)) {
        tasks.set(taskId, { polls: 0, mode: 'slow', text, contextId });
        return reply(taskObject(taskId, contextId, 'working'));
      }
      return reply(taskObject(taskId, contextId, 'completed', undefined, echoText(text, skill)));
    }

    if (rpc.method === 'message/stream') {
      const taskId = randomUUID();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const emit = (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
      emit(taskObject(taskId, contextId, 'submitted'));
      emit({ kind: 'status-update', taskId, contextId, status: { state: 'working', message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: 'Thinking…' }] } }, final: false });
      const answer = echoText(text, skill);
      const chunks = answer.match(/.{1,4}/gs) ?? [answer];
      chunks.forEach((chunk, i) =>
        emit({ kind: 'artifact-update', taskId, contextId, append: i > 0, lastChunk: i === chunks.length - 1, artifact: { artifactId: 'answer', parts: [{ kind: 'text', text: chunk }] } }),
      );
      emit({ kind: 'status-update', taskId, contextId, status: { state: 'completed' }, final: true });
      return res.end();
    }

    fail(-32601, 'Method not found');
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://localhost');
    const path = url.pathname;
    const route = async () => {
      let m: RegExpExecArray | null;
      if (req.method === 'POST' && (m = /^\/auth\/oauth2\/([^/]+)\/token$/.exec(path))) return handleToken(req, res, decodeURIComponent(m[1]!));
      if (path.startsWith('/asor/v1/')) return handleAsor(req, res, path.slice('/asor/v1'.length), url.searchParams);
      if (req.method === 'POST' && (m = /^\/a2a\/(echo|benefits)$/.exec(path))) return handleA2A(req, res, m[1]!);
      send(res, 404, { error: 'not found' });
    };
    route().catch((err) => send(res, 500, { error: String(err) }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  seed();

  return {
    url: origin,
    state,
    env: {
      ASOR_HOST: origin,
      ASOR_TENANT: MOCK_TENANT,
      ASOR_CLIENT_ID: MOCK_CLIENT_ID,
      ASOR_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      ASOR_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function isEntrypoint(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const port = Number(process.env.PORT ?? 4010);
  const mock = await startMockServer({ port });
  const lines = Object.entries(mock.env);
  process.stdout.write(`Mock Workday tenant listening on ${mock.url}\n\nPoint asor at it:\n\n`);
  process.stdout.write(`  # bash\n${lines.map(([k, v]) => `  export ${k}=${v}`).join('\n')}\n\n`);
  process.stdout.write(`  # PowerShell\n${lines.map(([k, v]) => `  $env:${k}="${v}"`).join('\n')}\n\n`);
  process.stdout.write('Then try:  asor agents list  ·  asor invoke echo "hello"  ·  asor invoke echo --stream "hello"\n');
}
