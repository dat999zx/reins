// What a row of Settings > Providers says (spec 7.4), from one entry of `GET /api/mods`. Pure: no network, no React.
export interface ModRow {
  id: string; kind: string; label: string; enabled: boolean; bundled: boolean;
  /** `bundled`, `installed` (copied from the catalog) or `custom`. */
  source: string;
  replaces?: 'bundled';
  problems: string[];
  trust?: 'none' | 'trusted' | 'needs-trust' | 'restart';
  /** Only a provider Reins sends to has these. `key` is a state, never a value. */
  host?: string;
  key?: { state: 'set' | 'missing' | 'none'; source?: string };
  manifest?: Record<string, any>;
}

export const KEYS_LINE = 'Keys are stored in plain text in <home>/secrets.json, readable by programs running as you. An environment variable always works instead.';
export const AGENTS_LINE = 'Sessions on API providers do not read CLAUDE.md; put shared rules in AGENTS.md.';

const keyNames = (r: ModRow): string[] => (Array.isArray(r.manifest?.auth?.keyEnv) ? r.manifest!.auth.keyEnv.filter((n: unknown) => typeof n === 'string') : []);
export const usesKey = (r: ModRow) => r.manifest?.auth?.style === 'bearer' || r.manifest?.auth?.style === 'header';

/** The status words of spec 7.4. The first that applies wins. */
export function statusOf(r: ModRow): string {
  if (!r.enabled) return 'disabled';
  if (r.trust === 'restart') return 'restart to run the new code';
  if (r.trust === 'needs-trust') return 'needs trust';
  const proto = r.problems.some((p) => /`protocol` is `[^`]*`, which is not installed/.test(p)) ? r.manifest?.protocol : undefined;
  if (typeof proto === 'string') return `needs protocol ${proto}`;
  if (r.problems.length) return `invalid: ${r.problems.join(' ')}`;
  if (usesKey(r) && r.key?.state === 'missing') {
    const names = keyNames(r);
    return `key missing: ${names.length ? `set ${names.join(' or ')} or add` : 'add'} a key`;
  }
  return 'ready';
}

export function rowInfo(r: ModRow) {
  const m = r.manifest ?? {};
  let host = r.host;
  if (!host) try { host = new URL(String(m.baseUrl)).host; } catch { /* a bundled row with no address */ }
  const key = usesKey(r);
  return {
    status: statusOf(r),
    host,
    models: Array.isArray(m.models) ? m.models.length : 0,
    untested: m.untested === true,
    replaces: r.replaces === 'bundled' ? `replaces the built-in ${r.id}` : undefined,
    /** Shown instead of a value: the key itself is never in the list. */
    keyShown: key ? (r.key?.state === 'set' ? 'key set' : 'no key') : undefined,
    canSetKey: key,
    canClearKey: key && r.key?.state === 'set' && r.key.source === 'Reins',
    // Only a provider Reins sends to has a host from the server, and only a working one can be asked.
    canTest: r.host !== undefined && r.enabled && r.problems.length === 0,
    canEdit: !r.bundled,
    canRemove: !r.bundled,
    canReinstall: r.source === 'installed',
  };
}

/** The providers a custom endpoint can use: protocols that are on and well, except those a built-in provider uses (they run a program, not an API). */
export function apiProtocols(rows: ModRow[]): Array<{ id: string; label: string }> {
  const cli = new Set(rows.flatMap((r) => (r.kind === 'provider' && r.bundled && typeof r.manifest?.protocol === 'string' ? [r.manifest.protocol] : [])));
  return rows.filter((r) => r.kind === 'protocol' && r.enabled && !r.problems.length && !cli.has(r.id)).map((r) => ({ id: r.id, label: r.label }));
}
