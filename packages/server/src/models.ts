import type { CatalogModel } from './catalog.js';

export interface PickerModel { id: string; label: string; window?: number }

export type ParsedModel = { provider: string; model: string };

// What a provider id looks like (the loader's rule), in either case: a word before a colon that has this shape was meant as a provider.
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

/**
 * A model name in a file, a switch or `reins run --model` (spec 9.2): split at the FIRST `:`. The part before it counts only when it is an
 * installed provider; with none the name is a model on `sessionProvider`. A word before the colon that looks like a provider id but is not
 * installed is refused (`qwen3:30b` must be written <provider>:qwen3:30b); anything else (`hf.co/a:Q4`) is a plain model name.
 * `step` is the step the name came from, for the words; their example names the session's provider.
 */
export function parseModel(name: string, sessionProvider: string, installed: (id: string) => boolean, step?: string): ParsedModel | { error: string } {
  const text = name.trim();
  const where = step === undefined ? '' : ` in step \`${step}\``;
  const cut = text.indexOf(':');
  if (cut < 0) return text ? { provider: sessionProvider, model: text } : { error: `Unknown model${where}: no model is named.` };
  const prefix = text.slice(0, cut);
  if (installed(prefix)) {
    const model = text.slice(cut + 1).trim();
    return model ? { provider: prefix, model } : { error: `Unknown model ${text}${where}: no model is named after \`${prefix}:\`.` };
  }
  if (!ID_SHAPE.test(prefix)) return { provider: sessionProvider, model: text };
  return { error: `Unknown model ${text}${where}: no provider \`${prefix}\` is installed. To name a model on another provider, write <provider>:<model>, for example ${sessionProvider}:${text}.` };
}

/**
 * The picker's list, after Hermes's model catalog: the provider's models first, in file order (its label wins),
 * then catalog extras: tool-call models, no dated ids (`-YYYYMMDD`), newest first, the whole list at most `limit` long
 * (the provider's own models are never cut). `window` is the catalog's context size.
 * `live` is the provider's own list (spec 7.2): its ids not already curated come after the curated models, before the catalog extras, all cut to `limit`.
 * ponytail: the picker can list an id the CLI rejects; a switch whose first reply fails is undone (session.ts).
 */
export function listModels(provider: { models: Array<{ id: string; label?: string }> }, catalog: CatalogModel[], limit: number, live: readonly string[] = []): PickerModel[] {
  const known = new Map(catalog.map((m) => [m.id, m]));
  const withWindow = (id: string, label: string): PickerModel => {
    const window = known.get(id)?.context;
    return window === undefined ? { id, label } : { id, label, window };
  };
  const have = new Set(provider.models.map((m) => m.id));
  const fromLive = live.filter((id) => !have.has(id)).slice(0, Math.max(0, limit - provider.models.length));
  for (const id of fromLive) have.add(id);
  const extras = catalog
    .filter((m) => m.toolCall === true && !/-\d{8}$/.test(m.id) && !have.has(m.id))
    .sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''))
    .slice(0, Math.max(0, limit - provider.models.length - fromLive.length));
  return [...provider.models.map((m) => withWindow(m.id, m.label ?? m.id)), ...fromLive.map((id) => withWindow(id, id)), ...extras.map((m) => withWindow(m.id, m.label))];
}
