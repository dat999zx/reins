import type { Provider } from '../providers.js';

export const provider = {
  id: 'claude',
  label: 'Claude',
  // Each id was run once on the real CLI (agent-control-facts-2.md).
  models: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ],
  // Every Claude model reports modelUsage.contextWindow.
  windows: {},
  // The catalog's key (models.dev) for the picker's extras, windows and the fallback price.
  catalog: 'anthropic',
  // ponytail: not published list prices. cacheWrite is measured on the real CLI as modelUsage costUSD / cache-creation tokens;
  // the CLI bills the 1-hour cache write (2 x input), so input = cacheWrite / 2 (matches models.dev, facts-3). Opus is one noisy sample (+-20%);
  // numbers go stale, the estimate is always labelled one.
  prices: {
    'claude-fable-5-1': { input: 10, cacheWrite: 20 },
    'claude-sonnet-5-5': { input: 2, cacheWrite: 4 },
    'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.2 },
    'claude-opus-5-5': { input: 4, cacheWrite: 8 },
  },
  // The CLI writes the 1-hour cache: 2 x the catalog's input price (facts-3: haiku matches to the cent).
  cacheWritePerInput: 2,
  // F7: total_cost_usd is cumulative across --resume processes in stream-json input mode.
  costAcrossResume: 'cumulative',
} satisfies Provider;
