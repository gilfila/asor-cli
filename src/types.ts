/**
 * Shapes returned by the Workday ASOR API (v1.2). ASOR agent definitions are A2A Agent Cards plus Workday fields.
 * Workday uses reference objects ({ id, descriptor }) in places where A2A uses plain strings, so most fields are loose.
 */

export type Ref = string | { id?: string; descriptor?: string; organization?: string; name?: string; url?: string };

export interface AgentSkill {
  id?: string;
  name?: string;
  description?: string;
  tags?: Array<string | { tag?: string }>;
  examples?: string[];
  inputModes?: Array<string | { type?: string }>;
  outputModes?: Array<string | { type?: string }>;
}

export interface AgentInterface {
  url?: string;
  transport?: string;
}

export interface AgentCard {
  id?: string;
  name?: string;
  description?: string;
  /** Where the agent is hosted: its A2A endpoint. */
  url?: string;
  preferredTransport?: string;
  additionalInterfaces?: AgentInterface[];
  version?: string;
  provider?: Ref;
  platform?: Ref;
  overview?: string;
  documentationUrl?: string;
  iconUrl?: string;
  externalAgentID?: string;
  externalTenantID?: string;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean; [k: string]: unknown };
  defaultInputModes?: Array<string | { type?: string }>;
  defaultOutputModes?: Array<string | { type?: string }>;
  skills?: AgentSkill[];
  supportsAuthenticatedExtendedCard?: boolean;
  workdayConfig?: unknown;
  [key: string]: unknown;
}

/** The compact view printed by `asor agents list`. */
export interface AgentSummary {
  id: string | null;
  name: string;
  description: string;
  version: string | null;
  provider: string | null;
  platform: string | null;
  skills: string[];
  url: string | null;
  invocable: boolean;
}

export function refText(ref: Ref | undefined): string | null {
  if (ref === undefined || ref === null) return null;
  if (typeof ref === 'string') return ref;
  return ref.descriptor ?? ref.organization ?? ref.name ?? ref.id ?? null;
}

export function modeText(mode: string | { type?: string }): string {
  return typeof mode === 'string' ? mode : (mode.type ?? '');
}

export function tagText(tag: string | { tag?: string }): string {
  return typeof tag === 'string' ? tag : (tag.tag ?? '');
}

/** The JSON-RPC endpoint for an agent, or null when it has none we can call. */
export function a2aEndpoint(card: AgentCard): string | null {
  const isHttp = (u: string | undefined): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);
  const preferred = card.preferredTransport?.toUpperCase();
  if (!preferred || preferred === 'JSONRPC') {
    if (isHttp(card.url)) return card.url;
  }
  const alt = card.additionalInterfaces?.find((i) => i.transport?.toUpperCase() === 'JSONRPC' && isHttp(i.url));
  return alt?.url ?? null;
}

export function summarize(card: AgentCard): AgentSummary {
  const url = a2aEndpoint(card);
  return {
    id: card.id ?? null,
    name: card.name ?? '(unnamed)',
    description: card.description ?? '',
    version: card.version ?? null,
    provider: refText(card.provider),
    platform: refText(card.platform),
    skills: (card.skills ?? []).map((s) => s.name ?? s.id ?? '').filter(Boolean),
    url: url ?? card.url ?? null,
    invocable: url !== null,
  };
}
