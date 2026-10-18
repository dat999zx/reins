import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Provider id to key. A Map, so an id like `__proto__` or `constructor` is just an id (spec 8.1). */
export type Secrets = Map<string, string>;

/** What a manifest says about its key: the part `keyFor` reads. */
export interface KeyAuth { id: string; auth?: { style: string; keyEnv: string[] } }

export type Key = { kind: 'key'; key: string; source: string } | { kind: 'none' } | { kind: 'missing' };
/** The only shape a status or API may carry: no value. */
export interface KeyStatus { state: 'set' | 'missing' | 'none'; source?: string }

const secretsFile = (home: string) => path.join(home, 'secrets.json');

/** An env var name as the OS compares it: upper-cased on Windows, exact elsewhere. The one helper keyFor, knownSecrets and childEnv share. */
export const envName = (name: string, platform: string = process.platform) => (platform === 'win32' ? name.toUpperCase() : name);

/** The value of the env var `name`, found the way the OS finds it (case-insensitively on Windows). Own properties only. */
export function envGet(env: NodeJS.ProcessEnv, name: string, platform: string = process.platform): string | undefined {
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== 'win32') return undefined;
  const want = envName(name, platform);
  for (const k of Object.keys(env)) if (envName(k, platform) === want) return env[k];
  return undefined;
}

/** `<home>/secrets.json` as a Map. A missing or corrupt file, or an entry of the wrong shape, reads as nothing; this does not throw. */
export function readSecrets(home: string): Secrets {
  const out: Secrets = new Map();
  try {
    const providers = (JSON.parse(fs.readFileSync(secretsFile(home), 'utf8')) as { providers?: unknown })?.providers;
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      // Object.entries lists own properties only, so an own `__proto__` key is read as the id it is.
      for (const [id, e] of Object.entries(providers)) {
        const key = (e as { key?: unknown } | null)?.key;
        if (typeof key === 'string' && key !== '') out.set(id, key);
      }
    }
  } catch { /* corrupt or missing: no keys */ }
  return out;
}

/**
 * Temp file in the same folder (mode 0o600), then a rename over the target: a reader sees the old file or the new one, never half.
 * Windows ignores the mode. Known limits: two processes that edit the file at once can lose one update (read, change, rename is not
 * under a lock); and a symlinked home or secrets.json is followed on read, while the rename replaces the link itself.
 */
function writeSecrets(home: string, secrets: Secrets) {
  fs.mkdirSync(home, { recursive: true });
  // fromEntries defines own properties, so an id `__proto__` is written as a key, not as a prototype.
  const text = JSON.stringify({ providers: Object.fromEntries([...secrets].map(([id, key]) => [id, { key }])) }, null, 2) + '\n';
  const tmp = path.join(home, `.secrets-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, secretsFile(home));
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
    throw e;
  }
}

/** Stores the key (trimmed; an empty value clears it). Callers then `redactor.refresh()`. */
export function setKey(home: string, providerId: string, value: string) {
  const key = value.trim();
  const secrets = readSecrets(home);
  if (key === '') secrets.delete(providerId);
  else secrets.set(providerId, key);
  writeSecrets(home, secrets);
}

export function clearKey(home: string, providerId: string) {
  const secrets = readSecrets(home);
  if (secrets.delete(providerId)) writeSecrets(home, secrets);
}

/** The secrets entry first, else the first SET env var named in `auth.keyEnv` (an empty one is not set). `env` is the injected one, not `process.env`. */
export function keyFor(p: KeyAuth, secrets: Secrets, env: NodeJS.ProcessEnv, platform: string = process.platform): Key {
  if (!p.auth || p.auth.style === 'none') return { kind: 'none' };
  const own = secrets.get(p.id);
  if (own) return { kind: 'key', key: own, source: 'Reins' };
  for (const name of p.auth.keyEnv) {
    const v = envGet(env, name, platform);
    if (v) return { kind: 'key', key: v, source: name };
  }
  return { kind: 'missing' };
}

export function keyStatus(p: KeyAuth, secrets: Secrets, env: NodeJS.ProcessEnv, platform: string = process.platform): KeyStatus {
  const k = keyFor(p, secrets, env, platform);
  return k.kind === 'key' ? { state: 'set', source: k.source } : { state: k.kind };
}

/** The refusal when text to be saved as a workflow holds a known key. */
export const KEY_IN_WORKFLOW = 'That text contains a saved key, so it was not saved. Keys never go in a workflow.';

/** A secret shorter than this is left alone: it would hit ordinary text. */
export const MIN_SECRET = 8;

export interface KnownSecret { value: string; name: string }

/** Every value to hide: the secrets file's (named `Reins`) and the value of every env var in `keyEnvNames`, 8 characters or more. */
export function knownSecrets(secrets: Secrets, env: NodeJS.ProcessEnv, keyEnvNames: string[], platform: string = process.platform): KnownSecret[] {
  const out: KnownSecret[] = [];
  for (const v of secrets.values()) out.push({ value: v, name: 'Reins' });
  for (const name of keyEnvNames) {
    const v = envGet(env, name, platform);
    if (v) out.push({ value: v, name });
  }
  return out.filter((s) => s.value.length >= MIN_SECRET);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/**
 * Replaces known secret values with `[key <NAME>]`. The contract is: the values of the secrets file and of the env vars named
 * in `keyEnvNames`, 8 characters or more, in their raw form or their JSON-escaped form (a key inside a JSON string). Other
 * encodings (base64, URL-encoded, hex, `\u` escapes) are not recognised, and a 7-character key is left alone.
 *
 * The matcher is built once and reused for every call (one regex over every secret, longest first). It is rebuilt when
 * `refresh()` is called and when secrets.json changes on disk (one `stat` per call). Whoever writes a key (`setKey`,
 * `clearKey`) calls `refresh()` after, because a same-size rewrite within the file clock's tick would not show in the `stat`.
 * The env is read at construction and on `refresh()`; `keyEnvNames` is asked then too, so a mod installed later is covered
 * after a `refresh()`.
 */
export class Redactor {
  private re: RegExp | undefined;
  private names = new Map<string, string>();
  private variants: string[] = [];
  private stamp = '';

  constructor(private o: { home: string; env: NodeJS.ProcessEnv; keyEnvNames: () => string[]; platform?: string }) {
    this.refresh();
  }

  private stampNow(): string {
    try {
      const s = fs.statSync(secretsFile(this.o.home));
      // An atomic replace gives a new inode (and a new change time) even when size and mtime come out equal.
      return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    } catch { return 'none'; }
  }

  refresh() {
    this.stamp = this.stampNow();
    const names = new Map<string, string>();
    for (const s of knownSecrets(readSecrets(this.o.home), this.o.env, this.o.keyEnvNames(), this.o.platform)) {
      for (const v of [s.value, jsonEscaped(s.value)]) if (!names.has(v)) names.set(v, s.name);
    }
    this.names = names;
    // Longest first: at one position the regex takes the first alternative that matches, so a secret that contains another is removed whole.
    this.variants = [...names.keys()].sort((a, b) => b.length - a.length);
    this.re = names.size ? new RegExp(this.variants.map(escapeRegExp).join('|'), 'g') : undefined;
  }

  /** Looks at the secrets file once; the string walks below do it once per call, not once per string. ponytail: one stat per call (about 70 microseconds), not per operation. */
  private fresh() {
    if (this.stampNow() !== this.stamp) this.refresh();
  }

  private sub(text: string): string {
    return this.re ? text.replace(this.re, (m) => `[key ${this.names.get(m)}]`) : text;
  }

  // Arrow properties, so a caller can pass `redactor.redact` around without binding it.
  redact = (text: string): string => {
    this.fresh();
    return this.sub(text);
  };

  /**
   * The same value with every string (and every object key) redacted. Arrays and plain objects keep their shape; numbers, booleans
   * and null are left as they are (a key that is a bare JSON number is not recognised).
   */
  redactJson = <T>(value: T): T => {
    this.fresh();
    return this.re ? (this.walk(value) as T) : value;
  };

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.sub(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v !== null && typeof v === 'object') {
      if (isPlain(v) && typeof (v as { toJSON?: unknown }).toJSON !== 'function') {
        // fromEntries defines own properties, so a key `__proto__` stays a key.
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.sub(k), this.walk(x)]));
      }
      // A class instance, a Date, a Buffer, an object with toJSON: what gets written is its JSON form, so that is what is checked.
      // One that holds no secret is returned as it is.
      // ponytail: a circular plain object overflows the stack here (a RangeError); a circular class instance is a TypeError from stringify.
      const json = JSON.stringify(v);
      if (json === undefined || json.search(this.re!) < 0) return v;
      return this.walk(JSON.parse(json));
    }
    return v;
  }

  /** True when `text` holds a known secret (raw or JSON-escaped). */
  has = (text: string): boolean => {
    this.fresh();
    return this.re !== undefined && text.search(this.re) >= 0;
  };

  /**
   * How much of the start of `text` can be written out now: all of it, except the longest end of it that could be the start of a
   * known secret (a proper prefix of one), and any whole secret that reaches into that end. Used by `StreamRedactor`.
   */
  safeLength = (text: string): number => {
    this.fresh();
    if (!this.re) return text.length;
    let hold = 0;
    for (const v of this.variants) {
      for (let k = Math.min(v.length - 1, text.length); k > hold; k--) {
        if (text.endsWith(v.slice(0, k))) {
          hold = k;
          break;
        }
      }
    }
    let at = text.length - hold;
    if (hold) for (const m of text.matchAll(this.re)) if (m.index < at && m.index + m[0].length > at) { at = m.index; break; }
    return at;
  };
}

/**
 * Redacts a stream that arrives in pieces (command output): a key split across any number of chunks is still found. `push` returns the
 * text that is safe to write now; only the end of the pending text that could be the start of a known secret is held back, so ordinary
 * output is not delayed. `end` writes what is left (a half key that never completed is written as it is).
 * ponytail: the API agent loop (a later task) must use this for streamed model text; it is not wired there yet.
 */
export class StreamRedactor {
  private pending = '';

  constructor(private r: Pick<Redactor, 'redact' | 'safeLength'>) {}

  push(chunk: string): string {
    this.pending += chunk;
    const at = this.r.safeLength(this.pending);
    const head = this.pending.slice(0, at);
    this.pending = this.pending.slice(at);
    return this.r.redact(head);
  }

  end(): string {
    const out = this.r.redact(this.pending);
    this.pending = '';
    return out;
  }
}

/** The env a child process gets: `env` minus every name in `installedKeyEnvNames` and every `REINS_*` var. No secrets-file key is added. */
export function childEnv(env: NodeJS.ProcessEnv, installedKeyEnvNames: string[], platform: string = process.platform): NodeJS.ProcessEnv {
  const drop = new Set(installedKeyEnvNames.map((n) => envName(n, platform)));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const name = envName(k, platform);
    if (drop.has(name) || name.startsWith('REINS_')) continue;
    out[k] = v;
  }
  return out;
}
