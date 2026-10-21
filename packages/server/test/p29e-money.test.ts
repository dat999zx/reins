// Milestone P, Task 29 phase E3, E4, E6: a failed compaction is counted once, a priced call keeps its subtotal next to an unknown one, and the
// survivors the last review predicted (unknown spend on a failed compaction, an `alone` charge covering a reply that has none).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loopEngine } from '../src/loop/engine.js';
import { openConversation } from '../src/loop/store.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import type { FakeReply } from './fake-provider.js';
import { rig, toolReply, WIRES, type Rig, type WireId } from './loop-harness.js';

const rigs: Rig[] = [];
const dirs: string[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29e-money-'))); dirs.push(d); return d; };
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 1000 USD per million tokens: a call of 20 tokens costs 0.02. */
const PRICE = { input: 1000, output: 1000 };
const priced = (context = 1_000_000) => ({ manifest: { models: [{ id: 'm', context, maxOutput: 100, price: PRICE }] } });
const twenty = (wire: WireId) => (wire === 'openai-chat' ? { prompt_tokens: 10, completion_tokens: 10 } : { input_tokens: 10, output_tokens: 10 });
const para = (tag: string) => `${tag} ${'x'.repeat(5990)}`;

const sse = (o: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const chat = (delta: object, finish: string | null = null) => sse({ choices: [{ index: 0, delta, finish_reason: finish }] });
const msg = (type: string, o: object = {}) => sse({ type, ...o }, type);
const block = (t: string) => msg('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + msg('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }) + msg('content_block_stop', { index: 0 });
const raw = (body: string): FakeReply => ({ body, headers: { 'content-type': 'text/event-stream' } });
/** A complete reply whose usage object is `{}`: its cost is unknown. */
const emptyUsage = (wire: WireId): FakeReply =>
  raw(wire === 'openai-chat'
    ? chat({ content: 'hi' }) + chat({}, 'stop') + sse({ choices: [], usage: {} }) + 'data: [DONE]\n\n'
    : msg('message_start', { message: { usage: {} } }) + block('hi') + msg('message_delta', { delta: { stop_reason: 'end_turn' }, usage: {} }) + msg('message_stop'));
/** A stream that stops in the middle of the text: the 200 began, nothing finished. */
const cut = (wire: WireId): FakeReply => raw(wire === 'openai-chat' ? chat({ content: 'partial' }) : msg('message_start', { message: {} }) + block('partial'));

describe.each(WIRES)('E3: a failed manual compaction is counted once (%s)', (wire) => {
  it('two replies, two empty summaries, another reply, all $0.02: each paid call is one charge, and the sum is the conversation total', async () => {
    const r = await make(wire, priced(8000));
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: tmp(), engine: 'p' });
    const s = openSession({
      store, dir: r.host.home,
      makeEngine: ({ onApprove, onLive }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0 }),
    }, row, true);
    try {
      r.push({ text: para('A1'), usage: twenty(wire) }, { text: para('A2'), usage: twenty(wire) });
      s.message(para('Q1'));
      await s.idle();
      s.message(para('Q2'));
      await s.idle();
      for (let i = 0; i < 2; i++) {
        r.push({ text: '   ', usage: twenty(wire) });
        expect(s.compress()).toEqual({ ok: true });
        await s.idle();
      }
      r.push({ text: para('A3'), usage: twenty(wire) });
      s.message(para('Q3'));
      await s.idle();
      const costs = store.readLog('s1').filter((x) => x.type === 'turn_ended').map((x) => (x.data as { cost?: number }).cost ?? 0);
      expect(costs).toHaveLength(5);
      for (const c of costs) expect(c).toBeCloseTo(0.02, 12);
      expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.1, 12);
      const kept = store.getSession('s1')!.engineSessionId!;
      expect(openConversation(r.host.home, kept).load(wire).total).toBeCloseTo(0.1, 12);
    } finally {
      await s.shutdown();
      store.close();
    }
  });
});

describe.each(WIRES)('E4: an unknown call keeps the subtotal of the priced calls before it in the same turn (%s)', (wire) => {
  it('a $0.02 tool reply, then a reply of unknown cost: unknownCost, cost 0.02 and the model split', async () => {
    const r = await make(wire, priced());
    r.push({ ...toolReply(0), usage: twenty(wire) }, emptyUsage(wire));
    const s = await r.open();
    const res = await s.turn('go');
    expect(res.unknownCost).toBe(true);
    expect(res.cost).toBeCloseTo(0.02, 12);
    expect(res.models?.m).toBeCloseTo(0.02, 12);
    expect(res.total).toBeUndefined();
  });

  it('the subtotal is given once: the next turn (priced, but the total stays unknown) does not repeat it', async () => {
    const r = await make(wire, priced());
    r.push({ ...toolReply(0), usage: twenty(wire) }, emptyUsage(wire), { text: 'again', usage: twenty(wire) });
    const s = await r.open();
    await s.turn('go');
    const next = await s.turn('more');
    expect(next.unknownCost).toBe(true);
    expect(next.cost).toBeUndefined();
  });
});

describe.each(WIRES)('E6: unknown spend of a failed manual compaction (%s)', (wire) => {
  it('four cut 200 streams in a compaction: the rejection carries an unknown cost', async () => {
    const r = await make(wire, priced(8000));
    const s = await r.open();
    r.push({ text: para('A1'), usage: twenty(wire) }, { text: para('A2'), usage: twenty(wire) });
    await s.turn(para('Q1'));
    await s.turn(para('Q2'));
    r.push(cut(wire), cut(wire), cut(wire), cut(wire));
    const e = await s.compact!().then(() => undefined, (x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as { paid?: unknown }).paid).toEqual({ unknownCost: true });
  });
});

describe('E6: an `alone` charge does not cover a reply that has no usage', () => {
  it('one reply with no usage inside and one usage line of its own: the total is unknown', () => {
    const home = tmp();
    const c = openConversation(home, 'conv-e6-alone');
    c.lock();
    try {
      c.appendMsg({ role: 'user', blocks: [{ type: 'text', text: 'q' }] }, 'p');
      c.appendMsg({ role: 'assistant', blocks: [{ type: 'text', text: 'a' }] }, 'p');
      c.appendSpend({ model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
      expect(c.load('p').total).toBeUndefined();
    } finally {
      c.release();
    }
  });
});
