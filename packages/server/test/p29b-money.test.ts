// Milestone P, Task 29 phase B, money and wire fixes: B1 (a reply with no usage is an unknown cost, never 0; a cut stream is no reply),
// B2 (a call that failed after the 200 began is an unknown cost), B6 (a reply is bounded in size and in time).
import { afterEach, describe, expect, it } from 'vitest';
import type { LoopDeps } from '../src/loop/engine.js';
import type { Wire, EngineHost } from '../src/mods/types.js';
import type { ModelRequest, WireEvent } from '../src/loop/types.js';
import type { ProviderManifest } from '../src/mods/types.js';
import type { FakeReply } from './fake-provider.js';
import { rig, WIRES, type Rig, type WireId } from './loop-harness.js';

const rigs: Rig[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const UNKNOWN_SPEND = 'Reins cannot tell what this session has spent, so Allow cannot raise the dollar limit. Start a new session or remove the limit.';
/** 1000 USD per million tokens: a call of 8 tokens costs 0.008. */
const TOKEN_PRICE = { input: 1000, output: 1000 };
const priced = { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: TOKEN_PRICE }] } };
const use = (wire: WireId, tokens: number) => (wire === 'openai-chat' ? { prompt_tokens: tokens, completion_tokens: 0 } : { input_tokens: tokens, output_tokens: 0 });
const text = (wire: WireId, tokens: number, t = 'done'): FakeReply => ({ text: t, usage: use(wire, tokens) });
const sent = (r: Rig) => r.fake.requests.length;
const NORMAL_COST = 0.015; // the fake's default usage: 10 in, 5 out, at 1000 USD per million

// ---- raw streams ---------------------------------------------------------------------------------------------------------------------------
const sse = (o: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const chat = (delta: object, finish: string | null = null) => sse({ choices: [{ index: 0, delta, finish_reason: finish }] });
const msg = (type: string, o: object = {}) => sse({ type, ...o }, type);
const block = (t: string) => msg('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + msg('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }) + msg('content_block_stop', { index: 0 });
const raw = (body: string): FakeReply => ({ body, headers: { 'content-type': 'text/event-stream' } });

/** A complete reply that carries no usage anywhere. */
const noUsage = (wire: WireId, t = 'hello'): FakeReply =>
  raw(wire === 'openai-chat'
    ? chat({ content: t }) + chat({}, 'stop') + 'data: [DONE]\n\n'
    : msg('message_start', { message: {} }) + block(t) + msg('message_delta', { delta: { stop_reason: 'end_turn' } }) + msg('message_stop'));
/** A stream that stops in the middle of the text: no finish, no end marker, no usage. */
const cutMidText = (wire: WireId, t = 'partial'): FakeReply =>
  raw(wire === 'openai-chat' ? chat({ content: t }) : msg('message_start', { message: {} }) + block(t));

const asText = (r: Rig) => JSON.stringify(r.fake.requests.at(-1)!.body.messages);

describe.each(WIRES)('B1: a reply with no usage is an unknown cost, never 0 (%s)', (wire) => {
  it('the cost and the total are unknown, and the next call under a USD limit is not sent', async () => {
    const r = await make(wire, priced);
    r.push(noUsage(wire), text(wire, 8));
    const s = await r.open({ usdRoom: () => 1 });
    const first = await s.turn('go');
    expect(first.text).toBe('hello');
    expect(first.isError).toBeUndefined();
    expect(first.cost).toBeUndefined();
    expect(first.total).toBeUndefined();
    const second = await s.turn('again');
    expect(second.budgetStop).toBe(true);
    expect(second.text).toBe(UNKNOWN_SPEND);
    expect(sent(r)).toBe(1);
  });

  it('a normal stream is unchanged: a known cost and the next call goes out', async () => {
    const r = await make(wire, priced);
    r.push({ text: 'hello' }, { text: 'again' });
    const s = await r.open({ usdRoom: () => 1 });
    const first = await s.turn('go');
    expect(first.cost).toBeCloseTo(NORMAL_COST, 12);
    expect(first.total).toBeCloseTo(NORMAL_COST, 12);
    expect((await s.turn('again')).text).toBe('again');
    expect(sent(r)).toBe(2);
  });

  it('a stream cut in the middle of the text is no reply: tried again, the partial text is not kept', async () => {
    const r = await make(wire, priced);
    r.push(cutMidText(wire), cutMidText(wire), cutMidText(wire), cutMidText(wire));
    const s = await r.open();
    await expect(s.turn('go')).rejects.toThrow('ended before it was complete');
    expect(sent(r)).toBe(4);
    r.push({ text: 'fresh', usage: use(wire, 8) });
    expect((await s.turn('again')).text).toBe('fresh');
    expect(asText(r)).not.toContain('partial');
  });

  it('a cut stream that is answered by a whole one on the retry gives the whole one', async () => {
    const r = await make(wire);
    r.push(cutMidText(wire), { text: 'whole' });
    const s = await r.open();
    expect((await s.turn('go')).text).toBe('whole');
    expect(r.slept).toHaveLength(1);
  });
});

describe('B1: openai-chat only', () => {
  it('streamOptions false: no stream_options is asked for, the cost is unknown, and a usage the server sends anyway is used', async () => {
    const r = await make('openai-chat', { manifest: { usage: { streamOptions: false }, models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: TOKEN_PRICE }] } });
    r.push({ text: 'hi' });
    const s = await r.open({ usdRoom: () => 1 });
    const first = await s.turn('go');
    expect(r.fake.requests[0]!.body.stream_options).toBeUndefined();
    expect(first.cost).toBeUndefined();
    expect(first.total).toBeUndefined();
    expect((await s.turn('again')).budgetStop).toBe(true);

    const r2 = await make('openai-chat', { manifest: { usage: { streamOptions: false }, models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: TOKEN_PRICE }] } });
    r2.push(raw(chat({ content: 'hi' }) + chat({}, 'stop') + sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 0 } }) + 'data: [DONE]\n\n'));
    const s2 = await r2.open({ usdRoom: () => 1 });
    expect((await s2.turn('go')).cost).toBeCloseTo(0.008, 12);
  });

  it('a stream cut after finish_reason but before the usage: the text is accepted, the cost is unknown', async () => {
    const r = await make('openai-chat', priced);
    r.push(raw(chat({ content: 'whole text' }) + chat({}, 'stop')));
    const s = await r.open({ usdRoom: () => 1 });
    const res = await s.turn('go');
    expect(res.text).toBe('whole text');
    expect(res.isError).toBeUndefined();
    expect(res.cost).toBeUndefined();
    expect(sent(r)).toBe(1);
  });

  it('a stream that ends with [DONE] and nothing else is complete (an unknown cost)', async () => {
    const r = await make('openai-chat', priced);
    r.push(raw(chat({ content: 'x' }) + 'data: [DONE]\n\n'));
    const s = await r.open({ usdRoom: () => 1 });
    const res = await s.turn('go');
    expect(res.text).toBe('x');
    expect(res.cost).toBeUndefined();
  });
});

describe.each(WIRES)('B2: a call that failed after the 200 began has an unknown cost (%s)', (wire) => {
  const dropped = (): FakeReply => ({ text: 'x'.repeat(500), dropAfter: 300, usage: use(wire, 8) });

  it('with a USD limit the drop makes the total unknown, so the retry is not sent', async () => {
    const r = await make(wire, priced);
    r.push(dropped(), text(wire, 8));
    const s = await r.open({ usdRoom: () => 1 });
    const res = await s.turn('go');
    expect(sent(r)).toBe(1);
    expect(res.budgetStop).toBe(true);
    expect(res.text).toBe(UNKNOWN_SPEND);
    expect(res.cost).toBeUndefined();
    expect(res.total).toBeUndefined();
  });

  it('with no limit the retry goes out, and its cost stays unknown', async () => {
    const r = await make(wire, priced);
    r.push(dropped(), text(wire, 8));
    const s = await r.open();
    const res = await s.turn('go');
    expect(sent(r)).toBe(2);
    expect(res.text).toBe('done');
    expect(res.cost).toBeUndefined();
    expect(res.total).toBeUndefined();
  });

  it('when every try dropped, the unknown spend is kept in the conversation: a reopened session under a limit sends nothing', async () => {
    const r = await make(wire, priced);
    r.push(dropped(), dropped(), dropped(), dropped());
    const s = await r.open();
    await expect(s.turn('go')).rejects.toThrow();
    expect(sent(r)).toBe(4);
    const id = s.sessionId;
    await s.close();
    r.push(text(wire, 8));
    const again = await r.open({ sessionId: id, costBase: 0, usdRoom: () => 1 });
    const res = await again.turn('go on');
    expect(res.budgetStop).toBe(true);
    expect(sent(r)).toBe(4);
  });

  it('a 500 before any body stays a known zero: the retry goes out under a limit and the cost is the retry only', async () => {
    const r = await make(wire, priced);
    r.push({ status: 500, body: 'oops' }, text(wire, 8));
    const s = await r.open({ usdRoom: () => 1 });
    const res = await s.turn('go');
    expect(sent(r)).toBe(2);
    expect(res.cost).toBeCloseTo(0.008, 12);
    expect(res.total).toBeCloseTo(0.008, 12);
  });

  it('a 400 before any body stays a known zero: the total is still known on the next call', async () => {
    const r = await make(wire, priced);
    r.push({ status: 400, body: '{"error":{"message":"no"}}' }, text(wire, 8));
    const s = await r.open({ usdRoom: () => 1 });
    await expect(s.turn('go')).rejects.toThrow();
    const res = await s.turn('again');
    expect(res.cost).toBeCloseTo(0.008, 12);
    expect(res.total).toBeCloseTo(0.008, 12);
  });

  it('a refused connection stays a known zero: every try is made under a limit', async () => {
    const r = await make(wire, { manifest: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: TOKEN_PRICE }] } });
    const s = await r.open({ usdRoom: () => 1 });
    await expect(s.turn('go')).rejects.toThrow();
    expect(r.slept).toHaveLength(3);
  });
});

// ---- B6 --------------------------------------------------------------------------------------------------------------------------------------
const CUT_BIG = 'The reply was longer than Reins accepts and was cut off.';
const CUT_SLOW = 'The reply took longer than Reins waits and was cut off.';
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const customWire = (call: (h: EngineHost, signal: AbortSignal) => AsyncGenerator<WireEvent>): Wire => ({
  call: (_req: ModelRequest, _p: ProviderManifest, h: EngineHost, signal: AbortSignal) => call(h, signal),
});
const tick = () => new Promise<void>((ok) => setImmediate(ok));

describe('B6: a reply is bounded in size and in time', () => {
  const limits = (replyBytes: number, callMs: number): LoopDeps => ({ limits: { replyBytes, callMs } });

  it('an endless text stream is cut at the byte cap: an error result, an unknown cost, the partial is not kept', async () => {
    let yielded = 0;
    // Bounded at 5000 chunks so a loop with no cap ends by itself instead of running for ever.
    const wire = customWire(async function* (_h, signal) {
      for (let i = 0; i < 5000 && !signal.aborted; i++) {
        yielded++;
        yield { type: 'text', text: 'x'.repeat(100) };
        await tick();
      }
      yield { type: 'usage', usage: zero };
      yield { type: 'done' };
    });
    const r = await make('openai-chat', { wire, deps: limits(1000, 60_000), ...priced });
    const s = await r.open({ usdRoom: () => 1 });
    const res = await s.turn('go');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(CUT_BIG);
    expect(res.cost).toBeUndefined();
    expect(res.total).toBeUndefined();
    expect(yielded).toBeLessThan(50);
  });

  it('an endless comment stream is cut by the elapsed-time cap although it keeps the stall timer alive', async () => {
    const wire = customWire(async function* (h, signal) {
      for (let i = 0; i < 100 && !signal.aborted; i++) {
        h.heartbeat?.();
        await new Promise<void>((ok) => setTimeout(ok, 20));
      }
      yield { type: 'usage', usage: zero };
      yield { type: 'done' };
    });
    const r = await make('openai-chat', { wire, deps: limits(1_000_000, 300), ...priced });
    const s = await r.open({ usdRoom: () => 1 });
    const t0 = Date.now();
    const res = await s.turn('go');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.isError).toBe(true);
    expect(res.text).toBe(CUT_SLOW);
    expect(res.cost).toBeUndefined();
  });

  it.each(WIRES)('a real %s stream over the cap is cut off the same way, and the next request holds the notice and not the partial', async (wire) => {
    const r = await make(wire, { deps: limits(100, 60_000) });
    r.push({ text: 'P'.repeat(5000), usage: use(wire, 8) }, { text: 'after', usage: use(wire, 8) });
    const s = await r.open();
    const res = await s.turn('go');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(CUT_BIG);
    const second = await s.turn('again');
    expect(second.text).toBe('after');
    const body = asText(r);
    expect(body).toContain(CUT_BIG);
    expect(body).not.toContain('PPPPP');
  });

  it('a reply under both caps is untouched', async () => {
    const r = await make('openai-chat', { deps: limits(1000, 60_000) });
    r.push({ text: 'short' });
    const s = await r.open();
    expect((await s.turn('go')).text).toBe('short');
  });
});
