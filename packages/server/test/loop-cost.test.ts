import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callCost, priceOf } from '../src/loop/cost.js';
import { COST_120, PRICE, USAGE_120, rig, toolReply, type Rig } from './loop-harness.js';

const rigs: Rig[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const call = { usage: USAGE_120['openai-chat'] };

describe('per-turn cost is the total minus the base (6.1)', () => {
  it('a turn that rejected after one paid call: its spend is counted once, in the next turn', async () => {
    const r = await make('openai-chat');
    r.push({ ...toolReply(0), ...call }, ...Array.from({ length: 4 }, () => ({ status: 500, body: 'boom' })), { text: 'ok', ...call });
    const s = await r.open();
    await expect(s.turn('go')).rejects.toThrow('server error');
    const res = await s.turn('again');
    expect(res.cost).toBeCloseTo(2 * COST_120, 12);
    expect(res.total).toBeCloseTo(2 * COST_120, 12);
    expect(res.models!.m).toBeCloseTo(2 * COST_120, 12);
    r.push({ text: 'more', ...call });
    expect((await s.turn('third')).cost).toBeCloseTo(COST_120, 12);
  });

  it('a session opened with costBase continues from it', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'ok', ...call });
    const res = await (await r.open({ costBase: 5, costBaseByModel: { m: 5 } })).turn('hi');
    expect(res.cost).toBeCloseTo(COST_120, 12);
    expect(res.total).toBeCloseTo(5 + COST_120, 12);
    expect(res.totals!.m).toBeCloseTo(5 + COST_120, 12);
    expect(res.models!.m).toBeCloseTo(COST_120, 12);
  });

  it('a resumed session whose total was not kept has no cost', async () => {
    const r = await make('openai-chat');
    // A file with a reply and no usage line: what the money was is not known.
    const id = randomUUID();
    fs.mkdirSync(path.join(r.host.home, 'conversations'));
    fs.writeFileSync(path.join(r.host.home, 'conversations', `${id}.jsonl`), [
      { t: 'msg', role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { t: 'msg', role: 'assistant', protocol: 'openai-chat', blocks: [{ type: 'text', text: 'a' }] },
    ].map((l) => `${JSON.stringify(l)}\n`).join(''));
    r.push({ text: 'ok', ...call });
    const res = await (await r.open({ sessionId: id })).turn('hi');
    expect(res.cost).toBeUndefined();
    expect(res.total).toBeUndefined();
  });
});

describe('unknown is not zero (6.2)', () => {
  it('an unpriced call: cost and total undefined, now and on later turns', async () => {
    const r = await make('openai-chat', { manifest: { models: [{ id: 'm', context: 1000 }] } });
    r.push({ text: 'a', ...call }, { text: 'b', ...call });
    const s = await r.open();
    for (const text of ['one', 'two']) {
      const res = await s.turn(text);
      expect(res.cost).toBeUndefined();
      expect(res.total).toBeUndefined();
      expect(res.models).toBeUndefined();
      expect(res.totals).toBeUndefined();
      expect(res.events!.at(-1)).toMatchObject({ type: 'usage', used: 120 });
    }
  });

  it('a provider default price of 0 / 0 gives cost 0', async () => {
    const r = await make('openai-chat', { manifest: { models: [{ id: 'm' }], price: { input: 0, output: 0 } } });
    r.push({ text: 'a', ...call });
    const res = await (await r.open()).turn('one');
    expect(res.cost).toBe(0);
    expect(res.total).toBe(0);
  });

  it('the model\'s price beats the provider\'s; cache prices fall back to the input price', async () => {
    const r = await make('openai-chat', { manifest: { price: { input: 100, output: 100 }, models: [{ id: 'm', price: { input: 1, output: 2 } }] } });
    r.push({ text: 'a', ...call });
    const res = await (await r.open()).turn('one');
    expect(res.cost).toBeCloseTo((60 * 1 + 20 * 2 + 30 * 1 + 10 * 1) / 1e6, 12);
  });
});

describe('priceOf and callCost', () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 0 };
  const p = (over: object = {}) => ({ models: [{ id: 'm' }], ...over }) as never;
  it('model, then the catalog seam, then the provider, then unknown', () => {
    const cat = { catalogPrice: () => ({ input: 7, output: 8 }) };
    expect(priceOf(p({ models: [{ id: 'm', price: PRICE }] }), cat, 'm')).toEqual(PRICE);
    expect(priceOf(p({ price: { input: 1, output: 1 } }), cat, 'm')).toEqual({ input: 7, output: 8 });
    expect(priceOf(p({ price: { input: 1, output: 1 } }), {}, 'm')).toEqual({ input: 1, output: 1 });
    expect(priceOf(p(), {}, 'm')).toBeUndefined();
    // a model price with no output is the CLI's table, not a price for this loop
    expect(priceOf(p({ models: [{ id: 'm', price: { input: 3 } }] }), {}, 'm')).toBeUndefined();
  });
  it('adds the four parts, unrounded', () => {
    expect(callCost(PRICE, usage)).toBeCloseTo(1 + 2 + 0.5 + 1.25, 12);
    expect(callCost({ input: 2, output: 3 }, usage)).toBeCloseTo(2 + 3 + 2 + 2, 12);
  });
});
