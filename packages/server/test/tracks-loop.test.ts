// M2 task 10b (P): a branch of a split runs its own session on the API loop engine. A 429 on one branch is retried inside that branch only;
// a Stop with a branch's tool call unanswered leaves its conversation to the loop's pairing, which answers the call with the stub on the next turn.
// Driven as the app drives a run: openSession, a real workflow file, the fake provider, a fake key, temp folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { register, type EngineSession, type OpenOptions } from '@reins/core';
import { loopEngine } from '../src/loop/engine.js';
import { openSession } from '../src/session.js';
import { openStore, type Store } from '../src/store.js';
import { split } from '../../core/test/fixtures/split.js';
import { ssplit } from '../../core/test/fixtures/split-share.js';
import { askedQuestion } from './http-helpers.js';
import type { FakeReply } from './fake-provider.js';
import { WIRES, rig, toolReply, toolResults, type Rig, type WireId } from './loop-harness.js';

const INTERRUPTED = 'Interrupted; the tool did not finish.';
const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n';
const AFTER = '## phase after\n> after\n\n## end\n\n';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split), register(ssplit)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

let tmp = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-tracks-loop-')));
  fs.mkdirSync(path.join(tmp, 'proj'));
  fs.mkdirSync(path.join(tmp, 'outside'));
});
const rigs: Rig[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const s of stores.splice(0)) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });

async function boot(wire: WireId) {
  const r = await rig(wire, { strictPairs: true });
  rigs.push(r);
  const store = openStore(':memory:');
  stores.push(store);
  const cwd = path.join(tmp, 'proj');
  const row = store.createSession({ id: 's1', cwd, engine: 'p' });
  const opens: Array<{ o: OpenOptions; session?: EngineSession }> = [];
  const slept: number[] = [];
  const s = openSession({
    store, dir: r.host.home,
    makeEngine: ({ onApprove, onLive, settings }) => {
      const e = loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive, ...(settings ? { settings } : {}) }, { sleep: async (ms) => void slept.push(ms), random: () => 0 });
      return { ...e, open: async (x) => { const rec: (typeof opens)[number] = { o: x }; opens.push(rec); return (rec.session = await e.open(x)); } };
    },
  }, row, true);
  const x = {
    r, store, s, cwd, opens, slept,
    /** The sessions of the branches: only the main line's has a USD room. */
    branches: () => opens.filter((p) => !p.o.usdRoom),
    async go(body: string) {
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, FRONT + body);
      expect(s.runFile(file)).toEqual({ ok: true });
      s.answer((await askedQuestion(store, 's1', 'trust')).id, 'y');
    },
    rows: (type: string) => store.readLog('s1').filter((q) => q.type === type),
    sent: () => r.fake.requests.length,
  };
  return x;
}

describe.each(WIRES)('a split of loop-engine branches (%s)', (wire) => {
  it('a 429 on one branch is retried inside that branch: both finish, nothing pauses, the other branch is not slowed', async () => {
    const x = await boot(wire);
    x.r.push({ status: 429, body: 'slow down', headers: { 'retry-after': '1' } }, { text: 'A-WORDS\nREINS: done' }, { text: 'B-WORDS\nREINS: done' }, { text: 'REINS: done' });
    await x.go('## split\nnext: a\nnext: b\n\n' + AFTER + '## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n');
    await x.s.idle();
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.rows('run_paused')).toEqual([]);
    expect(x.sent()).toBe(4);   // the 429, one try again, the other branch, the main line
    expect(x.slept).toEqual([1000]);   // one wait, the server's Retry-After, and only one branch waited
    expect(x.branches()).toHaveLength(2);
    const ended = x.rows('track_ended').map((q) => (q.data as { track: string; text: string }));
    expect(ended.map((e) => e.track).sort()).toEqual(['a', 'b']);
    expect(ended.map((e) => e.text).sort()).toEqual(['A-WORDS', 'B-WORDS']);
    // the main line's request carries both results, once each
    const last = JSON.stringify(x.r.fake.requests[3]!.body);
    expect(last).toContain('A-WORDS');
    expect(last).toContain('B-WORDS');
  }, 60_000);

  it('Stop with a branch\'s tool call unanswered: its conversation is answered with the stub on the next turn, paired, and the other lines are not touched', async () => {
    const x = await boot(wire);
    const far = path.join(tmp, 'outside', 'far.txt');
    fs.writeFileSync(far, 'FAR-BODY');
    x.r.push({ toolCalls: [call('a', 'Read', { file_path: far })] });
    await x.go('## split\nnext: a\n\n' + AFTER + '## phase a\n> a\n\n## end\n');
    const q = await askedQuestion(x.store, 's1', 'tool');
    expect(q.title).toBe('Split split-1');   // the branch's own question, still open
    expect(x.sent()).toBe(1);
    const [branch] = x.branches();
    await x.s.close();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.sent()).toBe(1);   // nothing else went to the provider
    // the branch's conversation, opened again: the call has no result in the file, and the loop answers it with the stub
    x.r.push({ text: 'again ok' });
    const res = await (await x.r.open({ cwd: x.cwd, sessionId: branch!.session!.sessionId })).turn('go on');
    expect(res.text).toBe('again ok');
    expect(toolResults(x.r.fake.requests[1]!.body)).toEqual([{ id: 'a', content: INTERRUPTED }]);
  }, 60_000);
});

// ---- M2 task 12: a branch that shares the USD room reads it live --------------------------------------------------------------------------------
const sse = (o: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const chat = (delta: object, finish: string | null = null) => sse({ choices: [{ index: 0, delta, finish_reason: finish }] });
const msg = (type: string, o: object = {}) => sse({ type, ...o }, type);
const block = (t: string) => msg('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + msg('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }) + msg('content_block_stop', { index: 0 });
/** A complete reply that carries no usage anywhere: its cost is not known. */
const noUsage = (wire: WireId): FakeReply => ({
  body: wire === 'openai-chat'
    ? chat({ content: 'hello\nREINS: done' }) + chat({}, 'stop') + 'data: [DONE]\n\n'
    : msg('message_start', { message: {} }) + block('hello\nREINS: done') + msg('message_delta', { delta: { stop_reason: 'end_turn' } }) + msg('message_stop'),
  headers: { 'content-type': 'text/event-stream' },
});

/** A session on a provider that keeps no conversation of its own (the loop), priced so that a call costs real money, and a run file with a USD budget. */
async function bootUsd(wire: WireId, usd: number) {
  const r = await rig(wire, { strictPairs: true, manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: { input: 1000, output: 1000 } }] } });   // a call of 15 tokens costs 0.015
  rigs.push(r);
  const store = openStore(':memory:');
  stores.push(store);
  const cwd = path.join(tmp, 'proj');
  const row = store.createSession({ id: 's1', cwd, engine: 'p' });
  const opens: OpenOptions[] = [];
  const facts = { id: 'p', label: 'Fake', conversation: 'reins', key: 'set', keyEnv: [], defaultModel: 'm', model: () => ({ tools: true, efforts: [], priced: true }) };
  const s = openSession({
    store, dir: r.host.home,
    providers: { installed: () => true, facts: () => facts as never },
    makeEngine: ({ onApprove, onLive, settings }) => {
      const e = loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive, ...(settings ? { settings } : {}) }, { sleep: async () => {}, random: () => 0 });
      return { ...e, open: async (x) => { opens.push(x); return e.open(x); } };
    },
  }, row, true);
  return {
    r, store, s, opens,
    rows: (type: string) => store.readLog('s1').filter((q) => q.type === type),
    async go() {
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, `---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20, usd: ${usd} }\nalways: []\n---\n\n## ssplit\nnext: a\nnext: b\n\n${AFTER}## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n`);
      expect(s.runFile(file)).toEqual({ ok: true });
      s.answer((await askedQuestion(store, 's1', 'trust')).id, 'y');
    },
  };
}

describe.each(WIRES)('two branches that share a USD budget on the loop engine (%s)', (wire) => {
  it('an unknown reply on one branch: the other branch\'s next call, in the middle of its turn, is refused (the room is NaN), and the run asks once', async () => {
    const x = await bootUsd(wire, 5);
    // The first request is answered late with a tool call (a tool that needs no approval); the second at once, with a reply whose cost is not known.
    x.r.push({ ...toolReply(0), hangMs: 800 }, noUsage(wire), { text: 'late\nREINS: done' }, { text: 'REINS: done' });
    await x.go();
    const q = await askedQuestion(x.store, 's1', 'usd', 8_000);
    expect(q.detail).toContain('cannot tell what this session has spent');
    expect(x.r.fake.requests).toHaveLength(2);   // the waiting branch's second call was not sent
    // both branch sessions read the room live: a function, and no cap for the process (the loop answers `cap: live`)
    expect(x.opens).toHaveLength(2);
    for (const o of x.opens) { expect(o.usdRoom).toBeTypeOf('function'); expect(o.maxUsd).toBeUndefined(); }
    expect(x.rows('budget_reached')).toHaveLength(1);
    x.s.answer(q.id, 'stop');
    await x.s.idle();
    await x.s.close();
  }, 60_000);

  it('a branch that used its share is re-shared in place: no new session, its next turn is CARRY_ON, and the run goes on', async () => {
    const x = await bootUsd(wire, 0.1);   // two shares of 0.05
    // The first request waits, so the other branch (its reply is the second push) answers and ends first. The waiting one then spends 0.06 in four calls
    // (the engine refuses the fifth: its share is used up), takes the 0.025 the other left, and carries on.
    x.r.push({ ...toolReply(0), hangMs: 600 }, { text: 'other\nREINS: done' }, toolReply(1), toolReply(2), toolReply(3), { text: 'carried on\nREINS: done' }, { text: 'REINS: done' });
    await x.go();
    await x.s.idle();
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.rows('budget_reached')).toEqual([]);
    expect(x.r.fake.requests).toHaveLength(7);
    expect(x.opens).toHaveLength(3);   // the two branches, then the main line after the join
    expect(x.opens.filter((o) => o.sessionId !== undefined)).toEqual([]);   // none of them resumed an earlier conversation: nothing was reopened
    const warned = x.rows('budget_warning').map((q) => (q.data as { text: string }).text);
    expect(warned).toEqual(['Branch ssplit-1 used its share of the USD budget; it goes on with $0.025 the others left unused.']);
    expect(JSON.stringify(x.r.fake.requests[5]!.body)).toContain('the run was resumed');
    await x.s.close();
  }, 60_000);
});