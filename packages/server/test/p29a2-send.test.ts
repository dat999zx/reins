// Milestone P, Task 29 phase A, fix round: the last consent check before the request is synchronous and never reuses an earlier answer (3), and the
// refusal marker is a WeakSet (11).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConsentNeeded, isSendRefusal, makeSend } from '../src/send.js';

const p = { id: 'neutral', kind: 'provider', label: 'Neutral', baseUrl: 'https://example.invalid', auth: { style: 'none', keyEnv: [] } };
const plain = { redact: (s: string) => s, has: () => false, safeLength: (s: string) => s.length };
const go = (o: Partial<Parameters<typeof makeSend>[0]>) => {
  let fetched = 0;
  const send = makeSend({ secrets: () => new Map(), env: {}, current: () => p as never, redactor: plain, consent: () => true, fetch: async () => { fetched++; return new Response('{}'); }, ...o });
  return { fetched: () => fetched, run: () => send(p as never, `${p.baseUrl}/chat`, { method: 'POST', body: 'fake prompt' }).then(() => undefined, (e: unknown) => e) };
};

describe('fix 3: the final consent check is synchronous', () => {
  it('an asynchronous callback that answers true, then false, sends no request when the synchronous check says no', async () => {
    let asks = 0;
    const x = go({ consent: () => (++asks === 1 ? Promise.resolve(true) : Promise.resolve(false)), consentNow: () => false });
    expect(await x.run()).toBeInstanceOf(ConsentNeeded);
    expect(x.fetched()).toBe(0);
  });

  it('an asynchronous callback with no synchronous check is not consent: no request', async () => {
    const x = go({ consent: () => Promise.resolve(true) });
    expect(await x.run()).toBeInstanceOf(ConsentNeeded);
    expect(x.fetched()).toBe(0);
  });

  it('a synchronous check that answers with a promise is not consent either', async () => {
    const x = go({ consent: () => true, consentNow: (() => Promise.resolve(true)) as never });
    expect(await x.run()).toBeInstanceOf(ConsentNeeded);
    expect(x.fetched()).toBe(0);
  });

  it('a synchronous check that revokes after an earlier true answer stops the request (the earlier answer is not reused)', async () => {
    const x = go({ consent: () => true, consentNow: () => false });
    expect(await x.run()).toBeInstanceOf(ConsentNeeded);
    expect(x.fetched()).toBe(0);
  });

  it('with both answering true the request goes out; a plain synchronous callback alone still works', async () => {
    const both = go({ consent: () => Promise.resolve(true), consentNow: () => true });
    expect(await both.run()).toBeUndefined();
    expect(both.fetched()).toBe(1);
    const alone = go({ consent: () => true });
    expect(await alone.run()).toBeUndefined();
    expect(alone.fetched()).toBe(1);
  });
});

describe('fix 11: a refusal is remembered without keeping the error alive', () => {
  it('a refusal error is recognised after many other errors, and a look-alike is not', async () => {
    const keyed = { ...p, auth: { style: 'bearer', keyEnv: ['X_API_KEY'] } };
    const send = makeSend({ secrets: () => new Map(), env: {}, current: () => keyed as never, redactor: plain, consent: () => true });
    const first = await send(keyed as never, `${keyed.baseUrl}/chat`, { method: 'POST' }).then(() => undefined, (e: unknown) => e);
    expect(isSendRefusal(first)).toBe(true);
    for (let i = 0; i < 5000; i++) await send(keyed as never, `${keyed.baseUrl}/chat`, { method: 'POST' }).catch(() => {});
    expect(isSendRefusal(first)).toBe(true);
    expect(isSendRefusal(new Error((first as Error).message))).toBe(false);
  });

  it('the marker set is a WeakSet (what can be tested: its type; a Set would hold every refusal for the life of the process)', () => {
    const source = fs.readFileSync(new URL('../src/send.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const refusals = new WeakSet<object>\(\)/);
    expect(source).not.toMatch(/new Set<object>/);
  });
});
