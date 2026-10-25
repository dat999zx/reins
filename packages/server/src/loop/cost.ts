// Spec 6.1 and 6.2: what one model call cost, in USD. Unknown is not zero.
import type { ProviderManifest } from '../mods/types.js';
import type { Usage } from './types.js';

export interface Price { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/**
 * The model's own price in the manifest, else the provider's default price; undefined = unknown. This is the one price source of the loop's billing,
 * and of the header's switch estimate for an API provider (`priceFor` reads the same manifest fields).
 */
export function priceOf(p: ProviderManifest, modelId: string): Price | undefined {
  const m = p.models.find((x) => x.id === modelId)?.price;
  // A model price without `output` is a table of a provider that reports its own cost: not a price for this loop.
  const found: Price | undefined = m && m.output !== undefined ? { ...m, output: m.output } : p.price;
  // A price with a field that is not a number of 0 or more (NaN would slip past every comparison of the money guard) is no price.
  return found && [found.input, found.output, found.cacheRead ?? 0, found.cacheWrite ?? 0].every((x) => Number.isFinite(x) && x >= 0) ? found : undefined;
}

/**
 * A USD limit counts as reached when less than this is left (spec 6.3). Per-call costs are summed unrounded, so 0.1 + 0.2 is 0.30000000000000004:
 * without it a cap of exactly that sum would leave a hair of room and let one more call out. The Run's own check (`usdOver`) uses the same 1e-9,
 * so the loop and the Run agree on when the limit is reached.
 */
export const USD_EPSILON = 1e-9;

/** USD per million tokens, not rounded. A cache price that is not given is the input price. */
export const callCost = (price: Price, u: Usage): number =>
  (u.input * price.input + u.output * price.output + u.cacheRead * (price.cacheRead ?? price.input) + u.cacheWrite * (price.cacheWrite ?? price.input)) / 1e6;
