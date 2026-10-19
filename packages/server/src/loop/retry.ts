// Spec 4.9: which failures are tried again, how long to wait, and the words of the final error.
import { ConsentNeeded, ProviderError } from '../send.js';

export type ErrorClass = 'rate' | 'server' | 'network' | 'stall' | 'auth' | 'notFound' | 'bad' | 'redirect' | 'consent';

/** Calls made in all for a rate limit, a server error or a network failure. */
export const TRIES = 4;
/** No byte from the provider for this long: abort the call and try once more. */
export const STALL_MS = 120_000;
const MAX_RETRY_AFTER_S = 60;
const BACKOFF_S = [1, 2, 4, 8];

/** What the final error says. `who` is the provider's label; `code` the HTTP status; `what` the host, the model id or the body. */
export const WORDS: Record<ErrorClass, { retry: boolean; say(who: string, code: number | undefined, what: string): string }> = {
  rate: { retry: true, say: (who) => `${who} is rate limiting (429); tried ${TRIES} times.` },
  server: { retry: true, say: (who, code) => `${who} had a server error (${code}).` },
  network: { retry: true, say: (_who, _code, what) => what },
  stall: { retry: false, say: (who) => `${who} stopped sending for ${STALL_MS / 1000} s.` },
  auth: { retry: false, say: (who, code, keyEnv) => `${who} refused the key (${code}). Check ${keyEnv} or Settings > Providers.` },
  notFound: { retry: false, say: (who, _code, model) => `${who} has no model ${model} (404).` },
  bad: { retry: false, say: (who, code, body) => `${who} refused the request (${code}): ${body}` },
  redirect: { retry: false, say: (who) => `${who} answered with a redirect to another address; Reins does not follow it with your key.` },
  consent: { retry: false, say: (_who, _code, what) => what },
};

/** The class of an HTTP status. */
export function classifyStatus(status: number): ErrorClass {
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notFound';
  // ponytail: a 400 "context too long" (compact, retry once, Task 16) and a 400 naming an unpaired tool id (sanitize, retry once, Task 14) are plain bad requests until then.
  return 'bad';
}

/** The class of a thrown error: a ProviderError by its status; the redirect and consent refusals by what send.ts makes of them; anything else is a network failure. */
export function classify(err: unknown): ErrorClass {
  if (err instanceof ConsentNeeded) return 'consent';
  if (err instanceof ProviderError) return classifyStatus(err.status);
  // send.ts rewrites a refused redirect to this one sentence.
  if (err instanceof Error && /answered with a redirect/.test(err.message)) return 'redirect';
  // ponytail: every other error (a refused address, a wire's own failure) counts as the network and is tried again; split them when a wire marks its errors.
  return 'network';
}

/** Retry-After as milliseconds (seconds or an HTTP date), at most 60 s; undefined when it is absent or unreadable. */
export function retryAfterMs(header: string | undefined, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const t = header.trim();
  const secs = /^\d+(\.\d+)?$/.test(t) ? Number(t) : (Date.parse(t) - now) / 1000;
  if (!Number.isFinite(secs)) return undefined;
  return Math.min(Math.max(secs, 0), MAX_RETRY_AFTER_S) * 1000;
}

/** The wait before try number `attempt + 1` (attempt counts from 1): Retry-After if given, else 1, 2, 4, 8 s plus up to a quarter more. */
export function retryDelay(attempt: number, header: string | undefined, random: () => number, now?: number): number {
  const given = retryAfterMs(header, now);
  if (given !== undefined) return given;
  const base = BACKOFF_S[Math.min(attempt, BACKOFF_S.length) - 1]! * 1000;
  return base + random() * base * 0.25;
}

/** A wait that an abort ends at once. Uses setTimeout, so fake timers drive it. */
export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
