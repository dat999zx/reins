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
  // Trimmed here, once, so the string that is sent is a string `knownSecrets` hides (a header would drop the edge whitespace on its own).
  // String.trim() removes Unicode whitespace, not only what a header drops: a key whose real value starts or ends with a no-break space is not supported.
  const own = secrets.get(p.id)?.trim();
  if (own) return { kind: 'key', key: own, source: 'Reins' };
  for (const name of p.auth.keyEnv) {
    const v = envGet(env, name, platform)?.trim();
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

/** Most RETIRED values a Redactor keeps for the life of the process (see `Redactor`): the oldest retired one is dropped first. */
export const MAX_RETAINED = 1000;

/**
 * Most CURRENT values (file and env keys, keys learned since the last refresh, keys in use by a send) a Redactor holds. None of them is ever
 * evicted to make room; past this bound `learn` and `hold` refuse (return false / undefined) and the send that wanted it is refused in plain words.
 */
export const MAX_CURRENT = 10_000;

/** The most text a StreamRedactor holds back while it cannot tell whether the end of it is the start of a key. */
export const MAX_HOLDBACK = 64 * 1024;
/** What replaces held text that grew past MAX_HOLDBACK, or a start of a key that the stream ended on. */
export const HELD_MARKER = '[hidden: text that looked like a key]';

export interface KnownSecret { value: string; name: string }

/** Every value to hide: the secrets file's (named `Reins`) and the value of every env var in `keyEnvNames`, 8 characters or more. */
export function knownSecrets(secrets: Secrets, env: NodeJS.ProcessEnv, keyEnvNames: string[], platform: string = process.platform): KnownSecret[] {
  const out: KnownSecret[] = [];
  // The value as stored and its trimmed form are two secrets, each subject to the minimum on its own: ` abcdefg ` (9 characters) is hidden whole.
  const add = (raw: string, name: string) => {
    for (const value of new Set([raw, raw.trim()])) if (value.length >= MIN_SECRET) out.push({ value, name });
  };
  for (const v of secrets.values()) add(v, 'Reins');
  for (const name of keyEnvNames) {
    const v = envGet(env, name, platform);
    if (v) add(v, name);
  }
  return out;
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
  /** Variant (raw or JSON-escaped) to the name in its marker; built from the three sets below, lazily. */
  private names = new Map<string, string>();
  private variants: string[] = [];
  private stamp = '';
  private dirty = true;
  // Three sets, all masked. CURRENT: the file and env values at the last refresh, plus values learned since; never evicted while current.
  // HELD: a key a send is using right now (a count); protected until the send's response is read or has failed. RETIRED: values that were
  // current and are not now; bounded at MAX_RETAINED, the one retired first dropped first. Nothing protected is ever evicted.
  private live = new Map<string, string>();
  private held = new Map<string, { name: string; n: number }>();
  private retired = new Map<string, string>();

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

  /**
   * Reads the secrets file and the env again. What they hold is CURRENT; a value that was current and no longer is (deleted or replaced) becomes
   * RETIRED, not forgotten: a request made with it can still be answered (an error that echoes its header) after it left the file. Retired values
   * stay masked until MAX_RETAINED newer ones have been retired. A value a send is using is protected whatever the file says.
   */
  refresh() {
    this.stamp = this.stampNow();
    const next = new Map<string, string>();
    for (const s of knownSecrets(readSecrets(this.o.home), this.o.env, this.o.keyEnvNames(), this.o.platform)) if (!next.has(s.value)) next.set(s.value, s.name);
    for (const v of next.keys()) this.retired.delete(v);
    for (const [v, name] of this.live) if (!next.has(v)) this.retire(v, name);
    this.live = next;
    this.dirty = true;
  }

  private retire(value: string, name: string) {
    if (this.held.has(value)) return; // released later, then retired
    this.retired.delete(value);
    this.retired.set(value, name);
    while (this.retired.size > MAX_RETAINED) this.retired.delete(this.retired.keys().next().value!);
  }

  private room(value: string): boolean {
    return this.live.has(value) || this.held.has(value) || this.live.size + this.held.size < MAX_CURRENT;
  }

  /**
   * Masks this value from now on, as a CURRENT value until the next refresh (then it is retired if the file and env do not hold it). Values under
   * MIN_SECRET are left alone. Returns false, and learns nothing, when MAX_CURRENT values are already protected.
   */
  learn = (value: string, name: string): boolean => {
    const vs = [...new Set([value, value.trim()])].filter((v) => v.length >= MIN_SECRET);
    if (!vs.every((v) => this.room(v))) return false;
    for (const v of vs) if (!this.live.has(v)) { this.retired.delete(v); this.live.set(v, name); }
    this.dirty = true;
    return true;
  };

  /**
   * Protects the key a send is about to attach until the send is over: the returned function releases it (call it when the response is read or
   * has failed; calling it twice does nothing). While held the value is masked and cannot be evicted. Undefined = no room (MAX_CURRENT values
   * are protected); the send must not go. A value under MIN_SECRET gets a function that does nothing.
   */
  hold = (value: string, name: string): (() => void) | undefined => {
    const vs = [...new Set([value, value.trim()])].filter((v) => v.length >= MIN_SECRET);
    if (!vs.every((v) => this.room(v))) return undefined;
    for (const v of vs) {
      this.retired.delete(v);
      const h = this.held.get(v);
      if (h) h.n++;
      else this.held.set(v, { name, n: 1 });
    }
    this.dirty = true;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const v of vs) {
        const h = this.held.get(v);
        if (!h || --h.n > 0) continue;
        this.held.delete(v);
        if (!this.live.has(v)) this.retire(v, h.name);
      }
      this.dirty = true;
    };
  };

  private rebuild() {
    this.dirty = false;
    const names = new Map<string, string>();
    const add = (value: string, name: string) => {
      for (const v of [value, jsonEscaped(value)]) if (!names.has(v)) names.set(v, name); // first seen, first named
    };
    for (const [v, name] of this.live) add(v, name);
    for (const [v, h] of this.held) add(v, h.name);
    for (const [v, name] of this.retired) add(v, name);
    this.names = names;
    // Longest first: at one position the regex takes the first alternative that matches, so a secret that contains another is removed whole.
    this.variants = [...names.keys()].sort((a, b) => b.length - a.length);
    this.re = names.size ? new RegExp(this.variants.map(escapeRegExp).join('|'), 'g') : undefined;
  }

  /** Looks at the secrets file once; the string walks below do it once per call, not once per string. ponytail: one stat per call (about 70 microseconds), not per operation. */
  private fresh() {
    if (this.stampNow() !== this.stamp) this.refresh();
    if (this.dirty) this.rebuild();
  }

  /**
   * Every occurrence of every variant, overlapping ones included, as [start, end, variant index] sorted by start then index (the variants
   * are sorted longest first, so a lower index is a longer or earlier one). Cost: one native `indexOf` pass per variant, O(V * L) for V
   * variants and L characters, plus a sort of the K occurrences found. Callers run it only after the single regex has found a match.
   */
  private occurrences(text: string): Array<[number, number, number]> {
    const hits: Array<[number, number, number]> = [];
    this.variants.forEach((v, vi) => {
      for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) hits.push([i, i + v.length, vi]);
    });
    return hits.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  }

  /**
   * Replaces the UNION of all matches: the ranges of every occurrence are merged where they overlap, and each merged range becomes one marker,
   * the one of the longest (then first) variant in it. A single regex pass would take one of two overlapping secrets and leave the rest of the other.
   * The regex runs first as a cheap test: when no variant occurs at all, the text is returned as it is.
   */
  private sub(text: string): string {
    if (!this.re || text.search(this.re) < 0) return text;
    let out = '';
    let at = 0;
    let start = -1;
    let end = -1;
    let best = 0;
    const flush = () => {
      if (end < 0) return;
      out += `${text.slice(at, start)}[key ${this.names.get(this.variants[best])}]`;
      at = end;
    };
    for (const [s, e, vi] of this.occurrences(text)) {
      if (end >= 0 && s < end) {
        end = Math.max(end, e);
        best = Math.min(best, vi);
      } else {
        flush();
        start = s;
        end = e;
        best = vi;
      }
    }
    flush();
    return out + text.slice(at);
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
    if (hold) {
      // Any occurrence, overlapping ones too, that starts before the cut and reaches past it moves the cut to its start; that can bring another into reach.
      // One pass from the last start to the first is exact (a hit that starts at or after the cut can never straddle a cut that only moves back)
      // and linear; repeated passes over the list were quadratic for periodic text.
      const hits = this.occurrences(text);
      for (let i = hits.length - 1; i >= 0; i--) {
        const [s, e] = hits[i]!;
        if (s < at && e > at) at = s;
      }
    }
    return at;
  };
}

/**
 * `text` redacted as a whole, then cut to `max` characters. The cut comes after the redaction, and it never leaves an end that could be
 * the start of a known secret (`safeLength`), so no half key is shown. Use it for every error text that is cut to a display length.
 */
export function redactCut(r: Pick<Redactor, 'redact' | 'safeLength'>, text: string, max?: number): string {
  const red = r.redact(text);
  // The guard runs on every result, cut or not: a text that ends on the start of a key is not shown with that end. (A message that merely
  // ends in the first character of a key loses that last character; that is the price of the guard.)
  const head = max === undefined ? red : red.slice(0, Math.max(0, max));
  return head.slice(0, r.safeLength(head));
}

/**
 * Redacts a stream that arrives in pieces (command output): a key split across any number of chunks is still found. `push` returns the
 * text that is safe to write now; only the end of the pending text that could be the start of a known secret is held back, so ordinary
 * output is not delayed. `end` writes what is left, except an end that is the start of a known key, however short
 * (a half key that never completed): that is replaced by HELD_MARKER. What is held never exceeds MAX_HOLDBACK characters (see `push`).
 * Used for command output: the loop's shell tool (`host.redactStream`) and workflow commands. The API agent loop's text, thinking and tool inputs do
 * not use it: it joins a reply's deltas into whole messages first and redacts each whole message (the host's `redactAll`).
 */
export class StreamRedactor {
  private pending = '';

  constructor(private r: Pick<Redactor, 'redact' | 'safeLength'>) {}

  push(chunk: string): string {
    this.pending += chunk;
    const at = this.r.safeLength(this.pending);
    const head = this.pending.slice(0, at);
    this.pending = this.pending.slice(at);
    // Text such as a long run of one letter against a key made of it can never be told apart from a key's start. The hold is bounded: past
    // MAX_HOLDBACK the held text is replaced whole by a marker and the hold starts empty, so nothing unredacted leaves and memory stays bounded.
    if (this.pending.length > MAX_HOLDBACK) {
      this.pending = '';
      return this.r.redact(head) + HELD_MARKER;
    }
    return this.r.redact(head);
  }

  end(): string {
    const red = this.r.redact(this.pending);
    this.pending = '';
    const at = this.r.safeLength(red);
    // Every nonempty held end is hidden, however short: it is the start of a known key. (An output that ends exactly on such a start, with no
    // newline after it, shows the marker in its place; a line ends with a newline in ordinary output, which is never held.)
    return at < red.length ? red.slice(0, at) + HELD_MARKER : red;
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
