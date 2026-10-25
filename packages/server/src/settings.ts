import type { CatalogModel } from './catalog.js';
import type { Provider } from './providers.js';
import type { LogRow, Store } from './store.js';

// ponytail: the estimate uses the provider file's measured price table, else catalog prices; both can go stale; a model with no price is refused.
export const SETTINGS = {
  switchApprovalTokens: { default: 200_000, valid: (v: unknown) => Number.isInteger(v) && (v as number) > 0 },
  switchApprovalUsd: { default: 0.5, valid: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 },
  pickerLimit: { default: 8, valid: (v: unknown) => Number.isInteger(v) && (v as number) > 0 },
  // The fraction of the window at which a reply is preceded by a compression. 1 is off: at 100 % the window is already full.
  autoCompressAt: { default: 0.9, valid: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 },
  // A subagent's tool request: a card on the parent run (ask), or refused with a note and a hook row (deny, Hermes's default).
  subagentApprovals: { default: 'ask' as 'ask' | 'deny', valid: (v: unknown) => v === 'ask' || v === 'deny' },
};

export function readSetting<K extends keyof typeof SETTINGS>(store: Store, key: K): (typeof SETTINGS)[K]['default'] {
  const v = store.getSetting(key);
  return SETTINGS[key].valid(v) ? (v as (typeof SETTINGS)[K]['default']) : SETTINGS[key].default;
}

const type = (r: LogRow) => (r.data as { type?: string } | null)?.type;

/** The newest usage's tokens, unknown once any later engine row (other than usage) or a failed turn exists. A subagent's rows (they carry a `step`) are not the parent's. */
export function contextSize(rows: LogRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'turn_failed') return undefined;
    if (r.type !== 'engine' || typeof (r.data as { step?: unknown } | null)?.step === 'string') continue;
    if (type(r) !== 'usage') return undefined;
    const used = (r.data as { used?: unknown }).used;
    return typeof used === 'number' ? used : undefined;
  }
  return undefined;
}

/** The window of the newest usage row, whatever came after it; unknown once the model was changed after it. */
export function contextWindow(rows: LogRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'settings' && r.data && 'model' in (r.data as object)) return undefined;
    if (r.type !== 'engine' || type(r) !== 'usage') continue;
    const w = (r.data as { window?: unknown }).window;
    return typeof w === 'number' ? w : undefined;
  }
  return undefined;
}

/** A compaction happened and every usage row after the newest one is at or over `limit` (and one exists): compressing again would not help. */
export function stillOverAfterCompaction(rows: LogRow[], limit: number): boolean {
  let seen = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type !== 'engine') continue;
    if (type(r) === 'compacted') return seen;
    if (type(r) !== 'usage') continue;
    const used = (r.data as { used?: unknown }).used;
    if (typeof used !== 'number' || used < limit) return false;
    seen = true;
  }
  return false;
}

/** Run ids whose last row is run_detached (a server restart leaves a run waiting at a gate that way). */
export function detachedRuns(rows: LogRow[]): string[] {
  const last = new Map<string, string>();
  for (const r of rows) if (r.runId) last.set(r.runId, r.type);
  return [...last].filter(([, t]) => t === 'run_detached').map(([id]) => id);
}

/** The new model writes the whole context to its cache (F7), so the cache-write price comes first. */
export function switchEstimate(tokens: number | undefined, price?: { input: number; cacheWrite?: number }): number | undefined {
  if (tokens === undefined || !price) return undefined;
  return (tokens * (price.cacheWrite ?? price.input)) / 1e6;
}

export interface Price { input: number; cacheWrite: number; source: 'table' | 'catalog' }

/**
 * The price of the first reply on `model`: the provider's table, else the catalog's input price (a context tier at or under
 * `tokens` replaces it) times the provider's cacheWritePerInput. Hermes also keeps a labelled docs snapshot first.
 * ponytail: tiers are chosen by the tokens of the switch, not of a later turn, and only on the catalog path: the provider's own table is flat
 * (Haiku's catalog tier above 100k tokens, 5x the input price, is not in it; the estimate stays far under the USD limit).
 */
export function priceFor(provider: Pick<Provider, 'prices' | 'cacheWritePerInput'>, catalog: CatalogModel[], model: string, tokens: number): Price | undefined {
  const t = provider.prices[model];
  if (t) return { input: t.input, cacheWrite: t.cacheWrite ?? t.input, source: 'table' };
  const price = catalog.find((m) => m.id === model)?.price;
  if (!price || provider.cacheWritePerInput === undefined) return undefined;
  const tier = (price.tiers ?? []).filter((x) => x.size <= tokens).sort((a, b) => b.size - a.size)[0];
  const input = tier ? tier.input : price.input;
  if (input === undefined) return undefined;
  return { input, cacheWrite: input * provider.cacheWritePerInput, source: 'catalog' };
}

export type SwitchCheck = { refuse: string } | { ask: { prompt: string; detail: string } } | undefined;

// ponytail: the card carries words only; a workflow's model block (C) adds the data it needs.
export function switchCheck(o: {
  busy: boolean; detached: boolean; hasSession: boolean; used?: number | undefined; target: string; label?: string;
  estimate?: number | undefined; source?: Price['source']; limits: { tokens: number; usd: number };
}): SwitchCheck {
  if (o.busy) return { refuse: 'Switch the model when the session is idle.' };
  if (o.detached) return { refuse: 'A run is left paused in this session. Resume or stop it before switching the model.' };
  if (!o.hasSession) return undefined; // nothing to feed the new model yet
  const name = o.label ?? o.target;
  const n = (x: number) => x.toLocaleString('en-US');
  const basis = o.source === 'catalog' ? 'catalog prices, 1-hour cache write' : "the provider's price table";
  let reason: string | undefined;
  if (o.used === undefined) reason = '';
  else if (o.used >= o.limits.tokens) reason = `Asked because the context is at or over the ${n(o.limits.tokens)}-token switch limit.`;
  else if (o.estimate === undefined) reason = '';
  else if (o.estimate >= o.limits.usd) reason = `Asked because the estimate is at or over the $${o.limits.usd.toFixed(2)} switch limit.`;
  if (reason === undefined) return undefined;
  const line = o.used === undefined
    ? `The whole conversation goes to ${name} as input. Reins does not know its size, so the cost cannot be estimated.`
    : `The whole conversation, ${n(o.used)} tokens, goes to ${name} as input. ${o.estimate === undefined
      ? `No price is known for ${name}, so the cost cannot be estimated.`
      : `Estimate: about $${o.estimate.toFixed(2)} (an estimate from ${basis}).`}`;
  return { ask: { prompt: `Switch to ${name}?`, detail: reason ? `${line}\n${reason}` : line } };
}