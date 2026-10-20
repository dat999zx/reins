// The live model lists (spec 7.2, 9.1): each provider's own list, fetched through `send`, kept in memory, read without I/O.

/** The most ids kept of one list, and the longest id. */
export const MAX_LIVE_IDS = 2000;
export const MAX_LIVE_ID = 200;

const TTL_MS = 10 * 60_000;
const FAIL_MS = 60_000;
const TIMEOUT_MS = 8_000;

export interface LiveModelsOptions {
  /** The provider's list through its wire and `send`; undefined = this provider has no list to fetch (never throws on purpose; a throw counts as a failure). */
  fetchIds(provider: string, signal: AbortSignal): Promise<string[] | undefined> | undefined;
  /** A provider that needs no key: its list is fetched without consent. */
  keyless(provider: string): boolean;
  /** Whether consent is recorded for the provider (spec 7.8). A keyed provider is not asked about its list until this is true. */
  consented(provider: string): boolean;
  /** Whether a text holds a known secret; such an id is dropped. None: nothing is checked. */
  holdsSecret?: (text: string) => boolean;
  now?: () => number;
}

/** What a list holds after the checks: strings only, 1 to 200 characters, no control characters, no secret, no repeat, at most 2000. */
export function cleanIds(raw: unknown, holdsSecret?: (text: string) => boolean): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_LIVE_ID || [...id].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) || holdsSecret?.(id)) continue;
    out.add(id);
    if (out.size >= MAX_LIVE_IDS) break;
  }
  return [...out];
}

/**
 * Cached live lists. `ids` reads the cache and never does I/O. `refresh` asks the provider for its list, at most once per ten minutes
 * (a minute after a failure), and only when the provider is keyless or consent is recorded: with neither, no request is made at all.
 * A failure or a slow answer keeps what was cached (nothing at first), so the curated list stays; it never throws.
 */
export function createLiveModels(o: LiveModelsOptions) {
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; ok: boolean; ids: string[] }>();
  const inflight = new Map<string, Promise<void>>();

  async function run(provider: string) {
    let ids: string[] | undefined;
    try {
      ids = await o.fetchIds(provider, AbortSignal.timeout(TIMEOUT_MS));
    } catch {
      ids = undefined;
    }
    const old = cache.get(provider);
    cache.set(provider, { at: now(), ok: ids !== undefined, ids: ids !== undefined ? cleanIds(ids, o.holdsSecret) : old?.ids ?? [] });
  }

  return {
    ids: (provider: string): readonly string[] => cache.get(provider)?.ids ?? [],
    refresh(provider: string): Promise<void> {
      if (!o.keyless(provider) && !o.consented(provider)) return Promise.resolve();
      const c = cache.get(provider);
      if (c && now() - c.at < (c.ok ? TTL_MS : FAIL_MS)) return Promise.resolve();
      let p = inflight.get(provider);
      if (!p) {
        p = run(provider).finally(() => { inflight.delete(provider); });
        inflight.set(provider, p);
      }
      return p;
    },
  };
}
