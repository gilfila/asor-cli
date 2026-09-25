// A tiny, stateless A2A (v0.3) JSON-RPC agent for testing asor-cli end to end.
// Deployed on Vercel's free Hobby plan; there is no database and nothing to pay for. If it is overloaded it simply fails.
//
// What it does:
//   message/send    "hello"            -> completed task, artifact "Echo: hello"
//                   skill "shout"      -> "Echo: HELLO"
//                   text with "ask"    -> input-required ("Which year do you mean?"); reply with the same taskId
//                   text with "fail"   -> failed task
//   message/stream  same answer, streamed as Server-Sent Events
//   tasks/get       tasks are never left running, so this always answers TaskNotFound
//   GET             returns the agent card
import { randomUUID } from 'node:crypto';
import { agentCard } from './agent-card.js';

const MAX_BODY = 8 * 1024; // keep it cheap: messages are short test strings
const MAX_TEXT = 2000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const rpcResult = (res, id, result) => json(res, 200, { jsonrpc: '2.0', id, result });
const rpcError = (res, id, code, message) => json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const agentMessage = (text) => ({ kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text }] });

function task(id, contextId, state, { statusText, answer } = {}) {
  return {
    kind: 'task',
    id,
    contextId,
    status: { state, timestamp: new Date().toISOString(), ...(statusText ? { message: agentMessage(statusText) } : {}) },
    ...(answer ? { artifacts: [{ artifactId: 'answer', name: 'answer', parts: [{ kind: 'text', text: answer }] }] } : {}),
  };
}

/** Decides the reply for one user message. Stateless: a follow-up carries its taskId, which is all we need. */
function respond(message) {
  const text = (message?.parts ?? [])
    .filter((p) => p?.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')
    .slice(0, MAX_TEXT);
  const contextId = typeof message?.contextId === 'string' ? message.contextId : randomUUID();
  const followUp = typeof message?.taskId === 'string';
  const taskId = followUp ? message.taskId : randomUUID();
  const shout = message?.metadata?.skillId === 'shout';
  const answer = `Echo: ${shout ? text.toUpperCase() : text}`;

  if (/\bfail\b/i.test(text)) return task(taskId, contextId, 'failed', { statusText: 'Failed on purpose (the message contained "fail").' });
  if (/\bask\b/i.test(text) && !followUp) return task(taskId, contextId, 'input-required', { statusText: 'Which year do you mean?' });
  return task(taskId, contextId, 'completed', { answer });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return json(res, 200, agentCard(req));
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST for JSON-RPC, GET for the agent card.' });

  let rpc;
  try {
    rpc = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.code === 413) return json(res, 413, { error: 'Request too large for this test agent.' });
    return rpcError(res, null, -32700, 'Parse error');
  }
  const { id, method, params } = rpc ?? {};

  if (method === 'message/send') {
    if (!params?.message) return rpcError(res, id, -32602, 'params.message is required');
    return rpcResult(res, id, respond(params.message));
  }

  if (method === 'message/stream') {
    if (!params?.message) return rpcError(res, id, -32602, 'params.message is required');
    const final = respond(params.message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    const emit = (result) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
    emit(task(final.id, final.contextId, 'submitted'));
    emit({ kind: 'status-update', taskId: final.id, contextId: final.contextId, status: { state: 'working', message: agentMessage('Thinking…') }, final: false });
    const answer = final.artifacts?.[0]?.parts?.[0]?.text;
    if (answer) {
      const chunks = answer.match(/.{1,8}/gs) ?? [answer];
      chunks.forEach((chunk, i) =>
        emit({ kind: 'artifact-update', taskId: final.id, contextId: final.contextId, append: i > 0, lastChunk: i === chunks.length - 1, artifact: { artifactId: 'answer', parts: [{ kind: 'text', text: chunk }] } }),
      );
    }
    emit({ kind: 'status-update', taskId: final.id, contextId: final.contextId, status: final.status, final: true });
    return res.end();
  }

  if (method === 'tasks/get') return rpcError(res, id, -32001, 'Task not found (this test agent never leaves tasks running)');
  return rpcError(res, id, -32601, `Method not found: ${method}`);
}
