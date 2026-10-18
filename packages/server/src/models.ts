import type { CatalogModel } from './catalog.js';

export interface PickerModel { id: string; label: string; window?: number }

/**
 * The picker's list, after Hermes's `_anthropic_catalog`: the provider's models first, in file order (its label wins),
 * then catalog extras: tool-call models, no dated ids (`-YYYYMMDD`), newest first, the whole list at most `limit` long
 * (the provider's own models are never cut). `window` is the catalog's context size.
 * ponytail: the picker can list an id the CLI rejects; a switch whose first reply fails is undone (session.ts).
 */
export function listModels(provider: { models: Array<{ id: string; label?: string }> }, catalog: CatalogModel[], limit: number): PickerModel[] {
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
  return [...provider.models.map((m) => withWindow(m.id, m.label ?? m.id)), ...extras.map((m) => withWindow(m.id, m.label))];
}
