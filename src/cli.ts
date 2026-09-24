#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { TokenProvider } from './auth.js';
import { configPath, DEFAULT_HOST, DEFAULT_PROFILE, mask, readConfigFile, removeProfile, resolveConfig, saveProfile, type Profile } from './config.js';
import { createContext, reportError, stderr, stdout, verifySavedProfile, type GlobalFlags } from './context.js';
import { CliError, ExitCode, toCliError } from './errors.js';
import { a2aInvoker } from './invoke.js';
import { renderAgentCard, renderAgentList, renderTable } from './output.js';
import { ask } from './prompt.js';
import { resolveAgent } from './resolve.js';
import { runInvoke } from './run-invoke.js';
import { summarize, type AgentCard } from './types.js';
import { VERSION } from './version.js';
import { commandName, generateWrapper, surfaceSnippets } from './wrap.js';

const HELP = `asor ${VERSION} — turn Workday ASOR agents into their own CLIs

Generate a CLI per agent:
  asor ui                               Open the agent picker in your browser: browse, try, generate
  asor wrap [<agent>] [--out <dir>]     Generate a CLI for one agent (no <agent>: pick from a list)

Set up and explore:
  asor login [--profile <name>]         Save tenant credentials (prompts for anything missing)
  asor whoami                           Show the active profile and test the connection
  asor profiles                         List saved profiles
  asor logout [--profile <name>]        Delete a saved profile
  asor agents list                      List agents registered in the tenant's ASOR
  asor agents get <agent>               Show one agent's definition and skills
  asor agents register --file <card>    Register or update an agent from an A2A agent-card JSON file
  asor invoke <agent> [message]         Send a message to any agent (reads stdin when no message is given)

<agent> is an id, a name, a slug like "benefits-helper", or a unique part of a name.

Global options:
  --profile <name>     Use a saved profile (default: the default profile, or ASOR_PROFILE)
  --json               Machine-readable output on stdout
  -v, --verbose        Debug logging on stderr
  -h, --help           Show help for a command
  --version            Print the version

Environment (overrides the saved profile, so bots need no config file):
  ASOR_HOST ASOR_TENANT ASOR_CLIENT_ID ASOR_CLIENT_SECRET ASOR_REFRESH_TOKEN
  ASOR_TOKEN_URL ASOR_BASE_URL ASOR_ACCESS_TOKEN ASOR_PROFILE ASOR_CONFIG_DIR
  ASOR_AGENT_AUTH ASOR_AGENT_TOKEN ASOR_NO_TOKEN_CACHE

Exit codes: 0 ok · 1 error · 2 usage · 3 auth/config · 4 agent not found or not invocable · 5 agent failed/timed out
`;

const HELP_INVOKE = `Usage: asor invoke <agent> [message] [options]

Sends one message to the agent over A2A and prints its answer. If no message is given (or it is "-"),
the message is read from stdin, which keeps user text out of process listings. Bots should use that.

Options:
  --skill <id>           Target a specific skill (sent as message metadata "skillId")
  --context-id <id>      Continue an earlier conversation
  --task-id <id>         Answer a task that is waiting for input
  --stream               Stream the answer as it is produced (message/stream)
  --timeout <seconds>    Give up after this long (default 120)
  --agent-auth <mode>    Credential for the agent endpoint: none (default), workday (forward the
                         Workday token), bearer (use ASOR_AGENT_TOKEN)
  --json                 Print one JSON envelope: {ok, agent, contextId, taskId, state, text, artifacts, error}.
                         With --stream, print JSON Lines; the last line is the envelope with "type":"result".
`;

const HELP_LOGIN = `Usage: asor login [options]

Saves a profile to ${configPath()} (readable only by you).
Prompts for anything not passed as a flag. Values passed as flags can show up in shell history,
so prefer the prompts or --from-env for secrets.

Options:
  --profile <name>        Profile name (default "${DEFAULT_PROFILE}")
  --host <host>           Workday agent host (default ${DEFAULT_HOST})
  --tenant <alias>        Tenant alias
  --client-id <id>        API client id
  --client-secret <s>     API client secret
  --refresh-token <t>     Refresh token issued for the integration user
  --token-url <url>       Override the token endpoint (default https://{host}/auth/oauth2/{tenant}/token)
  --base-url <url>        Override the ASOR API base (default https://{host}/asor/v1)
  --from-env              Take values from the ASOR_* environment variables
  --default               Make this the default profile
  --no-verify             Save without testing the credentials
`;

const HELP_WRAP = `Usage: asor wrap [<agent>] [--out <dir>] [--name <command>] [--force]
       (alias: asor generate)

Generates a self-contained CLI package for one agent. Without <agent>, it lists the tenant's agents and lets you
pick one or more. The default output folder is ./asor-agents/<command>.
The package has no dependencies (only Node >= 22) and contains:
  bin/<command>.js   the CLI, pinned to this agent:  <command> ask "..."  |  <command> info
  tool.json          a function-calling tool definition for LLM-driven bots
  SKILL.md           instructions an agent like Claude Code can load as a skill
  README.md          install and usage notes
  agent-card.json    the definition snapshot it was generated from

The wrapped CLI reads the same ASOR_* variables and saved profiles as asor.
`;

const HELP_UI = `Usage: asor ui [--port <n>] [--out <dir>] [--no-open]

Opens a local web page to connect a tenant, browse its ASOR agents, try them, and generate a CLI for each one.
It listens only on 127.0.0.1, and every request needs the session token in the printed URL.

Options:
  --port <n>     Port to listen on (default: a random free port)
  --out <dir>    Parent folder for generated CLIs (default ./asor-agents)
  --no-open      Print the URL without opening a browser
  --profile <p>  Profile to start with
`;

const globalOptions = {
  profile: { type: 'string' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options: { ...globalOptions, ...options }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError('usage', (err as Error).message, { hint: 'Run with --help to see the options.' });
  }
}

function globals(values: { profile?: string | undefined; json?: boolean | undefined; verbose?: boolean | undefined }, extra: Partial<GlobalFlags> = {}): GlobalFlags {
  return {
    ...(values.profile ? { profile: values.profile } : {}),
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    ...extra,
  };
}

function printJson(value: unknown): void {
  stdout(JSON.stringify(value, null, 2));
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const wantsJson = argv.includes('--json');
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '-h':
      case '--help':
        stdout(HELP);
        return ExitCode.OK;
      case '--version':
      case 'version':
        stdout(VERSION);
        return ExitCode.OK;
      case 'login':
        return await cmdLogin(rest);
      case 'logout':
        return cmdLogout(rest);
      case 'profiles':
        return cmdProfiles(rest);
      case 'whoami':
      case 'doctor':
        return await cmdWhoami(rest);
      case 'agents':
        return await cmdAgents(rest);
      case 'invoke':
      case 'ask':
        return await cmdInvoke(rest);
      case 'wrap':
      case 'generate':
        return await cmdWrap(rest);
      case 'ui':
        return await cmdUi(rest);
      default:
        throw new CliError('usage', `Unknown command "${command}".`, { hint: 'Run `asor --help` to see the commands.' });
    }
  } catch (err) {
    return reportError(err, wantsJson);
  }
}

async function cmdLogin(args: string[]): Promise<number> {
  const { values } = parse(args, {
    host: { type: 'string' },
    tenant: { type: 'string' },
    'client-id': { type: 'string' },
    'client-secret': { type: 'string' },
    'refresh-token': { type: 'string' },
    'token-url': { type: 'string' },
    'base-url': { type: 'string' },
    'from-env': { type: 'boolean' },
    default: { type: 'boolean' },
    'no-verify': { type: 'boolean' },
  });
  if (values.help) return stdout(HELP_LOGIN), ExitCode.OK;

  const env = values['from-env'] ? process.env : {};
  const name = values.profile ?? DEFAULT_PROFILE;
  const existing = readConfigFile().profiles[name] ?? {};
  const profile: Profile = {
    host: values.host ?? env.ASOR_HOST ?? existing.host,
    tenant: values.tenant ?? env.ASOR_TENANT ?? existing.tenant,
    clientId: values['client-id'] ?? env.ASOR_CLIENT_ID ?? existing.clientId,
    clientSecret: values['client-secret'] ?? env.ASOR_CLIENT_SECRET ?? existing.clientSecret,
    refreshToken: values['refresh-token'] ?? env.ASOR_REFRESH_TOKEN ?? existing.refreshToken,
    tokenUrl: values['token-url'] ?? env.ASOR_TOKEN_URL ?? existing.tokenUrl,
    asorBaseUrl: values['base-url'] ?? env.ASOR_BASE_URL ?? existing.asorBaseUrl,
  };

  const interactive = Boolean(process.stdin.isTTY);
  if (interactive) {
    stderr(`Saving profile "${name}". Press Enter to keep the value in brackets.`);
    profile.host = (await ask('Workday agent host', { defaultValue: profile.host ?? DEFAULT_HOST })) || DEFAULT_HOST;
    profile.tenant = await ask('Tenant alias', profile.tenant ? { defaultValue: profile.tenant } : {});
    profile.clientId = await ask('API client id', profile.clientId ? { defaultValue: profile.clientId } : {});
    if (!profile.clientSecret || !values['client-secret']) {
      profile.clientSecret = (await ask(`API client secret${profile.clientSecret ? ' (Enter to keep saved)' : ''}`, { secret: true })) || profile.clientSecret;
    }
    if (!profile.refreshToken || !values['refresh-token']) {
      profile.refreshToken = (await ask(`Refresh token${profile.refreshToken ? ' (Enter to keep saved)' : ''}`, { secret: true })) || profile.refreshToken;
    }
  }
  profile.host ??= DEFAULT_HOST;

  const missing = (['tenant', 'clientId', 'clientSecret', 'refreshToken'] as const).filter((k) => !profile[k]);
  if (missing.length > 0) {
    const flag = { tenant: '--tenant', clientId: '--client-id', clientSecret: '--client-secret', refreshToken: '--refresh-token' };
    throw new CliError('usage', `Missing ${missing.map((k) => flag[k]).join(', ')}.`, { hint: 'Pass them as flags, use --from-env, or run `asor login` in an interactive terminal.' });
  }

  saveProfile(name, profile, { makeDefault: Boolean(values.default) });
  stderr(`Saved profile "${name}" to ${configPath()}.`);
  if (values['no-verify']) return ExitCode.OK;

  const verified = await verifySavedProfile(name);
  stderr(`Connected to tenant "${verified.tenant}". ${verified.agents} agent(s) visible.`);
  if (values.json) printJson({ ok: true, profile: name, tenant: verified.tenant, agents: verified.agents });
  return ExitCode.OK;
}

function cmdLogout(args: string[]): number {
  const { values } = parse(args, {});
  const name = values.profile ?? readConfigFile().defaultProfile ?? DEFAULT_PROFILE;
  try {
    const cfg = resolveConfig({ profile: name });
    new TokenProvider(cfg).invalidate();
  } catch {
    // The profile may be incomplete; removing it is still fine.
  }
  if (!removeProfile(name)) throw new CliError('not_found', `No saved profile named "${name}".`);
  stderr(`Removed profile "${name}".`);
  return ExitCode.OK;
}

function cmdProfiles(args: string[]): number {
  const { values } = parse(args, {});
  const file = readConfigFile();
  const rows = Object.entries(file.profiles).map(([name, p]) => ({
    name,
    default: name === file.defaultProfile,
    host: p.host ?? DEFAULT_HOST,
    tenant: p.tenant ?? null,
    clientId: p.clientId ?? null,
  }));
  if (values.json) return printJson(rows), ExitCode.OK;
  if (rows.length === 0) return stdout('No saved profiles. Run `asor login`.'), ExitCode.OK;
  stdout(renderTable(rows.map((r) => [`${r.default ? '* ' : '  '}${r.name}`, r.tenant ?? '-', r.host, r.clientId ?? '-']), ['  PROFILE', 'TENANT', 'HOST', 'CLIENT ID']));
  return ExitCode.OK;
}

async function cmdWhoami(args: string[]): Promise<number> {
  const { values } = parse(args, {});
  const ctx = createContext(globals(values));
  const { cfg } = ctx;
  const info = {
    profile: cfg.profileExists ? cfg.profileName : `${cfg.profileName} (not saved; environment only)`,
    tenant: cfg.tenant,
    host: cfg.host,
    tokenUrl: cfg.tokenUrl,
    asorBaseUrl: cfg.asorBaseUrl,
    clientId: mask(cfg.clientId),
    refreshToken: `${mask(cfg.refreshToken)} (from ${cfg.refreshTokenSource})`,
    agentAuth: cfg.agentAuth,
  };
  const checks: { token: string; asor: string } = { token: 'not checked', asor: 'not checked' };
  let failure: CliError | undefined;
  try {
    const t = await ctx.tokens.getToken();
    const mins = Number.isFinite(t.expiresAt) ? `, expires in ${Math.round((t.expiresAt - Date.now()) / 60000)} min` : '';
    checks.token = `ok (${t.source}${mins})`;
    const agents = await ctx.client.listAgents();
    checks.asor = `ok (${agents.length} agent(s) visible)`;
  } catch (err) {
    failure = toCliError(err);
    if (checks.token === 'not checked') checks.token = `FAILED: ${failure.message}`;
    else checks.asor = `FAILED: ${failure.message}`;
  }
  if (values.json) {
    printJson({ ok: !failure, ...info, checks, error: failure ? { kind: failure.kind, message: failure.message, hint: failure.hint ?? null } : null });
  } else {
    for (const [k, v] of Object.entries({ ...info, 'token check': checks.token, 'ASOR check': checks.asor })) stdout(`${`${k}:`.padEnd(14)}${v}`);
    if (failure?.hint) stderr(`  hint: ${failure.hint}`);
  }
  return failure ? failure.exitCode : ExitCode.OK;
}

async function cmdAgents(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
    case 'ls': {
      const { values } = parse(rest, { raw: { type: 'boolean' } });
      if (values.help) return stdout('Usage: asor agents list [--json] [--raw]\n  --raw   with --json, print the full definitions instead of summaries'), ExitCode.OK;
      const ctx = createContext(globals(values));
      const agents = await ctx.client.listAgents();
      if (values.json) printJson(values.raw ? agents : agents.map(summarize));
      else stdout(renderAgentList(agents.map(summarize)));
      return ExitCode.OK;
    }
    case 'get':
    case 'show': {
      const { values, positionals } = parse(rest, {});
      if (values.help || positionals.length === 0) return stdout('Usage: asor agents get <agent> [--json]'), positionals.length ? ExitCode.OK : ExitCode.USAGE;
      const ctx = createContext(globals(values));
      const card = await resolveAgent(ctx.client, positionals.join(' '));
      const support = a2aInvoker.supports(card);
      if (values.json) printJson(card);
      else stdout(renderAgentCard(card, support.ok ? { ok: true, detail: `A2A JSON-RPC at ${support.endpoint}` } : { ok: false, detail: support.reason }));
      return ExitCode.OK;
    }
    case 'register': {
      const { values } = parse(rest, { file: { type: 'string', short: 'f' } });
      if (values.help || !values.file) return stdout('Usage: asor agents register --file <agent-card.json> [--json]'), values.file ? ExitCode.OK : ExitCode.USAGE;
      let card: AgentCard;
      try {
        card = JSON.parse(readFileSync(values.file, 'utf8')) as AgentCard;
      } catch (err) {
        throw new CliError('usage', `Could not read ${values.file}: ${(err as Error).message}`);
      }
      const ctx = createContext(globals(values));
      const saved = await ctx.client.registerAgent(card);
      if (values.json) printJson(saved);
      else stdout(`Registered "${saved.name ?? card.name}"${saved.id ? ` with id ${saved.id}` : ''}.`);
      return ExitCode.OK;
    }
    default:
      throw new CliError('usage', sub ? `Unknown subcommand "agents ${sub}".` : 'Missing subcommand.', { hint: 'Use `asor agents list`, `asor agents get <agent>`, or `asor agents register --file <card.json>`.' });
  }
}

async function cmdInvoke(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    skill: { type: 'string' },
    'context-id': { type: 'string' },
    'task-id': { type: 'string' },
    stream: { type: 'boolean' },
    timeout: { type: 'string' },
    'agent-auth': { type: 'string' },
  });
  if (values.help) return stdout(HELP_INVOKE), ExitCode.OK;
  const [ref, ...words] = positionals;
  if (!ref) throw new CliError('usage', 'Missing <agent>.', { hint: 'Usage: asor invoke <agent> [message]. See `asor agents list`.' });
  const ctx = createContext(globals(values, values['agent-auth'] ? { agentAuth: values['agent-auth'] } : {}));
  const profileFlag = values.profile ? ` --profile ${values.profile}` : '';
  return runInvoke(
    ctx,
    () => resolveAgent(ctx.client, ref),
    words,
    {
      json: Boolean(values.json),
      stream: Boolean(values.stream),
      ...(values.skill ? { skill: values.skill } : {}),
      ...(values['context-id'] ? { contextId: values['context-id'] } : {}),
      ...(values['task-id'] ? { taskId: values['task-id'] } : {}),
      ...(values.timeout ? { timeout: values.timeout } : {}),
    },
    `asor invoke ${JSON.stringify(ref)}${profileFlag}`,
  );
}

async function cmdWrap(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { out: { type: 'string', short: 'o' }, name: { type: 'string' }, force: { type: 'boolean' } });
  if (values.help) return stdout(HELP_WRAP), ExitCode.OK;
  const ctx = createContext(globals(values));

  let cards: AgentCard[];
  const ref = positionals.join(' ');
  if (ref) cards = [await resolveAgent(ctx.client, ref)];
  else if (process.stdin.isTTY && !values.json) cards = await pickAgents(ctx);
  else throw new CliError('usage', 'Missing <agent>.', { hint: 'Usage: asor wrap <agent> [--out <dir>]. Run it in a terminal without <agent> to pick from a list, or use `asor ui`.' });
  if (cards.length > 1 && (values.out || values.name)) {
    throw new CliError('usage', '--out and --name apply to a single agent.', { hint: 'Leave them off to generate each CLI under ./asor-agents/<command>.' });
  }

  const results = [];
  for (const card of cards) {
    const support = a2aInvoker.supports(card);
    if (!support.ok) stderr(`asor: warning: "${card.name}" is not invocable yet (${support.reason}). Generating its CLI anyway.`);
    const command = commandName(card, values.name);
    const outDir = values.out ?? join('asor-agents', command);
    const result = generateWrapper(card, { outDir, command, force: Boolean(values.force), ...(values.profile ? { profile: values.profile } : {}) });
    results.push(result);
    if (!values.json) {
      stdout(`\n✓ ${card.name}  →  ${result.command}   (${result.outDir})`);
      const shown = surfaceSnippets(result, { tenant: ctx.cfg.tenant, ...(values.profile ? { profile: values.profile } : {}) }).filter((x) => ['Install', 'Terminal / scripts', 'Claude Code'].includes(x.surface));
      for (const snip of shown) {
        stdout(`  ${snip.surface}:`);
        stdout(snip.code.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
  }
  if (values.json) printJson(results.length === 1 ? results[0] : results);
  else stdout('\nMore recipes (Slack, Teams, LLM tools) are in README.md in each folder, or run `asor ui`.');
  return ExitCode.OK;
}

/** Numbered terminal picker for `asor wrap` with no agent. Accepts "2", "1,3", "1-3", or "all". */
async function pickAgents(ctx: ReturnType<typeof createContext>): Promise<AgentCard[]> {
  const agents = await ctx.client.listAgents();
  if (agents.length === 0) throw new CliError('not_found', 'No agents are registered in this tenant (or this user cannot see any).');
  stderr(`Agents in ${ctx.cfg.tenant}:`);
  agents.forEach((a, i) => {
    const s = summarize(a);
    stderr(`  ${String(i + 1).padStart(2)}. ${s.name}${s.invocable ? '' : '  (no endpoint)'}${s.skills.length ? `  — ${s.skills.join(', ')}` : ''}`);
  });
  const answer = (await ask('Generate CLIs for which agents? (e.g. 2, 1,3, 1-3, all)')).toLowerCase();
  const picked = new Set<number>();
  for (const part of answer.split(/[\s,]+/).filter(Boolean)) {
    if (part === 'all') agents.forEach((_, i) => picked.add(i));
    else if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split('-').map(Number) as [number, number];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picked.add(i - 1);
    } else if (/^\d+$/.test(part)) picked.add(Number(part) - 1);
    else throw new CliError('usage', `Did not understand "${part}".`);
  }
  const chosen = [...picked].sort((x, y) => x - y).map((i) => agents[i]);
  if (chosen.length === 0 || chosen.some((c) => !c)) throw new CliError('usage', 'Pick numbers from the list.');
  // List entries can be partial; fetch each full definition.
  return Promise.all(chosen.map((c) => (c!.id ? ctx.client.getAgent(c!.id).catch(() => c!) : c!)));
}

async function cmdUi(args: string[]): Promise<number> {
  const { values } = parse(args, { port: { type: 'string' }, out: { type: 'string', short: 'o' }, 'no-open': { type: 'boolean' } });
  if (values.help) return stdout(HELP_UI), ExitCode.OK;
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('usage', `Invalid --port "${values.port}".`);
  const { startUi } = await import('./ui/server.js');
  const ui = await startUi({
    port,
    open: !values['no-open'],
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.out ? { outRoot: values.out } : {}),
    log: (m) => stderr(`asor ui: ${m}`),
  });
  stdout(`asor ui is running at:\n\n  ${ui.url}\n\nThe link contains a session token, so don't share it. Press Ctrl+C to stop.`);
  await new Promise<void>((done) => {
    const stop = () => {
      void ui.close().then(done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return ExitCode.OK;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.exitCode = reportError(err, false);
    },
  );
}
