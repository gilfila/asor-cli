import type { AsorClient } from './asor.js';
import { CliError } from './errors.js';
import type { AgentCard } from './types.js';

/** Workday instance ids (WIDs) are 32 hex characters. */
const WID = /^[0-9a-f]{32}$/i;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Finds an agent by id, exact name, slug ("benefits-helper"), or a unique substring of its name.
 * Returns the full definition from `GET /agentDefinition/{id}` when the agent has an id.
 */
export async function resolveAgent(client: AsorClient, ref: string): Promise<AgentCard> {
  const wanted = ref.trim();
  if (!wanted) throw new CliError('usage', 'An agent id or name is required.');

  if (WID.test(wanted)) {
    try {
      return await client.getAgent(wanted);
    } catch (err) {
      if (!(err instanceof CliError && err.kind === 'not_found')) throw err;
      // Fall through: an agent could have a 32-character hex name.
    }
  }

  const agents = await client.listAgents();
  const match = pickAgent(agents, wanted);
  if (match.id) {
    try {
      return await client.getAgent(match.id);
    } catch (err) {
      // The list entry is still useful if the single-item endpoint is not available.
      if (err instanceof CliError && (err.kind === 'not_found' || err.kind === 'forbidden')) return match;
      throw err;
    }
  }
  return match;
}

/** Pure matching logic, separated so it can be unit-tested without a server. */
export function pickAgent(agents: AgentCard[], ref: string): AgentCard {
  const lower = ref.toLowerCase();
  const slug = slugify(ref);
  const tiers: Array<(a: AgentCard) => boolean> = [
    (a) => a.id === ref,
    (a) => (a.name ?? '').toLowerCase() === lower,
    (a) => slug !== '' && slugify(a.name ?? '') === slug,
    (a) => (a.name ?? '').toLowerCase().includes(lower),
    // "echo-test" should find "asor-cli Echo Test".
    (a) => slug !== '' && slugify(a.name ?? '').includes(slug),
  ];
  for (const test of tiers) {
    const hits = agents.filter(test);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      const names = hits.map((a) => `  ${a.name ?? '(unnamed)'}${a.id ? `  (${a.id})` : ''}${a.version ? `  v${a.version}` : ''}`).join('\n');
      throw new CliError('usage', `"${ref}" matches ${hits.length} agents:\n${names}`, { hint: 'Pass the agent id to pick one.' });
    }
  }
  throw new CliError('not_found', `No agent matches "${ref}".`, { hint: 'Run `asor agents list` to see the agents registered in this tenant.' });
}
