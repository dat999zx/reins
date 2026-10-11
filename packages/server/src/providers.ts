import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Every folder under `root` holding provider.ts (tests, from source) or provider.js (the build) is a provider.
 * ponytail: providers are read once, when the server starts.
 */
export async function loadProviders(root = fileURLToPath(new URL('.', import.meta.url))): Promise<Provider[]> {
  const found: Provider[] = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = ['provider.ts', 'provider.js'].map((f) => path.join(root, d.name, f)).find((f) => fs.existsSync(f));
    if (!file) continue;
    const m = (await import(pathToFileURL(file).href)) as { provider?: Provider };
    if (typeof m.provider?.id !== 'string') throw new Error(`${file} must export a provider with an id.`);
    found.push(m.provider);
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
