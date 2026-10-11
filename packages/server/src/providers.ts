// What a provider (an engine family) tells Reins about itself. Each provider lives in its own folder.
export interface Provider {
  id: string;
  label: string;
  models: Array<{ id: string; label: string }>;
  /** Models whose stream reports no context window. */
  windows: Record<string, number>;
  /** USD per million tokens. List prices, can go stale. */
  prices: Record<string, { input: number; cacheWrite?: number }>;
  costAcrossResume: 'cumulative' | 'per-process';
}
