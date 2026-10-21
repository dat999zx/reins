// Task 16 (spec 4.8, 4.9 `context`, 4.12c): compaction. The cut and the stubs as pure functions, the summary call, the boundary in the conversation
// file, the context-overflow 400, and the session's auto-compress with the loop engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@reins/core';
import { chooseCut, stubOldResults, stubText, SUMMARY_SYSTEM, tokensOf, withSummary } from '../src/loop/compact.js';
import { loopEngine } from '../src/loop/engine.js';
import { classify, isContextTooLong, WORDS } from '../src/loop/retry.js';
import type { Msg } from '../src/loop/types.js';
import { ProviderError } from '../src/send.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { until } from './helpers.js';
import { cleanup, tmpDir } from './http-helpers.js';
import { COST_120, KEY, PRICE, USAGE_120, WIRES, rig, type Rig, type WireId } from './loop-harness.js';

const rigs: Rig[] = [];
const dirs: string[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await cleanup();
});
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-compact-')));
  dirs.push(d);
  return d;
};

// ---- pure helpers: messages by their size in characters ------------------------------------------------------------------------------------
const u = (n: number, tag = ''): Msg => ({ role: 'user', blocks: [{ type: 'text', text: tag + 'u'.repeat(n - tag.length) }] });
const a = (n: number): Msg => ({ role: 'assistant', blocks: [{ type: 'text', text: 'a'.repeat(n) }] });
/** An assistant message with one call: 4 characters of name and 2 of arguments. */
const ac = (id: string): Msg => ({ role: 'assistant', blocks: [{ type: 'tool_call', id, name: 'Read', args: {} }] });
const rs = (id: string, n: number): Msg => ({ role: 'user', blocks: [{ type: 'tool_result', id, content: 'r'.repeat(n) }] });
/** A window whose 20 % is exactly `chars` characters of tail. */
const windowFor = (chars: number) => Math.ceil(chars / 4 / 0.2) + 1;

describe('chooseCut: where the tail starts', () => {
  const round = (): Msg[] => [u(40), ac('1'), rs('1', 400), a(40), u(40), ac('2'), rs('2', 400), a(40)];
  // The tail from the end: 40, 440 (the second result), 446 (its call), 486 (the user message), 526, 926, 932, 972 characters.
  it.each([
    ['the tail starts at a user message, no move', 500, 4],
    ['the budget ends inside a round (at its call): the cut moves back to the user message that began the round', 460, 4],
    ['the budget ends inside a round (at its result): the cut moves back too', 440, 4],
    ['everything fits: nothing to summarise', 1000, undefined],
    ['the budget ends inside the FIRST round: back to the start, nothing before it', 928, undefined],
  ] as const)('%s', (_name, room, want) => {
    expect(chooseCut(round(), windowFor(room))).toBe(want);
  });

  it('a tail is min(20 % of the window, 25,000 tokens): a big window is held to 25,000 tokens', () => {
    const history = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? u(10_000) : a(10_000)));
    // 25,000 tokens are 100,000 characters: ten messages. The 20 % of a million tokens would keep all of it.
    expect(chooseCut(history, 1_000_000)).toBe(30);
    expect(chooseCut(history, undefined)).toBe(30);
    expect(tokensOf(history.slice(30))).toBe(25_000);
  });

  it('a window of 8,000 tokens keeps 1,600 tokens (6,400 characters), rounded back to a user message', () => {
    const history = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? u(2000) : a(2000)));
    // Three messages fit (6,000 characters); that starts at an assistant message, so the cut moves back to the user message before it.
    expect(chooseCut(history, 8000)).toBe(6);
  });

  it('one huge last round is kept whole, however big', () => {
    expect(chooseCut([u(100), a(100), u(100), ac('1'), rs('1', 100_000), a(100)], 8000)).toBe(2);
    expect(chooseCut([u(100), a(100), u(100_000), a(100)], 8000)).toBe(2);
  });

  it('a conversation of one turn has nothing to summarise', () => {
    expect(chooseCut([u(100), ac('1'), rs('1', 100_000), a(100)], 8000)).toBeUndefined();
    expect(chooseCut([], 8000)).toBeUndefined();
  });

  it('the tail never starts at a tool result or an assistant message, over many shapes', () => {
    for (let n = 1; n < 60; n++) {
      const history = [u(30), ac('1'), rs('1', 30 * n), a(30), u(30), a(n * 7), u(30), ac('2'), rs('2', 20 * n), ac('3'), rs('3', 50), a(10)];
      for (const w of [100, 400, 2000, 10_000]) {
        const cut = chooseCut(history, w);
        if (cut === undefined) continue;
        const first = history[cut]!;
        expect(first.role).toBe('user');
        expect(first.blocks.some((b) => b.type === 'tool_result')).toBe(false);
      }
    }
  });
});

describe('stubOldResults and withSummary', () => {
  it('cuts the long results before the cut, keeps ids and short results, leaves the tail alone', () => {
    const msgs = [u(10), ac('1'), rs('1', 501), ac('2'), rs('2', 500), a(5), u(10), ac('3'), rs('3', 5000)];
    const out = stubOldResults(msgs, 6);
    expect(out[2]!.blocks).toEqual([{ type: 'tool_result', id: '1', content: stubText(501) }]);
    expect(stubText(501)).toBe('[tool result cut by compaction, was 501 characters]');
    expect(out[4]).toBe(msgs[4]); // 500 characters is not over the line
    expect(out[8]).toBe(msgs[8]); // the tail is not touched
    expect(out[1]).toBe(msgs[1]);
  });

  it('puts the summary in the first user message of the tail, so no two user messages follow each other', () => {
    const tail = [u(10, 'TAIL'), a(5)];
    const out = withSummary('SUM', tail);
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'Summary of the earlier conversation: SUM' }, tail[0]!.blocks[0]]);
    expect(withSummary('SUM', [a(5)]).map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('the context-too-long 400 (spec 4.9)', () => {
  const as400 = (body: string) => classify(new ProviderError(`Fake answered 400: ${body}`, 400));
  it.each([
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    '{"error":{"code":"context_length_exceeded","message":"x"}}',
    'prompt is too long: 250000 tokens > 200000 maximum',
    'Input is too long for requested model.',
    'Request has too many tokens',
    'Your input exceeds the context window of this model',
  ])('is class context: %s', (body) => {
    expect(as400(body)).toBe('context');
    expect(isContextTooLong(body)).toBe(true);
  });

  it.each([
    'max_tokens must be less than or equal to 4096',
    'max_tokens: 9000 > 8192, which is the maximum allowed number of output tokens',
    'too many tools (max 128)',
    'messages.0.content: Input should be a valid string',
    'invalid value for temperature',
  ])('is a plain bad request: %s', (body) => {
    expect(as400(body)).toBe('bad');
    expect(isContextTooLong(body)).toBe(false);
  });

  it('only a 400 is a context error; a 500 with the same words is a server error', () => {
    expect(classify(new ProviderError('Fake answered 500: prompt is too long', 500))).toBe('server');
  });

  it('the words of the table', () => {
    expect(WORDS.context.say('Fake', 400, 'm')).toBe('The conversation is too long for m even after compressing.');
    expect(WORDS.context.retry).toBe(false);
  });
});

// ---- the engine ------------------------------------------------------------------------------------------------------------------------------
const para = (tag: string, n = 3000) => `${tag} ${'w'.repeat(n)}`;
const ASK = 'Write the summary of the conversation above';
const isSummary = (body: any) => JSON.stringify(body).includes(ASK);
const wireText = (body: any) => JSON.stringify(body.messages);
const roles = (body: any): string[] => body.messages.filter((m: any) => m.role !== 'system').map((m: any) => m.role);
const READ = (id: string, file: string) => ({ toolCalls: [{ id, name: 'Read', args: JSON.stringify({ file_path: file }) }] });
const win = (context: number | undefined, price: typeof PRICE | null = PRICE) => ({ manifest: { models: [{ id: 'm', ...(context !== undefined ? { context } : {}), maxOutput: 100, ...(price ? { price } : {}) }] } });
const noSystem = (body: any): any[] => body.messages.filter((m: any) => m.role !== 'system');
const sized = win(8000);
const folder = (r: Rig) => path.join(r.host.home, 'conversations');
const raw = (r: Rig, id: string) => fs.readFileSync(path.join(folder(r), `${id}.jsonl`), 'utf8');
const lines = (r: Rig, id: string): any[] => raw(r, id).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const compacted = (ev: EngineEvent[] | undefined) => (ev ?? []).filter((e) => e.type === 'compacted');

/** Four turns of 6,000 characters each; the first has a tool round with a 3,000 character result. Window 8,000: the tail is the last turn. */
async function history4(r: Rig, wire: WireId, cwd: string, usage?: Record<string, unknown>) {
  // Many short lines: the Read tool shows at most 500 characters of a line.
  fs.writeFileSync(path.join(cwd, 'big.txt'), `${'z'.repeat(50)}\n`.repeat(60));
  const s = await r.open({ cwd });
  r.push({ ...READ('c0', 'big.txt'), ...(usage ? { usage } : {}) }, { text: para('A1'), ...(usage ? { usage } : {}) });
  let last = await s.turn(para('Q1'));
  for (const n of [2, 3, 4]) {
    r.push({ text: para(`A${n}`), ...(usage ? { usage } : {}) });
    last = await s.turn(para(`Q${n}`));
  }
  void wire;
  return { s, last };
}

describe.each(WIRES)('compact(): the summary call, the next request (%s)', (wire) => {
  it('stubs old long results, makes one call with no tools, and the next request is system + summary + tail; `compacted` has an estimated after', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp());
    const sentBefore = r.fake.requests.length;
    r.push({ text: 'SUMMARY TEXT', usage: USAGE_120[wire] });
    const res = await s.compact!();
    expect(r.fake.requests).toHaveLength(sentBefore + 1);
    const ask = r.fake.requests.at(-1)!.body;
    expect(isSummary(ask)).toBe(true);
    expect(JSON.stringify(ask)).toContain(SUMMARY_SYSTEM.slice(0, 40));
    expect(ask.tools).toBeUndefined();
    const asked = JSON.stringify(ask);
    expect(asked).toContain('[tool result cut by compaction, was ');
    expect(asked).not.toContain('z'.repeat(50));
    expect(asked).toContain('Q1');
    expect(asked).toContain('A3');
    expect(asked).not.toContain('Q4'); // the tail is not summarised

    const ev = compacted(res.events);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ type: 'compacted', trigger: 'manual', before: expect.any(Number), after: expect.any(Number) });
    const { before, after } = ev[0] as { before: number; after: number };
    expect(Number.isInteger(before) && Number.isInteger(after)).toBe(true);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    expect(r.live.filter((e) => e.type === 'compacted')).toEqual(ev);
    expect(res.text).toBe('');

    r.push({ text: 'next answer' });
    await s.turn('Q5 now');
    const body = r.fake.requests.at(-1)!.body;
    const all = wireText(body);
    expect(all).toContain('Summary of the earlier conversation: SUMMARY TEXT');
    for (const kept of ['Q4', 'A4', 'Q5 now']) expect(all).toContain(kept);
    for (const gone of ['Q1', 'Q2', 'Q3', 'A1', 'A2', 'A3', 'zzzz']) expect(all).not.toContain(gone);
    expect(JSON.stringify(body)).not.toContain(SUMMARY_SYSTEM.slice(0, 40));
    // The summary and the first tail message are ONE user message; no two messages of a role follow each other.
    const first = body.messages.filter((m: any) => m.role !== 'system')[0];
    expect(first.role).toBe('user');
    expect(JSON.stringify(first)).toContain('SUMMARY TEXT');
    expect(JSON.stringify(first)).toContain('Q4');
    const rl = roles(body);
    expect(rl).toEqual(['user', 'assistant', 'user']);
  });

  it('charges the summary call: the total grows by its cost', async () => {
    const r = await make(wire, sized);
    const { s, last } = await history4(r, wire, tmp());
    r.push({ text: 'SUM', usage: USAGE_120[wire] });
    const res = await s.compact!();
    expect(res.cost).toBeCloseTo(COST_120, 12);
    expect(res.total).toBeCloseTo(last.total! + COST_120, 12);
    expect(res.totals!.m).toBeCloseTo(last.total! + COST_120, 12);
    expect(res.models!.m).toBeCloseTo(COST_120, 12);
    // The next turn is charged for itself only.
    r.push({ text: 'ok', usage: USAGE_120[wire] });
    const next = await s.turn('go');
    expect(next.cost).toBeCloseTo(COST_120, 12);
    expect(next.total).toBeCloseTo(res.total! + COST_120, 12);
  });

  it('a model with no price keeps the total unknown, compaction included', async () => {
    const r = await make(wire, win(8000, null));
    const { s, last } = await history4(r, wire, tmp());
    expect(last.total).toBeUndefined();
    r.push({ text: 'SUM' });
    const res = await s.compact!();
    expect(compacted(res.events)).toHaveLength(1);
    expect(res.total).toBeUndefined();
    expect(res.cost).toBeUndefined();
  });

  it('the request after a compaction passes strictPairs, with the cut inside a tool round moved back to its user message', async () => {
    const r = await make(wire, { ...sized, strictPairs: true });
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'big6.txt'), `${'y'.repeat(50)}\n`.repeat(120));
    const s = await r.open({ cwd });
    r.push({ text: para('A1') });
    await s.turn(para('U1'));
    // Turn 2 is a tool round with a result of over 6,000 characters: the budget (6,400 characters) ends inside it.
    r.push(READ('c1', 'big6.txt'), { text: 'A2 short' });
    await s.turn('U2 short');
    r.push({ text: 'A3 short' });
    await s.turn('U3 short');
    r.push({ text: 'SUM' });
    const res = await s.compact!();
    expect(compacted(res.events)).toHaveLength(1);
    const ask = JSON.stringify(r.fake.requests.at(-1)!.body);
    expect(ask).toContain('U1');
    expect(ask).not.toContain('U2 short'); // U2 began the round the cut fell in: it is in the tail
    r.push({ text: 'after' });
    const next = await s.turn('U4 short');
    expect(next.text).toBe('after'); // strictPairs answers 400 for any unpaired call or result
    const all = wireText(r.fake.requests.at(-1)!.body);
    expect(all).toContain('U2 short');
    expect(all).toContain('yyyy');
    expect(all).not.toContain('U1');
  });

  it('a failing summary call leaves the file and the history as they were (500 after the retries, a 400, an abort)', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp());
    const before = raw(r, s.sessionId);
    const err500 = { status: 500, body: 'boom' };
    r.push(err500, err500, err500, err500);
    await expect(s.compact!()).rejects.toThrow('had a server error (500)');
    expect(raw(r, s.sessionId)).toBe(before);

    r.push({ status: 400, body: JSON.stringify({ error: { message: 'nope', type: 'invalid_request_error' } }) });
    await expect(s.compact!()).rejects.toThrow('refused the request (400)');
    expect(raw(r, s.sessionId)).toBe(before);

    const n = r.fake.requests.length;
    r.push({ text: 'late summary', hangMs: 10_000 });
    const running = s.compact!();
    await until(() => r.fake.requests.length === n + 1);
    await s.interrupt();
    const res = await running;
    expect(compacted(res.events)).toEqual([]);
    expect(raw(r, s.sessionId)).toBe(before);

    // The history is whole: the next request carries every turn, and no summary.
    r.push({ text: 'still here' });
    await s.turn('Q5');
    const all = wireText(r.fake.requests.at(-1)!.body);
    for (const t of ['Q1', 'A1', 'Q2', 'Q3', 'Q4', 'A4']) expect(all).toContain(t);
    expect(all).not.toContain('Summary of the earlier');
  });

  it('the budget out before the summary: no call, a budget stop, nothing changed', async () => {
    const r = await make(wire, sized);
    const room = { v: 5 };
    const cwd = tmp();
    const s = await r.open({ cwd, usdRoom: () => room.v });
    for (const n of [1, 2, 3]) {
      r.push({ text: para(`A${n}`) });
      await s.turn(para(`Q${n}`));
    }
    const before = raw(r, s.sessionId);
    const n = r.fake.requests.length;
    room.v = 0;
    const res = await s.compact!();
    expect(r.fake.requests).toHaveLength(n);
    expect(res.budgetStop).toBe(true);
    expect(res.isError).toBe(true);
    expect(res.text).toBe('The USD budget is used up.');
    expect(res.events!.some((e) => e.type === 'hook' && e.event === 'usd-stop')).toBe(true);
    expect(res.events!.some((e) => e.type === 'error')).toBe(false);
    expect(compacted(res.events)).toEqual([]);
    expect(raw(r, s.sessionId)).toBe(before);
  });

  it('refuses while a turn runs, and a second compaction while one runs', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp());
    const n = r.fake.requests.length;
    r.push({ text: 'slow', hangMs: 10_000 });
    const turn = s.turn('Q5');
    await until(() => r.fake.requests.length === n + 1);
    await expect(s.compact!()).rejects.toThrow('a turn is already running');
    await s.interrupt();
    await turn;

    const m = r.fake.requests.length;
    r.push({ text: 'slow summary', hangMs: 10_000 });
    const first = s.compact!();
    await until(() => r.fake.requests.length === m + 1);
    await expect(s.compact!()).rejects.toThrow('a turn is already running');
    await expect(s.turn('Q6')).rejects.toThrow('a turn is already running');
    await s.interrupt();
    await first;
  });

  it('a conversation too short to cut says so and calls nothing', async () => {
    const r = await make(wire, sized);
    const s = await r.open({ cwd: tmp() });
    r.push({ text: 'hi' });
    await s.turn('hello');
    const n = r.fake.requests.length;
    const res = await s.compact!();
    expect(r.fake.requests).toHaveLength(n);
    expect(compacted(res.events)).toEqual([]);
    expect(res.text).toMatch(/^Nothing to compress/);
  });
});

describe.each(WIRES)('the file after a compaction (%s)', (wire) => {
  it('has one boundary line (summary block first) and the tail again; reopening loads the same history, the next request equals the in-memory one, and the money adds up', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp(), USAGE_120[wire]);
    r.push({ text: 'SUMMARY TEXT', usage: USAGE_120[wire] });
    const done = await s.compact!();
    r.push({ text: 'answer five', usage: USAGE_120[wire] });
    const five = await s.turn('Q5 now');
    const inMemory = r.fake.requests.at(-1)!.body;

    const file = lines(r, s.sessionId);
    const at = file.findIndex((l) => l.blocks?.some((b: any) => b.type === 'summary'));
    expect(at).toBeGreaterThan(0);
    expect(file.filter((l) => l.blocks?.some((b: any) => b.type === 'summary'))).toHaveLength(1);
    expect(file[at].role).toBe('user');
    expect(file[at].blocks[0]).toEqual({ type: 'summary', text: 'Summary of the earlier conversation: SUMMARY TEXT' });
    expect(JSON.stringify(file[at].blocks.slice(1))).toContain('Q4'); // the first message of the tail is on the boundary line
    // The tail again, after the boundary: its reply carries a usage of nothing; the summary call's spend is on the boundary line.
    expect(file[at].usage.cost).toBeCloseTo(COST_120, 12);
    const copied = file[at + 1];
    expect(copied.role).toBe('assistant');
    expect(copied.usage).toMatchObject({ input: 0, output: 0, cost: 0 });

    await s.close();
    r.push({ text: 'answer six', usage: USAGE_120[wire] });
    const again = await r.open({ sessionId: s.sessionId });
    const six = await again.turn('Q6 later');
    const reloaded = r.fake.requests.at(-1)!.body;
    // The request of the reopened session starts with the request the first one sent, then its reply and the new message.
    // (The system prompt is left out: it names the folder and holds the card marker of its own session.)
    expect(noSystem(reloaded).slice(0, noSystem(inMemory).length)).toEqual(noSystem(inMemory));
    expect(wireText(reloaded)).toContain('answer five');
    expect(wireText(reloaded)).not.toContain('Q3');
    // Five calls of the first part (the tool round is two) + the summary + turn five, each COST_120: the copies of the tail added nothing, and
    // nothing is unknown.
    expect(done.total).toBeCloseTo(6 * COST_120, 12);
    expect(five.total).toBeCloseTo(7 * COST_120, 12);
    expect(six.total).toBeCloseTo(8 * COST_120, 12);
  });

  it('a key in the summary is not in the file; a key typed in the head never reaches it again', async () => {
    const r = await make(wire, sized);
    const s = await r.open({ cwd: tmp() });
    r.push({ text: para('A1') });
    await s.turn(`${para('Q1')} my key is ${KEY}`);
    for (const n of [2, 3]) {
      r.push({ text: para(`A${n}`) });
      await s.turn(para(`Q${n}`));
    }
    r.push({ text: `summary with ${KEY} inside` });
    await s.compact!();
    expect(raw(r, s.sessionId)).not.toContain(KEY);
    const boundary = lines(r, s.sessionId).find((l) => l.blocks?.some((b: any) => b.type === 'summary'));
    expect(boundary.blocks[0].text).toContain('summary with');
  });
});

describe.each(WIRES)('a context-too-long answer compacts once and sends once more (%s)', (wire) => {
  const TOO_LONG = (w: WireId) => (w === 'openai-chat'
    ? { status: 400, body: JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", code: 'context_length_exceeded' } }) }
    : { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }) });

  it('the first overflow: one summary call, one more request, which succeeds; the user message is in the file once', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp());
    const n = r.fake.requests.length;
    r.push(TOO_LONG(wire), { text: 'SUMMARY TEXT', usage: USAGE_120[wire] }, { text: 'fine now' });
    const res = await s.turn(para('Q5'));
    expect(res.text).toBe('fine now');
    expect(r.fake.requests).toHaveLength(n + 3);
    const [first, ask, retry] = r.fake.requests.slice(n).map((x) => x.body);
    expect(wireText(first)).toContain('Q1');
    expect(isSummary(ask)).toBe(true);
    expect(isSummary(retry)).toBe(false);
    expect(wireText(retry)).toContain('Summary of the earlier conversation: SUMMARY TEXT');
    expect(wireText(retry)).not.toContain('Q1');
    expect(wireText(retry).split('Q5')).toHaveLength(2); // once
    expect(compacted(res.events)).toEqual([{ type: 'compacted', trigger: 'overflow', before: expect.any(Number), after: expect.any(Number) }]);
    expect(res.cost).toBeGreaterThan(COST_120); // the summary call is part of the turn's cost
    const file = lines(r, s.sessionId);
    expect(file.filter((l) => l.blocks?.some((b: any) => b.type === 'summary'))).toHaveLength(1);
    expect(raw(r, s.sessionId).split('Q5')).toHaveLength(2);
    expect(roles(retry)).toEqual(['user', 'assistant', 'user']); // the tail: the turn before (Q4, A4) and the new message
  });

  it('a second overflow fails with the words and the body, and does not compact a third time', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp());
    const n = r.fake.requests.length;
    r.push(TOO_LONG(wire), { text: 'SUMMARY TEXT' }, TOO_LONG(wire), { text: 'never used' }, { text: 'never used either' });
    await expect(s.turn(para('Q5'))).rejects.toThrow(/The conversation is too long for m even after compressing\. The provider said: .*(maximum context length|prompt is too long)/);
    expect(r.fake.requests).toHaveLength(n + 3);
    expect(lines(r, s.sessionId).filter((l) => l.blocks?.some((b: any) => b.type === 'summary'))).toHaveLength(1);
  });

  it('once per turn: an overflow later in the same turn, after a tool round made a second compaction possible, fails and does not compact', async () => {
    const r = await make(wire, sized);
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'big6.txt'), `${'y'.repeat(50)}\n`.repeat(120));
    const s = await r.open({ cwd });
    for (const i of [1, 2, 3]) {
      r.push({ text: para(`A${i}`) });
      await s.turn(para(`Q${i}`));
    }
    const n = r.fake.requests.length;
    // After the first compaction the reply asks for a 6,000 character file; the next call overflows again, and now there IS something to cut.
    r.push(TOO_LONG(wire), { text: 'SUMMARY ONE' }, READ('c9', 'big6.txt'), TOO_LONG(wire), { text: 'SUMMARY TWO' }, { text: 'final' });
    await expect(s.turn(para('Q4', 100))).rejects.toThrow('The conversation is too long for m even after compressing.');
    expect(r.fake.requests).toHaveLength(n + 4); // the call, the summary, the call that asked for the file, the call that overflowed
    expect(lines(r, s.sessionId).filter((l) => l.blocks?.some((b: any) => b.type === 'summary'))).toHaveLength(1);
  });

  it('a conversation with nothing to cut fails at the first overflow, with the words', async () => {
    const r = await make(wire, sized);
    const s = await r.open({ cwd: tmp() });
    r.push(TOO_LONG(wire));
    await expect(s.turn('only one turn')).rejects.toThrow('The conversation is too long for m even after compressing.');
    expect(r.fake.requests).toHaveLength(1);
  });
});

describe.each(WIRES)('an empty summary (%s)', (wire) => {
  it('is no summary: compact() fails, the file and the history stay as they were', async () => {
    const r = await make(wire, sized);
    const { s } = await history4(r, wire, tmp());
    const before = raw(r, s.sessionId);
    r.push({ text: '   ' });
    await expect(s.compact!()).rejects.toThrow('empty summary');
    // The conversation is as it was; the one thing added is the paid call's usage, on a line of its own (it was billed).
    const after = raw(r, s.sessionId);
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length).split('\n').filter((l) => l.trim() !== '');
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0]!)).toMatchObject({ t: 'usage', alone: true });
    r.push({ text: 'still here' });
    await s.turn('Q5');
    const all = wireText(r.fake.requests.at(-1)!.body);
    for (const t of ['Q1', 'Q2', 'Q3', 'Q4']) expect(all).toContain(t);
    expect(all).not.toContain('Summary of the earlier');
  });
});

// ---- through the session ---------------------------------------------------------------------------------------------------------------------
describe('through openSession and the loop engine', () => {
  const useOf = (wire: WireId, tokens: number) => (wire === 'openai-chat' ? { prompt_tokens: tokens, completion_tokens: 5 } : { input_tokens: tokens, output_tokens: 5 });
  const open = (r: Rig, at?: number) => {
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: tmpDir(), engine: 'p' });
    if (at !== undefined) store.putSetting('autoCompressAt', at);
    const s = openSession({
      store, dir: r.host.home,
      makeEngine: ({ onApprove, onLive }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0 }),
    }, row, true);
    const data = (type: string) => store.readLog('s1').filter((x) => x.type === type).map((x) => x.data as any);
    const engine = (type: string) => data('engine').filter((d) => d.type === type);
    return { store, s, data, engine };
  };

  it('auto-compress at 0.5 fires before the next reply', async () => {
    const wire: WireId = 'openai-chat';
    const r = await make(wire, win(1000));
    const x = open(r, 0.5);
    try {
      r.push({ text: para('A1', 900), usage: useOf(wire, 600) }, { text: para('A2', 900), usage: useOf(wire, 600) });
      x.s.message(para('Q1', 900));
      await x.s.idle();
      x.s.message(para('Q2', 900));
      await x.s.idle();
      expect(x.engine('compacted')).toEqual([]);
      const n = r.fake.requests.length;
      r.push({ text: 'SUMMARY TEXT', usage: useOf(wire, 50) }, { text: 'third answer', usage: useOf(wire, 100) });
      x.s.message('Q3 now');
      await x.s.idle();
      expect(r.fake.requests).toHaveLength(n + 2);
      expect(isSummary(r.fake.requests[n]!.body)).toBe(true); // the summary comes first
      const reply = wireText(r.fake.requests[n + 1]!.body);
      expect(reply).toContain('Summary of the earlier conversation: SUMMARY TEXT');
      expect(reply).toContain('Q3 now');
      expect(reply).not.toContain('Q1');
      expect(x.engine('compacted')).toHaveLength(1);
      // One note for the compression that had nothing to cut yet (one turn), one for this one.
      expect(x.data('note').map((d) => d.text)).toEqual([expect.stringContaining('compressing before the next reply'), expect.stringContaining('compressing before the next reply')]);
      expect(x.data('turn_failed')).toEqual([]);
      // The summary's cost is in the reply it preceded.
      const cost = (t: number, o: number) => (t * PRICE.input + o * PRICE.output) / 1e6;
      expect(x.data('turn_ended').at(-1).cost).toBeCloseTo(cost(50, 5) + cost(100, 5), 12);
    } finally {
      await x.s.shutdown();
      x.store.close();
    }
  });

  it('a model with no known window never compresses on its own, is told so once, and can still compress by hand', async () => {
    const wire: WireId = 'openai-chat';
    const r = await make(wire, win(undefined));
    const x = open(r, 0.5);
    try {
      const big = (tag: string) => para(tag, 30_000);
      r.push({ text: big('A1'), usage: useOf(wire, 600) }, { text: big('A2'), usage: useOf(wire, 6000) }, { text: big('A3'), usage: useOf(wire, 60_000) }, { text: 'A4', usage: useOf(wire, 90_000) });
      for (const n of [1, 2, 3, 4]) {
        x.s.message(n === 4 ? 'Q4' : big(`Q${n}`));
        await x.s.idle();
      }
      const words = 'The window of m is not known, so Reins will not compress on its own. Set it in Settings > Providers.';
      expect(x.data('note').map((d) => d.text)).toEqual([words]);
      expect(x.engine('compacted')).toEqual([]);
      expect(r.fake.requests).toHaveLength(4);
      expect(x.data('turn_failed')).toEqual([]);

      r.push({ text: 'SUMMARY TEXT' });
      expect(x.s.compress()).toEqual({ ok: true });
      await x.s.idle();
      expect(x.engine('compacted')).toHaveLength(1);
      expect(isSummary(r.fake.requests.at(-1)!.body)).toBe(true);
      expect(x.data('note').map((d) => d.text)).toEqual([words]);
    } finally {
      await x.s.shutdown();
      x.store.close();
    }
  });

  it('a model with a window is not told anything', async () => {
    const wire: WireId = 'openai-chat';
    const r = await make(wire, win(1_000_000));
    const x = open(r, 0.5);
    try {
      r.push({ text: 'one', usage: useOf(wire, 10) }, { text: 'two', usage: useOf(wire, 10) });
      x.s.message('Q1');
      await x.s.idle();
      x.s.message('Q2');
      await x.s.idle();
      expect(x.data('note')).toEqual([]);
    } finally {
      await x.s.shutdown();
      x.store.close();
    }
  });
});
