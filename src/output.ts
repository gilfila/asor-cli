import type { InvokeResult } from './invoke.js';
import type { CliError } from './errors.js';
import type { AgentCard, AgentSummary } from './types.js';
import { modeText, refText, tagText } from './types.js';

/**
 * The single JSON object `invoke --json` prints. Bots parse this, so keep the fields stable.
 * (With --stream --json the CLI prints JSON Lines, and this envelope is the last line, tagged `"type": "result"`.)
 */
export interface Envelope {
  ok: boolean;
  agent: { id: string | null; name: string | null } | null;
  contextId: string | null;
  taskId: string | null;
  state: string | null;
  text: string;
  artifacts: unknown[];
  error: { kind: string; message: string; hint: string | null; exitCode: number } | null;
}

export function successEnvelope(agent: AgentCard, result: InvokeResult, ok: boolean): Envelope {
  return {
    ok,
    agent: { id: agent.id ?? null, name: agent.name ?? null },
    contextId: result.contextId,
    taskId: result.taskId,
    state: result.state,
    text: result.text,
    artifacts: result.artifacts,
    error: null,
  };
}

export function errorEnvelope(err: CliError, agent?: AgentCard | null): Envelope {
  return {
    ok: false,
    agent: agent ? { id: agent.id ?? null, name: agent.name ?? null } : null,
    contextId: null,
    taskId: null,
    state: null,
    text: '',
    artifacts: [],
    error: { kind: err.kind, message: err.message, hint: err.hint ?? null, exitCode: err.exitCode },
  };
}

export function renderTable(rows: string[][], headers: string[]): string {
  const maxWidth = Math.max(60, process.stdout.columns ?? 120);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  // Shrink the widest column until the table fits the terminal.
  const gap = 2;
  while (widths.reduce((a, b) => a + b + gap, 0) > maxWidth) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 12) break;
    widths[widest]! -= 1;
  }
  const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => fit(c, widths[i]!))
      .join(' '.repeat(gap))
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function renderAgentList(agents: AgentSummary[]): string {
  if (agents.length === 0) return 'No agents are registered in this tenant (or this user cannot see any).';
  const rows = agents.map((a) => [a.name, a.id ?? '-', a.provider ?? '-', a.invocable ? 'yes' : 'no', a.skills.join(', ') || '-']);
  return renderTable(rows, ['NAME', 'ID', 'PROVIDER', 'INVOCABLE', 'SKILLS']);
}

export function renderAgentCard(card: AgentCard, invocable: { ok: boolean; detail: string }): string {
  const out: string[] = [];
  out.push(`${card.name ?? '(unnamed)'}${card.version ? `  v${card.version}` : ''}`);
  if (card.description) out.push('', wrap(card.description, 88));
  out.push('');
  const field = (k: string, v: string | null | undefined) => {
    if (v) out.push(`${`${k}:`.padEnd(14)}${v}`);
  };
  field('ID', card.id);
  field('Provider', refText(card.provider));
  field('Platform', refText(card.platform));
  field('URL', card.url);
  field('Invocable', invocable.ok ? `yes (${invocable.detail})` : `no — ${invocable.detail}`);
  field('Streaming', card.capabilities?.streaming === undefined ? undefined : String(card.capabilities.streaming));
  field('Input', (card.defaultInputModes ?? []).map(modeText).join(', '));
  field('Output', (card.defaultOutputModes ?? []).map(modeText).join(', '));
  field('Docs', card.documentationUrl);
  const skills = card.skills ?? [];
  if (skills.length > 0) {
    out.push('', 'Skills:');
    for (const s of skills) {
      out.push(`  • ${s.name ?? s.id}${s.id && s.name ? `  [${s.id}]` : ''}`);
      if (s.description) out.push(wrap(s.description, 84, '    '));
      const tags = (s.tags ?? []).map(tagText).filter(Boolean);
      if (tags.length) out.push(`    tags: ${tags.join(', ')}`);
      for (const ex of s.examples ?? []) out.push(`    e.g. "${ex}"`);
    }
  }
  return out.join('\n');
}

export function wrap(text: string, width: number, indent = ''): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(indent + line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

const SENSITIVE_KEY = /(^id$|id$|^url$|url$|uri$|email|tenant|secret|token|^name$)/i;

/**
 * Replaces identifying strings (ids, URLs, tenant fields, names) with stable placeholders and keeps the JSON's shape,
 * so a live ASOR response can be shared in an issue or saved as a test fixture.
 * The same input string always maps to the same placeholder, so references between fields survive.
 */
export function redact(value: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string' && (SENSITIVE_KEY.test(key) || /^https?:\/\//i.test(v))) {
      // Keep Workday reference-ID prefixes like "Provider=SELF-BUILT"; they are the schema, not identifying data.
      if (/^[A-Za-z_]+=[A-Z0-9_-]+$/.test(v)) return v;
      if (!seen.has(v)) seen.set(v, `<${key || 'value'}-${seen.size + 1}>`);
      return seen.get(v);
    }
    return v;
  };
  return walk(value, '');
}
