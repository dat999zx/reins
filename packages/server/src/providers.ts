import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CatalogModel } from './catalog.js';

// What a provider (an engine family) tells Reins about itself. Each provider lives in its own folder.
export interface Provider {
  id: string;
  label: string;
  /** The CURATED models, in picker order: ids already run on the real CLI. The catalog adds extras after them. */
  models: Array<{ id: string; label: string }>;
  /** What a new session uses, like Hermes `model.default`; one of `models`. */
  defaultModel: string;
  /** The catalog's key for this provider (models.dev), if it has one. */
  catalog?: string;
  /** Models whose stream reports no context window. */
  windows: Record<string, number>;
  /** USD per million tokens, as the provider's own CLI bills them (a measured table, not published list prices). Can go stale. */
  prices: Record<string, { input: number; cacheWrite?: number }>;
  /** What the provider bills a cache write at, as a multiple of the catalog's input price. A provider with none has no catalog price path. */
  cacheWritePerInput?: number;
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

export interface PickerModel { id: string; label: string; window?: number }

/**
 * The picker's list, after Hermes's `_anthropic_catalog`: the provider's models first, in file order (its label wins),
 * then catalog extras: tool-call models, no dated ids (`-YYYYMMDD`), newest first, the whole list at most `limit` long
 * (the provider's own models are never cut). `window` is the catalog's context size.
 * ponytail: the picker can list an id the CLI rejects; a switch whose first reply fails is undone (session.ts).
 */
export function listModels(provider: Pick<Provider, 'models'>, catalog: CatalogModel[], limit: number): PickerModel[] {
  const known = new Map(catalog.map((m) => [m.id, m]));
  const withWindow = (id: string, label: string): PickerModel => {
    const window = known.get(id)?.context;
    return window === undefined ? { id, label } : { id, label, window };
  };
  const have = new Set(provider.models.map((m) => m.id));
  const extras = catalog
    .filter((m) => m.toolCall === true && !/-\d{8}$/.test(m.id) && !have.has(m.id))
    .sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''))
    .slice(0, Math.max(0, limit - provider.models.length));
  return [...provider.models.map((m) => withWindow(m.id, m.label)), ...extras.map((m) => withWindow(m.id, m.label))];
}