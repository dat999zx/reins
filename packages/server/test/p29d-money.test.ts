// Milestone P, Task 29 phase D2, D4 (a to c), D5, D6: unknown spend through the wires, the loop, the session and the receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { receipt, type EngineEvent } from '@reins/core';
import { loopEngine } from '../src/loop/engine.js';
import { openConversation } from '../src/loop/store.js';
import { openSession, type MakeEngine } from '../src/session.js';
import { contextSize, switchCheck } from '../src/settings.js';
import { openStore, type Store } from '../src/store.js';
import type { FakeReply } from './fake-provider.js';
import { rig, WIRES, type Rig, type WireId } from './loop-harness.js';
import { testEngine } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const rigs: Rig[] = [];
const dirs: string[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29d-money-'))); dirs.push(d); return d; };
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
async function until(f: () => boolean) {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

/** 1000 USD per million tokens: a call of 20 tokens costs 0.02. */
const PRICE = { input: 1000, output: 1000 };
const priced = (context = 1_000_000) => ({ manifest: { models: [{ id: 'm', context, maxOutput: 100, price: PRICE }] } });
const use = (wire: WireId, input: number, output: number) => (wire === 'openai-chat' ? { prompt_tokens: input, completion_tokens: output } : { input_tokens: input, output_tokens: output });
const twenty = (wire: WireId) => use(wire, 10, 10);
const sent = (r: Rig) => r.fake.requests.length;
const para = (tag: string) => `${tag} ${'x'.repeat(5990)}`;

// ---- raw streams -------------------------------------------------------------------------------------------------------------------------
const sse = (o: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const chat = (delta: object, finish: string | null = null) => sse({ choices: [{ index: 0, delta, finish_reason: finish }] });
const msg = (type: string, o: object = {}) => sse({ type, ...o }, type);
const block = (t: string) => msg('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + msg('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }) + msg('content_block_stop', { index: 0 });
const raw = (body: string): FakeReply => ({ body, headers: { 'content-type': 'text/event-stream' } });
/** A complete reply whose usage object is `{}`. */
const emptyUsage = (wire: WireId): FakeReply =>
  raw(wire === 'openai-chat'
    ? chat({ content: 'hi' }) + chat({}, 'stop') + sse({ choices: [], usage: {} }) + 'data: [DONE]\n\n'
    : msg('message_start', { message: { usage: {} } }) + block('hi') + msg('message_delta', { delta: { stop_reason: 'end_turn' }, usage: {} }) + msg('message_stop'));
/** A stream that stops in the middle of the text: the 200 began, nothing finished. */
const cut = (wire: WireId): FakeReply => raw(wire === 'openai-chat' ? chat({ content: 'partial' }) : msg('message_start', { message: {} }) + block('partial'));

describe.each(WIRES)('D2: an empty usage object is not accounting (%s)', (wire) => {
  it('the cost and the total are unknown, and a second call under a USD limit is not sent', async () => {
    const r = await make(wire, priced());
    r.push(emptyUsage(wire), { text: 'second', usage: twenty(wire) });
    const s = await r.open({ usdRoom: () => 0.01 });
    const first = await s.turn('go');
    expect(first.text).toBe('hi');
    expect(first.cost).toBeUndefined();
    expect(first.total).toBeUndefined();
    expect(first.unknownCost).toBe(true);
    const second = await s.turn('again');
    expect(second.budgetStop).toBe(true);
    expect(sent(r)).toBe(1);
  });
});

describe.each(WIRES)('D4 (a): a failed call hands its unknown spend to the Run on the error (%s)', (wire) => {
  it('four cut 200 streams: the rejection carries `paid` with an unknown cost', async () => {
    const r = await make(wire, priced());
    r.push(cut(wire), cut(wire), cut(wire), cut(wire));
    const s = await r.open();
    const e = await s.turn('go').then(() => undefined, (x: Error) => x);
    expect(e?.message).toContain('ended before it was complete');
    expect((e as { paid?: unknown }).paid).toEqual({ unknownCost: true });
  });

  it('a failure before any 200 (nothing was billed) carries nothing', async () => {
    const r = await make(wire, priced());
    r.push({ status: 401, text: 'no' });
    const s = await r.open();
    const e = await s.turn('go').then(() => undefined, (x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as { paid?: unknown }).paid).toBeUndefined();
  });
});

describe.each(WIRES)('D4 (c): a reply with no usage has no context size (%s)', (wire) => {
  it('the usage event names the model and leaves `used` out, never 0; the switch asks', async () => {
    const r = await make(wire, priced());
    r.push(emptyUsage(wire));
    const s = await r.open();
    const res = await s.turn('go');
    const ev = (res.events ?? []).find((e: EngineEvent) => e.type === 'usage');
    expect(ev).toBeDefined();
    expect(ev).not.toHaveProperty('used');
    const rows = [{ seq: 1, type: 'engine', data: ev } as never];
    expect(contextSize(rows)).toBeUndefined();
    const check = switchCheck({ busy: false, detached: false, hasSession: true, used: contextSize(rows), target: 'other', limits: { tokens: 100_000, usd: 1 } });
    expect(check).toHaveProperty('ask');
  });

  it('a known usage still gives its size', async () => {
    const r = await make(wire, priced());
    r.push({ text: 'ok', usage: use(wire, 30, 5) });
    const s = await r.open();
    const res = await s.turn('go');
    expect((res.events ?? []).find((e: EngineEvent) => e.type === 'usage')).toMatchObject({ used: 35 });
  });
});

describe.each(WIRES)('D6: the usage of a billed empty summary is on disk before the text is judged (%s)', (wire) => {
  it('three calls of $0.02 leave $0.06 in the file, and the error carries the last $0.02', async () => {
    const r = await make(wire, priced(8000));
    const cwd = tmp();
    const s = await r.open({ cwd });
    r.push({ text: para('A1'), usage: twenty(wire) }, { text: para('A2'), usage: twenty(wire) });
    await s.turn(para('Q1'));
    await s.turn(para('Q2'));
    r.push({ text: '   ', usage: twenty(wire) });
    const e = await s.compact!().then(() => undefined, (x: Error) => x);
    expect(e?.message).toContain('empty summary');
    expect((e as { paid?: { cost?: number } }).paid?.cost).toBeCloseTo(0.02, 12);
    await s.close();
    const loaded = openConversation(r.host.home, s.sessionId).load(wire);
    expect(loaded.total).toBeCloseTo(0.06, 12);
  });
});

// ---- through the session -----------------------------------------------------------------------------------------------------------------
describe.each(WIRES)('D5: a session keeps the id of a conversation whose first call failed (%s)', (wire) => {
  it('four failed 200 streams, then a fifth message: it opens the same conversation and reads its unknown spend', async () => {
    const r = await make(wire, priced());
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: tmp(), engine: 'p' });
    const s = openSession({
      store, dir: r.host.home,
      makeEngine: ({ onApprove, onLive }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0 }),
    }, row, true);
    try {
      r.push(cut(wire), cut(wire), cut(wire), cut(wire));
      s.message('one');
      await s.idle();
      expect(store.readLog('s1').some((x) => x.type === 'turn_failed')).toBe(true);
      const kept = store.getSession('s1')!.engineSessionId;
      expect(kept).toBeTruthy();
      expect(fs.existsSync(path.join(r.host.home, 'conversations', `${kept}.jsonl`))).toBe(true);

      r.push({ text: 'fine', usage: twenty(wire) });
      s.message('two');
      await s.idle();
      expect(store.getSession('s1')!.engineSessionId).toBe(kept);
      const lines = fs.readFileSync(path.join(r.host.home, 'conversations', `${kept}.jsonl`), 'utf8');
      expect(lines).toContain('fine');
      expect(fs.readdirSync(path.join(r.host.home, 'conversations')).filter((f) => f.endsWith('.jsonl'))).toEqual([`${kept}.jsonl`]);
    } finally {
      await s.shutdown();
      store.close();
    }
  });

  it('a first call that failed before the 200 left nothing: the next message starts a fresh conversation', async () => {
    const r = await make(wire, priced());
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: tmp(), engine: 'p' });
    const s = openSession({
      store, dir: r.host.home,
      makeEngine: ({ onApprove, onLive }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0 }),
    }, row, true);
    try {
      r.push({ status: 401, text: 'no' });
      s.message('one');
      await s.idle();
      expect(store.getSession('s1')!.engineSessionId ?? null).toBeNull();
    } finally {
      await s.shutdown();
      store.close();
    }
  });
});

// ---- D4 (b): a compaction and an unknown reply ------------------------------------------------------------------------------------------
describe('D4 (b): a compaction that was paid and a reply of unknown cost are an unknown receipt', () => {
  const front = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
  const asked = (store: Store, kind: string) => {
    const l = store.readLog('s1');
    return l.filter((x) => x.type === 'question').map((x) => x.data as { id: string; kind: string })
      .filter((q) => q.kind === kind && !l.some((y) => (y.type === 'answer' || y.type === 'question_closed') && (y.data as { questionId: string }).questionId === q.id));
  };

  it.each([
    ['an unknown reply after a priced compaction', [{ usage: 600_000 }, { cost: 0.02 }, { cost: null }], 0.02],
    ['a priced reply after a compaction of unknown cost', [{ usage: 600_000 }, { cost: null }, { cost: 0.03 }], 0.03],
  ] as const)('%s: the turn row says unknown, the cost keeps the known part, and the receipt counts an unpriced reply', async (_n, script, known) => {
    const store = openStore(':memory:');
    const t = testEngine([...script]);
    const makeEngine: MakeEngine = t.makeEngine;
    const cwd = tmp();
    const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
    store.putSetting('autoCompressAt', 0.5);
    const s = openSession({ store, makeEngine, folderTrust: t.folderTrust, dir: tmp() }, row, true);
    try {
      s.message('one');
      await s.idle();
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, `${front}## phase one\n> Go.\n`);
      expect(s.runFile(file)).toEqual({ ok: true });
      await until(() => asked(store, 'trust').length > 0);
      s.answer(asked(store, 'trust')[0]!.id, 'y');
      await until(() => store.readLog('s1').some((x) => x.type === 'run_finished'));
      expect(t.compacts).toBe(1);
      const ended = store.readLog('s1').filter((x) => x.type === 'turn_ended' && x.runId).map((x) => x.data as { cost?: number; unknown?: boolean });
      expect(ended).toHaveLength(1);
      expect(ended[0]!.unknown).toBe(true);
      expect(ended[0]!.cost).toBeCloseTo(known, 12);
      const rid = store.readLog('s1').find((x) => x.type === 'run_started')!.runId!;
      expect(receipt(store.loadRun(rid)!.snapshot.events).unpricedTurns).toBe(1);
    } finally {
      await s.shutdown();
      store.close();
    }
  });
});
