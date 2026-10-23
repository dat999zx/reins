// What a row of Settings > Providers says (spec 7.4), from one entry of `GET /api/mods`. Pure: no network, no React.
export interface ModRow {
  id: string; kind: string; label: string; enabled: boolean; bundled: boolean;
  /** `bundled`, `installed` (copied from the catalog) or `custom`. */
  source: string;
  replaces?: 'bundled';
  /** The default pack: its mods can be customized, and a required one has no off switch. */
  pack?: 'default';
  required?: boolean;
  /** A user copy of a built-in: the built-in's version, and whether it is newer than the copy. */
  builtinVersion?: string;
  newer?: boolean;
  problems: string[];
  trust?: 'none' | 'trusted' | 'needs-trust' | 'restart';
  /** Only a provider Reins sends to has these. `key` is a state, never a value. */
  host?: string;
  key?: { state: 'set' | 'missing' | 'none'; source?: string };
  manifest?: Record<string, any>;
  /** A user mod with code: the hash the Trust button names, and the prompt shown before it. */
  hash?: string;
  codePrompt?: string;
}

/** `secretsPath` is the real file, from the list reply. */
export const keysLine = (secretsPath: string) => `Keys are stored in plain text in ${secretsPath}, readable by programs running as you. An environment variable always works instead.`;
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

/** A copy of a built-in that has fallen behind it (the server compares the versions). */
const newerLine = (r: ModRow) => (r.newer ? `the built-in is newer${r.builtinVersion ? ` (${r.builtinVersion})` : ''}` : undefined);

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
    newer: newerLine(r),
    /** Shown instead of a value: the key itself is never in the list. */
    // Spec 8.1: the source after it when a variable supplies the key; the Reins file is the default and says nothing more.
    keyShown: key ? (r.key?.state === 'set' ? (r.key.source && r.key.source !== 'Reins' ? `key set (${r.key.source})` : 'key set') : 'no key') : undefined,
    canSetKey: key,
    canClearKey: key && r.key?.state === 'set' && r.key.source === 'Reins',
    // Only a provider Reins sends to has a host from the server, and only a working one can be asked.
    canTest: r.host !== undefined && r.enabled && r.problems.length === 0,
    canEdit: !r.bundled && r.kind === 'provider',
    canRemove: !r.bundled,
    /** A required mod has no off switch. */
    canDisable: r.required !== true,
    /** A built-in mod of the default pack can be copied to the user's folder. */
    canCustomize: r.bundled && r.pack === 'default',
    canReinstall: r.source === 'installed',
    /** A code mod that waits for a yes, and has the hash and the prompt the yes needs. */
    canTrust: r.trust === 'needs-trust' && typeof r.hash === 'string' && typeof r.codePrompt === 'string',
  };
}

/** The labels of the providers that use the protocol `id` (from their manifests). */
export const usedBy = (rows: ModRow[], id: string): string[] => rows.filter((r) => r.kind === 'provider' && r.manifest?.protocol === id).map((r) => r.label);

/** The confirm line for switching off or removing something providers use (spec: disabled protocols are not silent). */
export const stopsLine = (labels: string[]) => `Providers that use it will stop working: ${labels.join(', ')}`;

/** The second line of a row in "Protocols and other mods": kind, bundled or user, and who uses it. */
export const otherMeta = (r: ModRow, users: string[]) => [
  r.kind, r.bundled ? 'bundled' : 'user', r.pack ? 'default pack' : '', r.required ? 'required' : '',
  r.replaces === 'bundled' ? `replaces the built-in ${r.id}` : '', newerLine(r) ?? '', users.length ? `used by ${users.join(', ')}` : '',
].filter(Boolean).join(' · ');

/** The providers a custom endpoint can use: protocols that are on and well, except those a built-in provider uses (they run a program, not an API). */
export function apiProtocols(rows: ModRow[]): Array<{ id: string; label: string }> {
  const cli = new Set(rows.flatMap((r) => (r.kind === 'provider' && r.bundled && typeof r.manifest?.protocol === 'string' ? [r.manifest.protocol] : [])));
  return rows.filter((r) => r.kind === 'protocol' && r.enabled && !r.problems.length && !cli.has(r.id)).map((r) => ({ id: r.id, label: r.label }));
}
