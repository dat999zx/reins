// Spec 6.1 and 6.2: what one model call cost, in USD. Unknown is not zero.
import type { EngineHost, ProviderManifest } from '../mods/types.js';
import type { Usage } from './types.js';

export interface Price { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** The model's own price, else the catalog's, else the provider's default; undefined = unknown. */
export function priceOf(p: ProviderManifest, h: Pick<EngineHost, 'catalogPrice'>, modelId: string): Price | undefined {
  const m = p.models.find((x) => x.id === modelId)?.price;
  // A model price without `output` is a table of a provider that reports its own cost: not a price for this loop.
  if (m && m.output !== undefined) return { ...m, output: m.output };
  return h.catalogPrice?.(modelId) ?? p.price;
}

/** USD per million tokens, not rounded. A cache price that is not given is the input price. */
export const callCost = (price: Price, u: Usage): number =>
  (u.input * price.input + u.output * price.output + u.cacheRead * (price.cacheRead ?? price.input) + u.cacheWrite * (price.cacheWrite ?? price.input)) / 1e6;
