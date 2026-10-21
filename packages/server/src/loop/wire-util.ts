// What both wires share: the caps of one reply, the deep merge, whole-number counts, the errors a wire builds, and the model list.
import type { EngineHost, ProviderManifest } from '../mods/types.js';
import { readBounded } from './bounded.js';

/** What a wire keeps of one reply, in characters (the loop bounds the whole reply, see MAX_REPLY), and the model list in bytes. */
export const MAX_ARGS = 4 * 1024 * 1024;
export const MAX_CALLS = 128;
export const MAX_EXTRA = 256 * 1024;
export const MAX_LIST = 1024 * 1024;
/** What the loop accepts of one reply (text, thinking and tool arguments together, in bytes), and how long one call may take from start to end. */
export const MAX_REPLY = 4 * 1024 * 1024;
export const MAX_CALL_MS = 30 * 60_000;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
// An own property even for the key `__proto__`, which a plain assignment would take for the prototype.
export const setOwn = (o: Obj, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/** `b` over `a`: objects are merged, anything else (arrays too) is replaced. Returns a new object; neither input is changed. */
export function merge(a: Obj, b: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(a)) setOwn(out, k, v);
  for (const [k, v] of Object.entries(b)) {
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
    setOwn(out, k, isObj(v) ? merge(isObj(cur) ? cur : {}, v) : v);
  }
  return out;
}

/** Streamed unknown fields add up: text joins, lists extend, objects merge, anything else is replaced. */
export function accumulate(into: Obj, k: string, v: unknown) {
  const cur = Object.hasOwn(into, k) ? into[k] : undefined;
  if (typeof cur === 'string' && typeof v === 'string') setOwn(into, k, cur + v);
  else if (Array.isArray(cur) && Array.isArray(v)) setOwn(into, k, [...cur, ...v]);
  else if (isObj(cur) && isObj(v)) setOwn(into, k, merge(cur, v));
  else setOwn(into, k, v);
}

/**
 * The keys of a request that Reins writes and no manifest `body` may set: the model that is billed (a body that changed it would defeat the price
 * the user was shown), the conversation, the tools, and the stream settings. The validator refuses a manifest that names them; `mergeBodies`
 * keeps them from Reins as the second layer.
 */
export const RESERVED_BODY = ['model', 'messages', 'tools', 'stream', 'stream_options'] as const;

/**
 * The manifest body, then the model's, then the chosen effort's, merged over `base` (later wins). The RESERVED_BODY keys are Reins's: they come
 * out as `base` has them, and a key `base` does not have (no tools in this request) is not added by a body.
 */
export function mergeBodies(base: Obj, p: ProviderManifest, model: string, effort: string | undefined): Obj {
  const layers = [p.body, p.models.find((x) => x.id === model)?.body, p.efforts?.find((e) => e.id === effort)?.body];
  const merged = layers.reduce<Obj>((acc, l) => (isObj(l) ? merge(acc, l) : acc), base);
  for (const k of RESERVED_BODY) {
    if (Object.hasOwn(base, k)) setOwn(merged, k, base[k]);
    else delete merged[k];
  }
  return merged;
}

/** A count from a provider: a whole number from 0 up. A fraction is cut down; a negative, odd or unsafe value is 0. */
export const count = (v: unknown) => {
  const n = typeof v === 'number' ? Math.floor(v) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** Whether a provider gave this counter at all: a number from 0 up (an explicit 0 is a real count; a missing, negative or odd value is not one). */
export const given = (v: unknown): boolean => typeof v === 'number' && v >= 0 && Number.isSafeInteger(Math.floor(v));

/** Most of a provider's error text that is shown, after redacting. */
const MAX_ERROR_TEXT = 500;
/** What an error says when the host's sanitizer fails: built without calling it again. */
export const HIDDEN = 'The request failed and its details were hidden.';

/**
 * Makes the errors of ONE call of a wire. Each is a new Error whose whole message went through the host's `redact` (provider text
 * included), cut after redacting to MAX_ERROR_TEXT plus the head; without a `redact` the provider's text and the manifest's label are
 * left out. `own` holds this call's errors only, so an error from anywhere else, an earlier call's included, is never taken for one.
 * `foreign(e)` is what a caught error becomes: this call's own errors go on as they are; anything else (a read that failed, a stream
 * that is not valid, a hostile value) is rebuilt as a new error with the host's sanitizer over the whole text, and a constant if looking fails.
 */
export function failures(h: EngineHost, p: ProviderManifest) {
  const own = new WeakSet<Error>();
  const fail = (what: (who: string) => string, provider?: string): Error => {
    let e: Error;
    try {
      const head = what(p.label);
      const max = head.length + 2 + MAX_ERROR_TEXT;
      let text = what('The provider');
      if (h.redact) {
        // The host's answer is held to its contract: a string of at most `max` characters. Anything else is not used.
        const got: unknown = h.redact(`${head}${provider ? `: ${provider}` : ''}`, max);
        if (typeof got !== 'string' || got.length > max) throw new Error('the sanitizer broke its contract');
        text = got;
      }
      e = new Error(text);
    } catch {
      e = new Error(HIDDEN); // the sanitizer itself failed: a constant, and it is not asked again
    }
    own.add(e);
    return e;
  };
  const foreign = (e: unknown): Error => {
    try {
      return own.has(e as Error) ? (e as Error) : fail((who) => `${who}'s reply was cut off`, e instanceof Error ? String(e.message) : String(e));
    } catch {
      return new Error(HIDDEN);
    }
  };
  return { fail, own, foreign };
}

/** The model ids of a list: strings, and the `id` of an object that has a string one; anything else in the list is dropped. Sorted, each once. */
export function modelIdsFrom(list: unknown[]): string[] {
  const ids = list.flatMap((x: unknown) => (typeof x === 'string' ? [x] : isObj(x) && typeof x.id === 'string' ? [x.id] : []));
  return [...new Set(ids)].sort();
}

/** `{ data: [{ id }] }`, or a bare list. Sorted; undefined when the request or the reading fails, the body is over 1 MiB, or nothing is listed. */
export async function listModelIds(req: { manifest: ProviderManifest; url: string; headers: Record<string, string> }, h: EngineHost, signal: AbortSignal): Promise<string[] | undefined> {
  try {
    if (!h.send) return undefined;
    const res = await h.send(req.manifest, req.url, { method: 'GET', headers: req.headers, signal }, 'models');
    const { text, over } = await readBounded(res, MAX_LIST);
    if (over) return undefined;
    const body: unknown = JSON.parse(text);
    const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.data) ? body.data : undefined;
    const ids = modelIdsFrom(list ?? []);
    return ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}
