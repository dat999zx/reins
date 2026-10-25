import fs from 'node:fs';

export interface CatalogModel {
  id: string;
  label: string;
  released?: string;
  toolCall?: boolean;
  context?: number;
  output?: number;
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ size: number; input?: number }> };
}
export type Catalog = ReturnType<typeof createCatalog>;

const TTL_MS = 4 * 3_600_000; // Hermes models_dev.py:28
const BACKOFF_MS = 5 * 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function modelOf(id: string, m: unknown): CatalogModel | undefined {
  if (!isObject(m)) return undefined;
  const limit = isObject(m.limit) ? m.limit : {};
  const cost = isObject(m.cost) ? m.cost : {};
  const tiers = Array.isArray(cost.tiers)
    ? cost.tiers.flatMap((t) => {
      if (!isObject(t) || !isObject(t.tier) || t.tier.type !== 'context' || num(t.tier.size) === undefined) return [];
      return [defined({ size: t.tier.size as number, input: num(t.input) })];
    })
    : [];
  const input = num(cost.input);
  const output = num(cost.output);
  return defined({
    id, label: str(m.name) ?? id, released: str(m.release_date),
    toolCall: typeof m.tool_call === 'boolean' ? m.tool_call : undefined,
    context: num(limit.context), output: num(limit.output),
    price: input === undefined || output === undefined ? undefined
      : defined({ input, output, cacheRead: num(cost.cache_read), cacheWrite: num(cost.cache_write), tiers: tiers.length ? tiers : undefined }),
  });
}

/**
 * The model catalog (models.dev), after Hermes's cache: the disk copy of any age is served while one refresh runs in the
 * background. ponytail: no ETag conditional request (a 5 MB download at most every 4 hours).
 */
export function createCatalog(o: { file: string; fetch?: typeof fetch; now?: () => number; url?: string }) {
  const now = o.now ?? Date.now;
  let data: Record<string, unknown> | undefined;
  let failedAt: number | undefined;
  let inflight: Promise<void> | undefined;
  const closing = new AbortController();

  function load(): Record<string, unknown> {
    if (data) return data;
    data = {};
    let text: string;
    try {
      text = fs.readFileSync(o.file, 'utf8');
    } catch {
      return data;
    }
    try {
      const v: unknown = JSON.parse(text);
      if (isObject(v)) return (data = v);
    } catch { /* corrupt */ }
    try { fs.renameSync(o.file, `${o.file}.corrupt`); } catch { /* left in place */ }
    return data;
  }

  // Never rejects: any error (fetch, status, body, write, rename) is one failed refresh with a 5-minute back-off.
  async function run() {
    const tmp = `${o.file}.${process.pid}.tmp`;
    try {
      load();
      if (!o.fetch) return;
      const age = (() => { try { return now() - fs.statSync(o.file).mtimeMs; } catch { return Infinity; } })();
      if (age < TTL_MS) return;
      if (failedAt !== undefined && now() - failedAt < BACKOFF_MS) return;
      const res = await o.fetch(o.url ?? 'https://models.dev/api.json', { signal: AbortSignal.any([AbortSignal.timeout(10_000), closing.signal]) });
      if (res.status !== 200) throw new Error(`models.dev answered ${res.status}`);
      const text = await res.text();
      const v: unknown = JSON.parse(text);
      if (!isObject(v)) throw new Error('models.dev did not answer an object');
      data = v; // kept in memory even if the write below fails
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, o.file);
      failedAt = undefined;
    } catch {
      failedAt = now();
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    }
  }

  return {
    models(key: string): CatalogModel[] {
      const p = load()[key];
      const models = isObject(p) && isObject(p.models) ? p.models : {};
      return Object.entries(models).flatMap(([id, m]) => modelOf(id, m) ?? []);
    },
    refresh(): Promise<void> {
      return (inflight ??= run().finally(() => { inflight = undefined; }));
    },
    close() { closing.abort(); },
  };
}
