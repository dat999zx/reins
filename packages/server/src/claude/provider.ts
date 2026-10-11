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
  // ponytail: not published list prices. cacheWrite is measured on the real CLI as modelUsage costUSD / cache-creation tokens; input is assumed as cacheWrite / 1.25. Opus and Haiku are single noisy samples (+-20%); numbers go stale, the estimate is always labelled one.
  prices: {
    'claude-fable-5-1': { input: 16, cacheWrite: 20 },
    'claude-sonnet-5-5': { input: 3.2, cacheWrite: 4 },
    'claude-haiku-5-5': { input: 0.16, cacheWrite: 0.2 },
    'claude-opus-5-5': { input: 6.16, cacheWrite: 7.7 },
  },
  // F7: total_cost_usd is cumulative across --resume processes in stream-json input mode.
  costAcrossResume: 'cumulative',
} satisfies Provider;
