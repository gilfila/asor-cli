import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { configPath, DEFAULT_HOST, readConfigFile, saveProfile, writeConfigFile, type Profile } from '../config.js';
import { createContext, verifySavedProfile, type Context } from '../context.js';
import { CliError, toCliError } from '../errors.js';
import { a2aInvoker, agentHeaders } from '../invoke.js';
import { successEnvelope } from '../output.js';
import { resolveAgent } from '../resolve.js';
import { summarize } from '../types.js';
import { VERSION } from '../version.js';
import { commandName, generateWrapper, surfaceSnippets } from '../wrap.js';
import { openBrowser } from '../open.js';
import { zipDirectory } from './zip.js';

export interface UiOptions {
  port?: number;
  /** Profile to start with. The page can switch profiles. */
  profile?: string;
  /** Default parent folder for generated CLIs. */
  outRoot?: string;
  open?: boolean;
  log?: (message: string) => void;
}

export interface UiServer {
  url: string;
  close: () => Promise<void>;
}

const MAX_BODY = 1024 * 1024;

/**
 * Serves the agent picker: a single page plus a small JSON API on 127.0.0.1.
 *
 * The API can read credentials and write files, so every request must carry the random session token printed in
 * the terminal URL, and the Host header must be the loopback address (this blocks DNS-rebinding pages from reaching it).
 */
export async function startUi(opts: UiOptions = {}): Promise<UiServer> {
  const token = randomBytes(24).toString('base64url');
  const nonce = randomBytes(16).toString('base64');
  // page.html is copied next to this file by the build (scripts/copy-assets.mjs). It is small, so it is read per
  // request, which also means edits show up on reload.
  const page = () => readFileSync(new URL('./page.html', import.meta.url), 'utf8').replace('<script>', `<script nonce="${nonce}">`);
  const outRoot = resolve(opts.outRoot ?? join(process.cwd(), 'asor-agents'));
  const generated = new Map<string, { outDir: string; command: string }>();
  const log = opts.log ?? (() => {});
  let port = 0;

  const tokenOk = (value: string | null | undefined) => {
    if (!value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const ctxFor = (profile: string | undefined): Context => createContext(profile ? { profile } : {});

  const handlers: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    'GET /api/status': async (_req, url) => {
      const file = readConfigFile();
      const profiles = Object.entries(file.profiles).map(([name, p]) => ({ name, tenant: p.tenant ?? null, host: p.host ?? DEFAULT_HOST, default: name === file.defaultProfile }));
      const requested = url.searchParams.get('profile') ?? opts.profile ?? undefined;
      try {
        const ctx = ctxFor(requested);
        return {
          configured: true,
          version: VERSION,
          profile: ctx.cfg.profileName,
          profileSaved: ctx.cfg.profileExists,
          tenant: ctx.cfg.tenant,
          host: ctx.cfg.host,
          profiles,
          outRoot,
          configPath: configPath(),
        };
      } catch (err) {
        const e = toCliError(err);
        return { configured: false, version: VERSION, profiles, outRoot, configPath: configPath(), error: { message: e.message, hint: e.hint ?? null } };
      }
    },

    'POST /api/login': async (req) => {
      const body = (await readJson(req)) as Profile & { profile?: string; makeDefault?: boolean };
      const name = (body.profile || 'default').trim();
      if (!/^[\w.-]+$/.test(name)) throw new CliError('usage', 'Profile names may use letters, digits, dot, dash, and underscore.');
      const existing = readConfigFile().profiles[name] ?? {};
      const profile: Profile = {
        host: body.host?.trim() || existing.host || DEFAULT_HOST,
        tenant: body.tenant?.trim() || existing.tenant,
        clientId: body.clientId?.trim() || existing.clientId,
        clientSecret: body.clientSecret || existing.clientSecret,
        refreshToken: body.refreshToken || existing.refreshToken,
        tokenUrl: body.tokenUrl?.trim() || existing.tokenUrl,
      };
      const missing = (['tenant', 'clientId', 'clientSecret', 'refreshToken'] as const).filter((k) => !profile[k]);
      if (missing.length) throw new CliError('usage', `Missing: ${missing.join(', ')}.`);
      // Save, verify, and roll back if Workday rejects it, so a typo never replaces a working profile.
      const before = readConfigFile();
      saveProfile(name, profile, { makeDefault: Boolean(body.makeDefault) });
      let agents: number;
      try {
        agents = (await verifySavedProfile(name)).agents;
      } catch (err) {
        writeConfigFile(before);
        throw err;
      }
      log(`saved and verified profile "${name}" (${agents} agents)`);
      return { ok: true, profile: name, agents };
    },

    'GET /api/agents': async (_req, url) => {
      const ctx = ctxFor(url.searchParams.get('profile') ?? opts.profile);
      const agents = await ctx.client.listAgents();
      return agents.map((card) => ({ ...summarize(card), command: safeCommand(card.name) }));
    },

    'GET /api/agent': async (_req, url) => {
      const ref = url.searchParams.get('ref');
      if (!ref) throw new CliError('usage', 'ref is required.');
      const ctx = ctxFor(url.searchParams.get('profile') ?? opts.profile);
      const card = await resolveAgent(ctx.client, ref);
      const support = a2aInvoker.supports(card);
      return { card, invocable: support.ok, endpoint: support.ok ? support.endpoint : null, reason: support.ok ? null : support.reason, command: safeCommand(card.name), outDir: join(outRoot, safeCommand(card.name)) };
    },

    'POST /api/invoke': async (req) => {
      const body = (await readJson(req)) as { ref?: string; message?: string; contextId?: string; taskId?: string; profile?: string; skill?: string };
      if (!body.ref || !body.message?.trim()) throw new CliError('usage', 'Pick an agent and type a message.');
      const ctx = ctxFor(body.profile ?? opts.profile);
      const card = await resolveAgent(ctx.client, body.ref);
      const result = await a2aInvoker.invoke(
        card,
        { text: body.message, ...(body.contextId ? { contextId: body.contextId } : {}), ...(body.taskId ? { taskId: body.taskId } : {}), ...(body.skill ? { skill: body.skill } : {}) },
        { timeoutMs: 120_000, headers: await agentHeaders(ctx.cfg, ctx.tokens) },
      );
      const ok = result.state === 'completed' || result.state === 'input-required' || result.state === 'auth-required';
      return successEnvelope(card, result, ok);
    },

    'POST /api/generate': async (req) => {
      const body = (await readJson(req)) as { ref?: string; command?: string; outDir?: string; profile?: string; pinProfile?: boolean; force?: boolean };
      if (!body.ref) throw new CliError('usage', 'Pick an agent to generate a CLI for.');
      const ctx = ctxFor(body.profile ?? opts.profile);
      const card = await resolveAgent(ctx.client, body.ref);
      const command = commandName(card, body.command?.trim() || undefined);
      const outDir = resolve(body.outDir?.trim() || join(outRoot, command));
      const pin = body.pinProfile && ctx.cfg.profileExists ? ctx.cfg.profileName : undefined;
      let result;
      try {
        result = generateWrapper(card, { outDir, command, force: Boolean(body.force), ...(pin ? { profile: pin } : {}) });
      } catch (err) {
        if (err instanceof CliError && /already exists/.test(err.message)) {
          throw new CliError('usage', `${outDir} already exists.`, { hint: 'Open the agent and tick "Overwrite if the folder exists", or choose another output folder.' });
        }
        throw err;
      }
      const id = randomBytes(8).toString('hex');
      generated.set(id, { outDir: result.outDir, command: result.command });
      log(`generated ${result.command} -> ${result.outDir}`);
      return {
        ...result,
        downloadId: id,
        invocable: a2aInvoker.supports(card).ok,
        snippets: surfaceSnippets(result, { tenant: ctx.cfg.tenant, ...(pin ? { profile: pin } : {}) }),
      };
    },
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendText(res, 403, 'Forbidden host.');

    if (req.method === 'GET' && url.pathname === '/') {
      if (!tokenOk(url.searchParams.get('t'))) return sendText(res, 403, 'Open the full URL printed by `asor ui` (it includes a session token).');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return res.end(page());
    }

    if (req.method === 'GET' && url.pathname === '/download') {
      if (!tokenOk(url.searchParams.get('t'))) return sendText(res, 403, 'Forbidden.');
      const entry = generated.get(url.searchParams.get('id') ?? '');
      if (!entry || !existsSync(entry.outDir)) return sendText(res, 404, 'Unknown or deleted package.');
      const zip = zipDirectory(entry.outDir, entry.command);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${entry.command}.zip"`, 'Content-Length': zip.length });
      return res.end(zip);
    }

    const handler = handlers[`${req.method} ${url.pathname}`];
    if (!handler) return sendJson(res, 404, { error: { message: 'Not found' } });
    if (!tokenOk(req.headers['x-asor-token'] as string | undefined)) return sendJson(res, 403, { error: { message: 'Missing or wrong session token.' } });
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) return sendJson(res, 415, { error: { message: 'Expected JSON.' } });

    handler(req, url).then(
      (data) => sendJson(res, 200, data),
      (err) => {
        const e = toCliError(err);
        sendJson(res, e.kind === 'usage' ? 400 : 502, { error: { kind: e.kind, message: e.message, hint: e.hint ?? null } });
      },
    );
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  if (opts.open) openBrowser(url);

  return {
    url,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function safeCommand(name: string | undefined): string {
  try {
    return commandName({ name: name ?? '' });
  } catch {
    return 'asor-agent';
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new CliError('usage', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new CliError('usage', 'Invalid JSON body.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}


