import { readBounded } from './loop/bounded.js';
import { keyFor, redactCut, type Redactor, type Secrets } from './secrets.js';
import type { ProviderManifest, SendWithKey } from './mods/types.js';

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown } | null | undefined)?.then === 'function';

/** The consent question has no "yes" yet for this provider and address. Nothing was sent. `message` is optional: the default names the address. */
export class ConsentNeeded extends Error {
  constructor(public modId: string, public origin: string, message?: string) {
    super(message ?? `Reins has not been allowed to send your prompts and your key to ${origin} for \`${modId}\`.`);
    this.name = 'ConsentNeeded';
  }
}

/**
 * The engine that asked to send was opened for an address that is no longer the provider's (it was edited, replaced, switched off or removed
 * since). Nothing was sent; the session drops that engine, so the next reply opens a new one and asks about the new address.
 */
export class ProviderChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderChanged';
  }
}

/**
 * `send` itself said no before any request: no key, an address that holds a saved key, too many keys, an address that is not the provider's.
 * Nothing was sent. It is not a network failure: it is never tried again, and its words are shown as they are. The error stays a plain `Error`
 * (no subclass, no extra property: nothing of the call is carried); it is remembered here, by identity, so only this file can mark one.
 */
const refusals = new WeakSet<object>();
export const isSendRefusal = (e: unknown): boolean => typeof e === 'object' && e !== null && refusals.has(e);

/** The provider answered with an error status. `message` holds the status and the redacted body. */
export class ProviderError extends Error {
  /** `retryAfter`: the reply's Retry-After header as sent (seconds or a date), for the loop's back-off; never shown. */
  constructor(message: string, public status: number, public retryAfter?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Most of an error body that is read, and most of it that is shown. */
const MAX_ERROR_READ = 64 * 1024;
const MAX_ERROR_TEXT = 2000;
/** What anyone gets when the sanitizer or the classifier itself fails: built without calling either again. */
const HIDDEN = 'The request failed and its details were hidden.';
const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * The same reply with its body passed through, calling `release` once when the body ends, fails or is cancelled. Undefined when the reply cannot
 * be rebuilt (a status that takes no body); the caller then releases at once.
 */
function watchBody(res: Response, release: () => void): Response | undefined {
  if ([101, 204, 205, 304].includes(res.status)) return undefined;
  try {
    const reader = res.body!.getReader();
    const out = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            release();
            c.close();
          } else c.enqueue(r.value);
        } catch (e) {
          release();
          c.error(e);
        }
      },
      cancel(reason) {
        release();
        return reader.cancel(reason);
      },
    });
    return new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch {
    return undefined;
  }
}

/** What one call refused, as plain fields. It becomes a public error only at the boundary, with every text sanitized there. */
type Refusal =
  | { kind: 'plain'; message: string }
  | { kind: 'consent'; modId: string; origin: string }
  | { kind: 'changed'; message: string }
  | { kind: 'provider'; status: number; message: string; cap: number; retryAfter?: string };

/** Carries a Refusal out of `run`. Never leaves this file; the boundary reads it only when its token is the one of this very call. */
class Local extends Error {
  constructor(readonly token: object, readonly refusal: Refusal) {
    super('refused');
  }
}

/**
 * Spec 7.8: the ONLY function that attaches a key. In order: one snapshot of the manifest and of the request options; (1) the URL must have
 * the origin of the snapshot's `baseUrl`, parsed, not compared as text, and hold no user name, no broken percent escape and no known key;
 * (2) consent for (mod id, origin); (3) the auth header from `keyFor`; (4) `redirect: 'error'`, so no header follows a redirect;
 * (5) every error, and the body of an error reply, is sanitized as one assembled string at a single boundary.
 *
 * `purpose` (4th argument, default `'chat'`): `'models'` skips the consent question only for a keyless provider, a GET with no body, to the
 * snapshot's own model-list address, exactly (the wire's fixed query included, any other path or query asks). Anything else asks, because
 * prompts and files go there.
 *
 * The fetch options are built here from an allowlist (method, body, signal, the rebuilt headers): a `dispatcher` or any other transport
 * option of the caller is never passed on, since the transport must belong to this function.
 *
 * Errors: what this call refuses itself is rebuilt fresh at the boundary from plain fields. Anything else that is thrown (the consent
 * callback, fetch, the redactor, the key lookup, a hostile value) is foreign and becomes a new plain Error with a sanitized message, no
 * cause, no extra properties, no original stack. If sanitizing or classifying fails, the error is a constant text.
 */
export function makeSend(o: {
  secrets(): Secrets;
  env: NodeJS.ProcessEnv;
  redactor: Pick<Redactor, 'redact' | 'has' | 'safeLength'> & Partial<Pick<Redactor, 'learn' | 'hold'>>;
  consent(modId: string, origin: string): boolean | Promise<boolean>;
  /** The consent as it is at this very moment, answered at once (the store's `hasConsent`); asked right before the request starts. A promise is "no". */
  consentNow?(modId: string, origin: string): boolean;
  /**
   * The provider's CURRENT installed manifest (the live registry), asked at every send. An engine keeps the manifest it was opened with; when the
   * current base address has another origin, or the provider is gone, nothing is sent. None: the manifest of the call is trusted (tests).
   */
  current?(modId: string): { id: string; kind: string; baseUrl: string; label?: string } | undefined;
  /** The address of the provider's model list as its wire defines it (query included), for the keyless exemption. None: `modelsUrl` or `<baseUrl>/models`. */
  listUrl?(mod: ProviderManifest): string | undefined;
  fetch?: typeof fetch;
  platform?: string;
}): SendWithKey {
  const sanitize = (text: string, cap?: number) => redactCut(o.redactor, text, cap);

  // A foreign error as a fresh plain one. Throws when anything about it does; the boundary turns that into HIDDEN.
  const clean = (e: unknown): Error => {
    let text: string;
    let name = '';
    if (e instanceof Error) {
      const cause = e.cause;
      text = String(cause instanceof Error && cause.message ? `${e.message}: ${cause.message}` : e.message);
      name = e.name;
    } else text = String(e);
    const out = new Error(sanitize(/redirect/i.test(text) ? 'The provider answered with a redirect, which Reins does not follow.' : text));
    if (name === 'AbortError' || name === 'TimeoutError') out.name = name; // only these two names: another name could carry text
    return out;
  };

  const boundary = (e: unknown, token: object): Error => {
    try {
      if (e instanceof Local && e.token === token) {
        const r = e.refusal;
        if (r.kind === 'consent') {
          const modId = sanitize(r.modId);
          const origin = sanitize(r.origin);
          return new ConsentNeeded(modId, origin, sanitize(new ConsentNeeded(r.modId, r.origin).message));
        }
        if (r.kind === 'changed') return new ProviderChanged(sanitize(r.message));
        if (r.kind === 'provider') return new ProviderError(sanitize(r.message, r.cap), r.status, r.retryAfter);
        const refused = new Error(sanitize(r.message));
        refusals.add(refused);
        return refused;
      }
      return clean(e);
    } catch {
      return new Error(HIDDEN);
    }
  };

  const originOf = (token: object, what: string, v: string): URL => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Local(token, { kind: 'plain', message: `${what} is not a full web address.` });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Local(token, { kind: 'plain', message: `${what} must be an http or https address.` });
    return u;
  };

  /** The parts of an address that carry text, decoded one by one: a bad escape in one cannot hide a key in another. `undefined` when any part will not decode. */
  const parts = (u: URL): string[] | undefined => {
    const raw = [...u.pathname.split('/'), ...u.search.slice(1).split('&').flatMap((kv) => kv.split('=')), u.hash.slice(1)];
    try {
      return raw.map((p) => decodeURIComponent(p.replace(/\+/g, ' ')));
    } catch {
      return undefined;
    }
  };

  const run = async (token: object, mod: ProviderManifest, url: string, init: RequestInit, purpose: 'models' | 'chat'): Promise<Response> => {
    const refuse = (message: string): never => {
      throw new Local(token, { kind: 'plain', message });
    };
    // One snapshot, before any await: getters run once, and what consent is asked about is what the request uses.
    let m: ProviderManifest;
    let headers: Headers;
    let method: string | undefined;
    let body: RequestInit['body'];
    let signal: RequestInit['signal'];
    try {
      m = JSON.parse(JSON.stringify(mod)) as ProviderManifest;
    } catch {
      return refuse('The provider settings could not be read.');
    }
    if (typeof m?.id !== 'string' || typeof m.baseUrl !== 'string') return refuse('The provider settings are missing an id or a base address.');
    try {
      headers = new Headers(init.headers);
      method = typeof init.method === 'string' ? init.method : undefined;
      body = init.body;
      signal = init.signal;
    } catch {
      return refuse('The request options could not be read.');
    }
    const label = typeof m.label === 'string' && m.label !== '' ? m.label : m.id;

    const base = originOf(token, `The base address of \`${m.id}\``, m.baseUrl);
    // The engine's own copy of the manifest may be old: the provider's installed manifest NOW decides where anything may go. Synchronous, and
    // run twice: early (so a stale engine is refused before it asks anything) and again as the very last step before the request starts.
    const checkCurrent = () => {
      if (!o.current) return;
      let now: string | undefined;
      try {
        const cur = o.current(m.id);
        // Only a provider of this very id counts; any other shape (another kind, another id, a value that is not a manifest) is "not installed".
        now = cur && typeof cur === 'object' && cur.id === m.id && cur.kind === 'provider' ? new URL(cur.baseUrl).origin : undefined;
      } catch {
        now = undefined; // a lookup that throws is no answer: nothing is sent
      }
      if (now === undefined) throw new Local(token, { kind: 'changed', message: `${label} is no longer installed or is switched off, so nothing was sent.` });
      if (now !== base.origin) throw new Local(token, { kind: 'changed', message: `The address of ${label} changed. The next reply asks again.` });
    };
    checkCurrent();
    const target = originOf(token, 'The request address', String(url));
    if (target.username || target.password) refuse('The request address must not hold a user name or password.');
    if (target.origin !== base.origin) refuse(`Reins sends \`${m.id}\` requests only to ${base.origin}; ${target.origin} was refused. Nothing was sent.`);
    const decoded = parts(target);
    if (!decoded) refuse('The request address has a broken percent escape, so nothing was sent.');
    if ([target.href, ...(decoded ?? [])].some((t) => o.redactor.has(t))) refuse('The request address holds a saved key, so nothing was sent.');

    const keyless = !m.auth || m.auth.style === 'none';
    let modelList = '';
    try {
      modelList = new URL(o.listUrl?.(m) ?? (typeof m.modelsUrl === 'string' ? m.modelsUrl : `${m.baseUrl.replace(/\/+$/, '')}/models`)).href;
    } catch {
      /* no valid list address: nothing qualifies as the list */
    }
    // The exact address of the list, its fixed query included, and nothing else.
    const listing = purpose === 'models' && keyless && modelList !== '' && target.href === modelList
      && (method === undefined || method.toUpperCase() === 'GET') && (body === undefined || body === null);
    // A synchronous answer (the production store's) is NOT awaited: from this check to the request below there is no await, so no revocation can
    // land in between (an `await` of a plain boolean still gives other tasks a turn). A callback that answers with a promise has to be awaited, and
    // then its answer is old: the last step before the request asks `consentNow` again (see below), and without one it is not consent.
    let heardInTime = false;
    if (!listing) {
      const asked = o.consent(m.id, base.origin);
      let granted: boolean;
      if (isThenable(asked)) granted = (await asked) === true;
      else {
        granted = asked === true;
        heardInTime = granted;
      }
      if (!granted) throw new Local(token, { kind: 'consent', modId: m.id, origin: base.origin });
    }

    const manifestHeaders = typeof m.headers === 'object' && m.headers !== null ? m.headers : {};
    try {
      for (const [k, v] of Object.entries(manifestHeaders)) if (typeof v === 'string') headers.set(k, v);
    } catch {
      return refuse(`\`${m.id}\` has a header that is not valid.`);
    }
    const key = keyFor(m, o.secrets(), o.env, o.platform);
    if (key.kind === 'missing') {
      const names = Array.isArray(m.auth?.keyEnv) ? m.auth.keyEnv : [];
      return refuse(`No key for ${label}. Add it in Settings${names.length ? ` or set ${names.join(' or ')}` : ''}.`);
    }
    // A key that is attached is masked, and protected from eviction, until this send is over, even if it is removed or replaced before the
    // answer comes back. `release` runs when the response is fully read or has failed (below).
    let release: (() => void) | undefined;
    if (key.kind === 'key' && o.redactor.hold) {
      release = o.redactor.hold(key.key, key.source);
      if (!release) return refuse('Too many keys are in use to keep them all hidden, so nothing was sent.');
    } else if (key.kind === 'key') o.redactor.learn?.(key.key, key.source);
    let handedOver = false;
    try {
      if (key.kind === 'key') {
        const style = m.auth?.style;
        const name = style === 'bearer' ? 'Authorization' : style === 'header' ? m.auth?.header : undefined;
        if (!name) return refuse(style === 'header' ? `\`${m.id}\` uses a key header but names none.` : `\`${m.id}\` has an auth style Reins does not know.`);
        if (hasControl(key.key)) return refuse(`The key for ${label} holds a control character, so it cannot be sent as a header.`);
        try {
          headers.set(name, style === 'bearer' ? `Bearer ${key.key}` : key.key); // last, so it replaces any same-named header, whatever its case
        } catch {
          return refuse(`The key for ${label} cannot be sent as a header (it holds a character a header cannot).`);
        }
      }

      // Every await is behind us. The installed provider is looked at once more, and the request starts in the same synchronous step: nothing
      // can change the installed address between this check and the call that sends.
      checkCurrent();
      // The consent as it is NOW, asked synchronously, in the same step as the request: an answer given before an await is never reused. An answer
      // that is a promise is not an answer. Without `consentNow`, an answer that arrived with no await since (a synchronous callback) still stands,
      // because nothing could run between it and here; an asynchronous callback with no `consentNow` is therefore never consent.
      if (!listing) {
        const now = o.consentNow ? o.consentNow(m.id, base.origin) : heardInTime;
        if (now !== true) throw new Local(token, { kind: 'consent', modId: m.id, origin: base.origin });
      }
      const started = (o.fetch ?? fetch)(target.href, {
        ...(method !== undefined ? { method } : {}),
        ...(body !== undefined && body !== null ? { body } : {}),
        ...(signal ? { signal } : {}),
        headers,
        redirect: 'error',
      });
      const res = await started;
      // The status is read once, and only a whole HTTP status is used: a fetch that hands over anything else gets no further.
      const status: unknown = res.status;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return refuse(`${label} answered with a status Reins cannot use, so the reply was not used.`);
      if (status >= 400) {
        const { text, over } = await readBounded(res, MAX_ERROR_READ);
        // A read cut by the limit may end inside a key: that end is dropped before anything is redacted.
        const detail = over ? text.slice(0, o.redactor.safeLength(text)) : text;
        const head = `${label} answered ${status}`;
        const message = detail ? `${head}: ${detail}` : `${head}.`;
        // The whole message is sanitized as one string at the boundary; the cap leaves room for the head, however it reads redacted.
        let retryAfter: string | undefined;
        try {
          retryAfter = res.headers.get('retry-after')?.slice(0, 100); // a fetch that hands over odd headers has no Retry-After
        } catch { /* none */ }
        throw new Local(token, { kind: 'provider', status, message, cap: sanitize(head).length + 2 + MAX_ERROR_TEXT, ...(retryAfter ? { retryAfter } : {}) });
      }
      // A good reply is read by the caller, later: the key stays protected until its body has ended, failed or been cancelled.
      if (release && res.body && typeof res.body.getReader === 'function') {
        const wrapped = watchBody(res, release);
        if (wrapped) {
          handedOver = true;
          return wrapped;
        }
      }
      return res;
    } finally {
      if (!handedOver) release?.();
    }
  };

  return async (mod, url, init, purpose = 'chat') => {
    const token = {}; // this call's own: nothing outside it can make an error pass for one of its refusals
    try {
      return await run(token, mod, url, init ?? {}, purpose === 'models' ? 'models' : 'chat');
    } catch (e) {
      throw boundary(e, token);
    }
  };
}
