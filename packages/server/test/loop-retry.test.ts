import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify, classifyStatus, retryAfterMs, retryDelay, sleep } from '../src/loop/retry.js';
import type { Usage, WireEvent } from '../src/loop/types.js';
import type { EngineHost, Wire } from '../src/mods/types.js';
import { ConsentNeeded, ProviderError } from '../src/send.js';
import { KEY, WIRES, rig, type Rig } from './loop-harness.js';

const rigs: Rig[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  vi.useRealTimers();
  for (const r of rigs.splice(0)) await r.cleanup();
});
const fail = (status: number, body = 'boom', headers?: Record<string, string>) => ({ status, body, ...(headers ? { headers } : {}) });

describe('the table as data', () => {
  it('classifies statuses', () => {
    expect(classifyStatus(429)).toBe('rate');
    for (const s of [500, 502, 503, 504, 529]) expect(classifyStatus(s)).toBe('server');
    for (const s of [401, 403]) expect(classifyStatus(s)).toBe('auth');
    expect(classifyStatus(404)).toBe('notFound');
    for (const s of [400, 408, 413, 422]) expect(classifyStatus(s)).toBe('bad');
  });
  it('classifies errors', () => {
    expect(classify(new ProviderError('x', 503))).toBe('server');
    expect(classify(new ConsentNeeded('p', 'http://x'))).toBe('consent');
    expect(classify(new Error('The provider answered with a redirect, which Reins does not follow.'))).toBe('redirect');
    expect(classify(new TypeError('fetch failed'))).toBe('network');
  });
  it('Retry-After is seconds or a date, at most 60 s; else 1, 2, 4, 8 s plus jitter', () => {
    expect(retryAfterMs('1')).toBe(1000);
    expect(retryAfterMs('120')).toBe(60_000);
    expect(retryAfterMs('soon')).toBeUndefined();
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:20:00 GMT', now)).toBe(0);
    expect([1, 2, 3, 4, 5].map((n) => retryDelay(n, undefined, () => 0))).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(retryDelay(1, undefined, () => 1)).toBe(1250);
    expect(retryDelay(1, '3', () => 1)).toBe(3000);
  });
});

describe.each(WIRES)('retries on %s', (wireId) => {
  it('429 with Retry-After: 1 waits 1 s and succeeds', async () => {
    const r = await make(wireId);
    r.push(fail(429, 'slow down', { 'retry-after': '1' }), { text: 'ok' });
    expect((await (await r.open()).turn('hi')).text).toBe('ok');
    expect(r.slept).toEqual([1000]);
    expect(r.fake.requests).toHaveLength(2);
  });

  it('Retry-After: 120 is cut to 60 s', async () => {
    const r = await make(wireId);
    r.push(fail(429, 'slow down', { 'retry-after': '120' }), { text: 'ok' });
    await (await r.open()).turn('hi');
    expect(r.slept).toEqual([60_000]);
  });

  it('three 500s then success: 1, 2, 4 s', async () => {
    const r = await make(wireId);
    r.push(fail(500), fail(502), fail(503), { text: 'ok' });
    expect((await (await r.open()).turn('hi')).text).toBe('ok');
    expect(r.slept).toEqual([1000, 2000, 4000]);
    expect(r.fake.requests).toHaveLength(4);
  });

  it('five 500s: four tries, then the table\'s words', async () => {
    const r = await make(wireId);
    r.push(...Array.from({ length: 5 }, () => fail(500)));
    await expect((await r.open()).turn('hi')).rejects.toThrow(/^Fake had a server error \(500\)\.$/);
    expect(r.fake.requests).toHaveLength(4);
    expect(r.slept).toHaveLength(3);
  });

  it('four 429s: "tried 4 times"', async () => {
    const r = await make(wireId);
    r.push(...Array.from({ length: 4 }, () => fail(429)));
    await expect((await r.open()).turn('hi')).rejects.toThrow('Fake is rate limiting (429); tried 4 times.');
    expect(r.fake.requests).toHaveLength(4);
  });

  it('a mid-stream drop is redone whole: no doubled text in the events or the history', async () => {
    const r = await make(wireId);
    r.push({ text: 'partial text that must vanish', dropAfter: 520 }, { text: 'full' });
    const s = await r.open();
    const res = await s.turn('hi');
    expect(res.text).toBe('full');
    expect(res.events!.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'full' }]);
    expect(r.fake.requests).toHaveLength(2);
    r.push({ text: 'next' });
    await s.turn('more');
    expect(JSON.stringify(r.fake.requests[2]!.body)).not.toContain('must vanish');
    expect(r.slept).toEqual([1000]);
  });

  it('no server at all: "Cannot reach <host>", four tries', async () => {
    const r = await make(wireId, { manifest: { baseUrl: 'http://127.0.0.1:1/v1' } });
    await expect((await r.open()).turn('hi')).rejects.toThrow(/^Cannot reach 127\.0\.0\.1:1: .+\.$/);
    expect(r.slept).toHaveLength(3);
  });
});

describe('no retry (4.9)', () => {
  it.each([
    [401, 'Fake refused the key (401). Check P_API_KEY or Settings > Providers.'],
    [403, 'Fake refused the key (403). Check P_API_KEY or Settings > Providers.'],
    [404, 'Fake has no model m (404).'],
  ])('%i: one request and the exact words', async (status, words) => {
    const r = await make('openai-chat');
    r.push(fail(status, `no. ${KEY}`), { text: 'unused' });
    await expect((await r.open()).turn('hi')).rejects.toThrow(new RegExp(`^${words.replace(/[().]/g, '\\$&')}$`));
    expect(r.fake.requests).toHaveLength(1);
    expect(r.slept).toEqual([]);
  });

  it('another 4xx: the body, redacted and cut to 500 characters', async () => {
    const r = await make('openai-chat');
    r.push(fail(400, `${'e '.repeat(100)}${KEY}${' tail'.repeat(300)}`), { text: 'unused' });
    const err = await (await r.open()).turn('hi').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg.startsWith('Fake refused the request (400): ')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual('Fake refused the request (400): '.length + 500);
    expect(msg).not.toContain(KEY);
    expect(r.fake.requests).toHaveLength(1);
  });

  it('a redirect: the words, one request', async () => {
    const r = await make('openai-chat');
    r.push({ redirectTo: 'http://other.example/x' }, { text: 'unused' });
    await expect((await r.open()).turn('hi')).rejects.toThrow('Fake answered with a redirect to another address; Reins does not follow it with your key.');
    expect(r.fake.requests).toHaveLength(1);
  });
});

// A wire with no network, so fake timers can drive the 120 s watchdog and the real sleep.
const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
async function* reply(): AsyncGenerator<WireEvent> {
  yield { type: 'text', text: 'ok' };
  yield { type: 'usage', usage };
  yield { type: 'done' };
}
type Attempt = (h: EngineHost, signal: AbortSignal) => AsyncGenerator<WireEvent>;
const hang: Attempt = async function* (_h, signal) {
  await new Promise<void>((ok) => signal.addEventListener('abort', () => ok(), { once: true })); // the real wires end quietly on an abort
  yield* [];
};
function scripted(...attempts: Attempt[]): { wire: Wire; calls: () => number } {
  let n = 0;
  return { wire: { call: (_r, _p, h, signal) => attempts[Math.min(n++, attempts.length - 1)]!(h, signal) }, calls: () => n };
}

describe('timers', () => {
  it('Retry-After: 120 waits 60 s, not 120', async () => {
    const w = scripted(async function* () { yield* []; throw new ProviderError('Fake answered 429', 429, '120'); }, reply);
    const r = await make('openai-chat', { wire: w.wire, deps: { sleep } });
    const s = await r.open();
    vi.useFakeTimers();
    const t = s.turn('hi');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(w.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await t).text).toBe('ok');
    expect(w.calls()).toBe(2);
  });

  it('no byte for 120 s aborts the call and tries once more', async () => {
    const w = scripted(hang, reply);
    const r = await make('openai-chat', { wire: w.wire, deps: { sleep } });
    const s = await r.open();
    vi.useFakeTimers();
    const t = s.turn('hi');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(w.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await t).text).toBe('ok');
    expect(w.calls()).toBe(2);
  });

  it('a second stall is final', async () => {
    const w = scripted(hang);
    const r = await make('openai-chat', { wire: w.wire, deps: { sleep } });
    const s = await r.open();
    vi.useFakeTimers();
    const t = expect(s.turn('hi')).rejects.toThrow('Fake stopped sending for 120 s.');
    await vi.advanceTimersByTimeAsync(240_000);
    await t;
    expect(w.calls()).toBe(2);
  });

  it('a stream that keeps sending chunks never stalls, even with no events for minutes', async () => {
    const beats: Attempt = async function* (h) {
      for (let i = 0; i < 5; i++) {
        await new Promise((ok) => setTimeout(ok, 60_000));
        h.heartbeat?.();
      }
      yield* reply();
    };
    const w = scripted(beats);
    const r = await make('openai-chat', { wire: w.wire, deps: { sleep } });
    const s = await r.open();
    vi.useFakeTimers();
    const t = s.turn('hi');
    await vi.advanceTimersByTimeAsync(300_000);
    expect((await t).text).toBe('ok');
    expect(w.calls()).toBe(1);
  });

  it('both real wires beat the loop\'s heartbeat on every chunk', async () => {
    for (const wireId of WIRES) {
      const r = await make(wireId);
      let beats = 0;
      r.host.heartbeat = () => void beats++;
      r.push({ text: 'ok', split: 3 });
      await (await r.open()).turn('hi');
      expect(beats).toBeGreaterThan(0);
    }
  });
});
