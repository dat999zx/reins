import type { CatalogModel } from './catalog.js';
import type { Provider } from './providers.js';
import type { LogRow, Store } from './store.js';

// ponytail: the estimate uses the provider file's measured price table, else catalog prices; both can go stale; a model with no price is refused.
export const SETTINGS = {
  switchApprovalTokens: { default: 200_000, valid: (v: unknown) => Number.isInteger(v) && (v as number) > 0 },
  switchApprovalUsd: { default: 0.5, valid: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 },
  pickerLimit: { default: 8, valid: (v: unknown) => Number.isInteger(v) && (v as number) > 0 },
};

export function readSetting(store: Store, key: keyof typeof SETTINGS): number {
  const v = store.getSetting(key);
  return SETTINGS[key].valid(v) ? (v as number) : SETTINGS[key].default;
}

const type = (r: LogRow) => (r.data as { type?: string } | null)?.type;

/** The newest usage's tokens, unknown once any later engine row (other than usage) or a failed turn exists. */
export function contextSize(rows: LogRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.type === 'turn_failed') return undefined;
    if (r.type !== 'engine') continue;
    if (type(r) !== 'usage') return undefined;
    const used = (r.data as { used?: unknown }).used;
    return typeof used === 'number' ? used : undefined;
  }
  return undefined;
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
 * ponytail: tiers are chosen by the tokens of the switch, not of a later turn.
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

const APPROVAL = 'Switching needs your approval, which Reins cannot ask for yet.';

export function switchRefusal(o: {
  busy: boolean; detached: boolean; hasSession: boolean; used?: number | undefined; target: string; label?: string;
  estimate?: number | undefined; source?: Price['source']; limits: { tokens: number; usd: number };
}): string | undefined {
  if (o.busy) return 'Switch the model when the session is idle.';
  if (o.detached) return 'A run is left paused in this session. Resume or stop it before switching the model.';
  if (!o.hasSession) return undefined; // nothing to feed the new model yet
  const name = o.label ?? o.target;
  const basis = o.source === 'catalog' ? 'catalog prices, 1-hour cache write' : "the provider's price table";
  if (o.used === undefined) return 'Reins does not know the current context size. Send one message, then switch.';
  if (o.used >= o.limits.tokens) {
    return `The context is ${o.used.toLocaleString('en-US')} tokens, at or over the ${o.limits.tokens.toLocaleString('en-US')}-token switch limit. ${APPROVAL}`;
  }
  if (o.estimate === undefined) return `No price is known for ${name}, so the switch cannot be estimated. ${APPROVAL}`;
  if (o.estimate >= o.limits.usd) {
    return `Switching sends ${o.used.toLocaleString('en-US')} tokens to ${name}: about $${o.estimate.toFixed(2)} (an estimate from ${basis}), at or over the $${o.limits.usd.toFixed(2)} switch limit. ${APPROVAL}`;
  }
  return undefined;
}
