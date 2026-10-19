// Milestone P, Task 15 (spec 4.1, 6.2, 6.3): the loop holds the USD limits before every model call, and the Run pauses on the USD card.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loopEngine } from '../src/loop/engine.js';
import { openSession } from '../src/session.js';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { until } from './helpers.js';
import { askedQuestion, cleanup, PROBE, request, rowsOf, tmpDir } from './http-helpers.js';
import { MISSING_RESULT, rig, toolReply, toolResults, WIRES, type Rig, type WireId } from './loop-harness.js';

const rigs: Rig[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  await cleanup();
});

const USED_UP = 'The USD budget is used up.';
/** 1000 USD per million tokens: one input token is 0.001 USD, so a call of 8 tokens costs 0.008 and one of 700 costs 0.7. */
const TOKEN_PRICE = { input: 1000, output: 1000 };
const priced = { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: TOKEN_PRICE }] } };
/** The usage of one call that costs `tokens` / 1000 USD (input only), on either wire. */
const use = (wire: WireId, tokens: number) => (wire === 'openai-chat' ? { prompt_tokens: tokens, completion_tokens: 0 } : { input_tokens: tokens, output_tokens: 0 });
const tool = (wire: WireId, tokens: number, n: number) => ({ ...toolReply(n), usage: use(wire, tokens) });
const text = (wire: WireId, tokens: number, t = 'done') => ({ text: t, usage: use(wire, tokens) });
const sent = (r: Rig) => r.fake.requests.length;

describe.each(WIRES)('usdRoom: held before each call (%s)', (wire) => {
  it('the call that would start with no room is not sent; the one before it was, and its tools ran', async () => {
    const r = await make(wire, priced);
    r.push(tool(wire, 12, 0), text(wire, 12));
    const s = await r.open({ usdRoom: () => 0.01 });
    const res = await s.turn('go');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(1);   // 0.012 spent against a room of 0.01: the second call is not sent
    expect(res.cost).toBeCloseTo(0.012, 12);
    // The reply that was paid for had a tool call: the tool ran and its result is in the history (a stub would mean the check came after the call).
    r.push(text(wire, 1));
    await s.turn('again');
    expect(toolResults(r.fake.requests.at(-1)!.body).map((x) => x.content)).toEqual([MISSING_RESULT]);
  });

  it('with no room at all the first call is not sent', async () => {
    const r = await make(wire, priced);
    const s = await r.open({ usdRoom: () => 0 });
    const res = await s.turn('go');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(0);
    // Fix round: a budget stop is a normal stop, not an `error` event (the session reads that as a dead engine); the Run reads `budgetStop`.
    expect(res.events!.some((e) => e.type === 'error')).toBe(false);
    expect(res.events!.filter((e) => e.type === 'hook' && e.event === 'usd-stop')).toEqual([{ type: 'hook', event: 'usd-stop', decision: 'stopped', reason: USED_UP }]);
    expect(res.budgetStop).toBe(true);
  });

  it('a negative room (the Run is over already) sends nothing either', async () => {
    const r = await make(wire, priced);
    const s = await r.open({ usdRoom: () => -0.02 });
    expect((await s.turn('go')).text).toBe(USED_UP);
    expect(sent(r)).toBe(0);
  });

  it('the room is read at every call: 0.008 calls against 0.01 send two, never a third; the pause comes on the next call, not as a crash', async () => {
    const r = await make(wire, priced);
    r.push(tool(wire, 8, 0), tool(wire, 8, 1), text(wire, 8));
    const s = await r.open({ usdRoom: () => 0.01 });
    const res = await s.turn('go');
    expect(sent(r)).toBe(2);
    expect(res.isError).toBe(true);
    expect(res.text).toBe(USED_UP);
    expect(res.cost).toBeCloseTo(0.016, 12);   // the spend passes the limit by one call, as the spec bounds it
  });

  it('the room is the run\'s now, less this turn\'s spend: a new turn starts from the room the host reports', async () => {
    const r = await make(wire, priced);
    let room = 0.02;
    r.push(text(wire, 8, 'one'), text(wire, 8, 'two'), text(wire, 8, 'three'));
    const s = await r.open({ usdRoom: () => room });
    expect((await s.turn('1')).isError).toBeUndefined();
    room = 0.012;   // the host counted the first turn: 0.008 gone
    expect((await s.turn('2')).isError).toBeUndefined();
    room = 0;   // another 0.008 gone, and it is over
    expect((await s.turn('3')).text).toBe(USED_UP);
    expect(sent(r)).toBe(2);
  });

  it('a host with no limit (undefined) is not limited', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 5000));
    const s = await r.open({ usdRoom: () => undefined });
    const res = await s.turn('go');
    expect(res.isError).toBeUndefined();
    expect(res.cost).toBeCloseTo(5, 9);
  });
});

describe.each(WIRES)('maxUsd: counted from open, across turns (%s)', (wire) => {
  it('turn two is sent (0.008 spent of 0.01), turn three is not: the count is not reset by a turn', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 8, 'one'), text(wire, 8, 'two'), text(wire, 8, 'three'));
    const s = await r.open({ maxUsd: 0.01 });
    expect((await s.turn('1')).isError).toBeUndefined();
    expect((await s.turn('2')).isError).toBeUndefined();
    const third = await s.turn('3');
    expect(third.isError).toBe(true);
    expect(third.text).toBe(USED_UP);
    expect(sent(r)).toBe(2);
  });

  it('inside one turn the call that would start with it used up is not sent', async () => {
    const r = await make(wire, priced);
    r.push(tool(wire, 12, 0), text(wire, 1));
    const s = await r.open({ maxUsd: 0.01 });
    expect((await s.turn('go')).text).toBe(USED_UP);
    expect(sent(r)).toBe(1);
  });

  it('counts from open, not from the conversation\'s beginning: a resumed session starts at the total it was opened with', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 8, 'before'), text(wire, 8, 'one'), text(wire, 8, 'two'), text(wire, 8, 'three'));
    const first = await r.open();
    await first.turn('before');
    await first.close();
    // The conversation is worth 0.008 and the host says 5 was counted: maxUsd 0.01 counts from that 5.
    const again = await r.open({ sessionId: first.sessionId, costBase: 5, costBaseByModel: { m: 5 }, maxUsd: 0.01 });
    expect((await again.turn('1')).text).toBe('one');   // nothing spent since open
    expect((await again.turn('2')).text).toBe('two');   // 0.008 of 0.01 spent since open
    expect((await again.turn('3')).text).toBe(USED_UP);
    expect(sent(r)).toBe(3);
  });

  it('the smaller of the run\'s room and maxUsd wins', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 8, 'one'), text(wire, 8, 'two'));
    let room = 0.008;
    const s = await r.open({ maxUsd: 0.5, usdRoom: () => room });
    expect((await s.turn('1')).text).toBe('one');   // 0.008 of room: a call is sent
    room = 0;   // the host counted it
    expect((await s.turn('2')).text).toBe(USED_UP);   // maxUsd has 0.492 left, the room has none
    expect(sent(r)).toBe(1);
  });
});

describe.each(WIRES)('unknown is not zero (%s)', (wire) => {
  const L = {
    u: (t: string) => ({ t: 'msg', role: 'user', blocks: [{ type: 'text', text: t }] }),
    a: (t: string) => ({ t: 'msg', role: 'assistant', protocol: wire, blocks: [{ type: 'text', text: t }] }),
    usage: (cost: number) => ({ t: 'usage', model: 'm', input: 60, output: 20, cacheRead: 0, cacheWrite: 0, cost }),
  };
  /** A conversation file in which a line was lost (a bad line between the question and the reply): its total is not known. */
  const lostReply = (r: Rig) => {
    const id = randomUUID();
    fs.mkdirSync(path.join(r.host.home, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(r.host.home, 'conversations', `${id}.jsonl`), [L.u('q1'), 'not json {{{', L.a('a1'), L.usage(0.5), L.u('q2')].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    return id;
  };

  it('a session resumed from a file with a lost reply and a USD run limit refuses the next call, with the spec words', async () => {
    const r = await make(wire, priced);
    const s = await r.open({ sessionId: lostReply(r), usdRoom: () => 100 });
    const res = await s.turn('go');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(0);
    expect(res.total).toBeUndefined();
  });

  it('the same with maxUsd', async () => {
    const r = await make(wire, priced);
    const s = await r.open({ sessionId: lostReply(r), maxUsd: 100 });
    expect((await s.turn('go')).text).toBe(USED_UP);
    expect(sent(r)).toBe(0);
  });

  it('with no USD limit the same file goes on, and its total stays unknown', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 8));
    const res = await (await r.open({ sessionId: lostReply(r) })).turn('go');
    expect(res.isError).toBeUndefined();
    expect(sent(r)).toBe(1);
    expect(res.total).toBeUndefined();
  });

  // Fix round (review blocker 1): a finite costBase does not hide a file whose tail is unknown; with a USD limit the call is refused.
  it('a costBase with a file that lost a line: with a USD limit the call is refused, never judged by the stale base', async () => {
    const r = await make(wire, priced);
    const s = await r.open({ sessionId: lostReply(r), costBase: 1, costBaseByModel: { m: 1 }, usdRoom: () => 100 });
    const res = await s.turn('go');
    expect(res.isError).toBe(true);
    expect(res.budgetStop).toBe(true);
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(0);
    const capped = await (await r.open({ sessionId: lostReply(r), costBase: 1, maxUsd: 100 })).turn('go');
    expect(capped.text).toBe(USED_UP);
  });

  it('a costBase with a file that lost a line and NO limit works as before: the base is kept and counted from', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 8));
    const res = await (await r.open({ sessionId: lostReply(r), costBase: 1, costBaseByModel: { m: 1 } })).turn('go');
    expect(res.isError).toBeUndefined();
    expect(res.total).toBeCloseTo(1.008, 12);
    expect(res.cost).toBeCloseTo(0.008, 12);
  });

  it('an unpriced call makes the total unknown, and the next call under a limit is refused (never counted as 0)', async () => {
    // The catalog knows a price only from the second reply on: the first reply is unpriced, the model is priced when the limit arrives.
    let known = false;
    const r = await make(wire, { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100 }] }, host: { catalogPrice: () => (known ? TOKEN_PRICE : undefined) } });
    r.push(text(wire, 8), text(wire, 8));
    const run: { limit?: number } = {};
    const s = await r.open({ usdRoom: () => run.limit });
    const one = await s.turn('1');   // no limit yet: the unpriced reply is allowed, and its cost is unknown
    expect(one.isError).toBeUndefined();
    expect(one.cost).toBeUndefined();
    known = true;
    run.limit = 100;
    expect((await s.turn('2')).text).toBe(USED_UP);
    expect(sent(r)).toBe(1);
  });

  it('a model with no price cannot hold a USD limit: not sent, with the spec words; a provider default of 0/0 holds it', async () => {
    const none = await make(wire, { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100 }] } });
    const res = await (await none.open({ usdRoom: () => 1 })).turn('go');
    expect(res.isError).toBe(true);
    expect(res.text).toBe('m has no price, so Reins cannot hold the $1 budget. Add a price in Settings > Providers, or remove the budget.');
    expect(sent(none)).toBe(0);

    const free = await make(wire, { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100 }], price: { input: 0, output: 0 } } });
    free.push(text(wire, 8));
    const ok = await (await free.open({ usdRoom: () => 1 })).turn('go');
    expect(ok.isError).toBeUndefined();
    expect(ok.cost).toBe(0);
    expect(sent(free)).toBe(1);
  });

  it('a model with a price of 0/0 of its own holds a budget too', async () => {
    const r = await make(wire, { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: { input: 0, output: 0 } }] } });
    r.push(text(wire, 8));
    expect((await (await r.open({ maxUsd: 1 })).turn('go')).isError).toBeUndefined();
  });
});

describe.each(WIRES)('floating point: the sums of per-call costs carry noise (%s)', (wire) => {
  it('0.7 + 0.1 is 0.7999999999999999: a cap of 0.8 is reached, and the next call is not sent', async () => {
    expect(0.7 + 0.1).toBeLessThan(0.8);   // the premise
    const r = await make(wire, priced);
    r.push(text(wire, 700, 'one'), text(wire, 100, 'two'), text(wire, 1, 'three'));
    const s = await r.open({ maxUsd: 0.8 });
    expect((await s.turn('1')).text).toBe('one');
    expect((await s.turn('2')).text).toBe('two');
    expect((await s.turn('3')).text).toBe(USED_UP);
    expect(sent(r)).toBe(2);
  });

  it('the same inside one turn against the run\'s room', async () => {
    const r = await make(wire, priced);
    r.push(tool(wire, 700, 0), tool(wire, 100, 1), text(wire, 1));
    const s = await r.open({ usdRoom: () => 0.8 });
    const res = await s.turn('go');
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(2);
  });

  it('0.1 + 0.2 against a cap of 0.30000000000000004 and of 0.3: both are reached', async () => {
    for (const cap of [0.1 + 0.2, 0.3]) {
      const r = await make(wire, priced);
      r.push(text(wire, 100, 'one'), text(wire, 200, 'two'), text(wire, 1, 'three'));
      const s = await r.open({ maxUsd: cap });
      await s.turn('1');
      await s.turn('2');
      expect((await s.turn('3')).text).toBe(USED_UP);
      expect(sent(r)).toBe(2);
    }
  });

  it('a real room of a micro-dollar is not swallowed: the cap is 0.8 plus 1e-6 and the call is sent', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 700, 'one'), text(wire, 100, 'two'), text(wire, 1, 'three'));
    const s = await r.open({ maxUsd: 0.8 + 1e-6 });
    await s.turn('1');
    await s.turn('2');
    expect((await s.turn('3')).text).toBe('three');
  });
});

describe('through the HTTP server: the Run pauses on the USD card when the loop stops', () => {
  const FRONT = (usd: number) => `---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20, usd: ${usd} }\nalways: []\n---\n\n`;

  async function boot(wire: WireId = 'openai-chat') {
    const r = await make(wire, priced);
    const home = r.host.home;
    fs.mkdirSync(path.join(home, 'mods', 'p'), { recursive: true });
    fs.writeFileSync(path.join(home, 'mods', 'p', 'mod.json'), JSON.stringify(r.p));
    const store = openStore(':memory:');
    const srv = await startServer({
      store, dir: home, probe: async () => PROBE,
      makeEngine: ({ model, effort, onApprove, onLive, settings }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(settings ? { settings } : {}) }),
    });
    const cwd = tmpDir();
    const made = await request(srv, 'POST', '/api/sessions', { body: { cwd, engine: 'p' } });
    expect(made.status).toBe(200);
    const id = made.json.id as string;
    const answer = async (kind: 'trust' | 'usd', a: string) => {
      const q = await askedQuestion(store, id, kind);
      expect((await request(srv, 'POST', `/api/sessions/${id}/answer`, { body: { questionId: q.id, answer: a } })).status).toBe(200);
    };
    const run = async (usd: number) => {
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, `${FRONT(usd)}## phase go\n> Do it.\n`);
      expect((await request(srv, 'POST', `/api/sessions/${id}/run`, { body: { path: file } })).status).toBe(200);
      await answer('trust', 'y');
    };
    const done = () => until(() => rowsOf(store, id, 'run_finished').length === 1);
    const close = async () => { await srv.close(); store.close(); };
    return { r, store, id, run, answer, done, close };
  }

  it('a call of 0.012 against a workflow of usd 0.01: the second call is not sent, the run pauses on the USD card mid-step, Allow runs the step again', async () => {
    const w = await boot();
    try {
      w.r.push(tool('openai-chat', 12, 0), text('openai-chat', 12, 'REINS: done'));
      await w.run(0.01);
      const q = await askedQuestion(w.store, w.id, 'usd');
      expect(q.kind).toBe('usd');
      expect(sent(w.r)).toBe(1);
      expect(rowsOf(w.store, w.id, 'run_finished')).toEqual([]);
      expect(rowsOf(w.store, w.id, 'turn_failed')).toEqual([]);
      await w.answer('usd', 'allow $1');
      await w.done();
      expect(sent(w.r)).toBe(2);
      // The step ran again with its full text: the second request holds the step's instructions, once more.
      expect(JSON.stringify(w.r.fake.requests[1]!.body.messages)).toContain('Do it.');
    } finally {
      await w.close();
    }
  });

  it('calls of 0.008 against usd 0.01: two are sent, the third is not; the pause comes on the third call, not as a crash', async () => {
    const w = await boot();
    try {
      w.r.push(tool('openai-chat', 8, 0), tool('openai-chat', 8, 1), text('openai-chat', 8, 'REINS: done'));
      await w.run(0.01);
      await askedQuestion(w.store, w.id, 'usd');
      expect(sent(w.r)).toBe(2);
      expect(rowsOf(w.store, w.id, 'turn_failed')).toEqual([]);
      await w.answer('usd', 'allow $1');
      await w.done();
      expect(sent(w.r)).toBe(3);
    } finally {
      await w.close();
    }
  });

  it('a budget with room is not paused', async () => {
    const w = await boot();
    try {
      w.r.push(tool('openai-chat', 8, 0), text('openai-chat', 8, 'REINS: done'));
      await w.run(5);
      await w.done();
      expect(sent(w.r)).toBe(2);
      expect(rowsOf(w.store, w.id, 'question').filter((x) => (x.data as { kind: string }).kind === 'usd')).toEqual([]);
    } finally {
      await w.close();
    }
  });

  // Fix round (review blocker 3): the engine's own refusal (here: a conversation whose spend is unknown) pauses the run on the USD card.
  it('a session whose total is unknown, with a workflow USD budget: the run pauses on the USD card with the engine\'s words; the refusal is no step result', async () => {
    const w = await boot();
    try {
      const sid = randomUUID();
      fs.mkdirSync(path.join(w.r.host.home, 'conversations'), { recursive: true });
      const line = (o: object | string) => (typeof o === 'string' ? o : JSON.stringify(o));
      fs.writeFileSync(path.join(w.r.host.home, 'conversations', `${sid}.jsonl`), [
        { t: 'msg', role: 'user', blocks: [{ type: 'text', text: 'q1' }] }, 'not json {{{',
        { t: 'msg', role: 'assistant', protocol: 'openai-chat', blocks: [{ type: 'text', text: 'a1' }] },
        { t: 'usage', model: 'm', input: 60, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
      ].map(line).join('\n') + '\n');
      w.store.updateSession(w.id, { engineSessionId: sid });
      await w.run(5);
      const q = await askedQuestion(w.store, w.id, 'usd');
      expect((q as { detail?: string }).detail).toContain(USED_UP);
      expect(sent(w.r)).toBe(0);
      expect(rowsOf(w.store, w.id, 'run_finished')).toEqual([]);
      expect(rowsOf(w.store, w.id, 'run_stopped')).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('after the budget pause the engine stays: the conversation goes on in the same session after Allow (its request holds the earlier turn)', async () => {
    const w = await boot();
    try {
      w.r.push(tool('openai-chat', 12, 0), text('openai-chat', 12, 'REINS: done'));
      await w.run(0.01);
      await askedQuestion(w.store, w.id, 'usd');
      expect(w.store.getSession(w.id)!.engineSessionId).toMatch(/^[0-9a-f-]{36}$/);
      await w.answer('usd', 'allow $1');
      await w.done();
      expect(JSON.stringify(w.r.fake.requests[1]!.body.messages)).toContain(MISSING_RESULT);
    } finally {
      await w.close();
    }
  });
});

describe('the real session keeps its engine after a budget stop (fix round, should-fix 1)', () => {
  it('through openSession and the loop engine: no engine death, the id is stored after the first paid reply, the next message goes on', async () => {
    const wire: WireId = 'openai-chat';
    const r = await make(wire, priced);
    r.push(tool(wire, 12, 0), text(wire, 1, 'second turn answer'));
    const store = openStore(':memory:');
    const row = store.createSession({ id: 's1', cwd: tmpDir(), engine: 'p' });
    const room = { v: 0.01 };
    let opened = 0;
    const s = openSession({
      store, dir: r.host.home,
      makeEngine: ({ onApprove, onLive }) => {
        opened++;
        const e = loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0 });
        return { ...e, open: (o) => e.open({ ...o, usdRoom: () => room.v }) };
      },
    }, row, true);
    try {
      s.message('hi');
      await s.idle();
      const log = () => store.readLog('s1');
      expect(log().some((x) => x.type === 'turn_ended')).toBe(true);
      expect(log().filter((x) => x.type === 'note' && JSON.stringify(x.data).includes('dropped'))).toEqual([]);
      expect(JSON.stringify(log().filter((x) => x.type === 'engine'))).not.toContain('"type":"error"');
      expect(store.getSession('s1')!.engineSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent(r)).toBe(1);   // the paid reply; the second call was held
      room.v = 5;
      s.message('again');
      await s.idle();
      expect(opened).toBe(1);
      expect(sent(r)).toBe(2);
      const body = JSON.stringify(r.fake.requests[1]!.body.messages);
      expect(body).toContain('hi');
      expect(body).toContain(MISSING_RESULT);   // the earlier turn's tool round, paired
    } finally {
      store.close();
    }
  });
});

describe.each(WIRES)('reopen: paid calls are not lost (fix round, blocker 1) (%s)', (wire) => {
  /** A conversation that paid 0.09 (three replies of 0.03), closed. */
  const paid = async (r: Rig) => {
    r.push(text(wire, 30, 'a'), text(wire, 30, 'b'), text(wire, 30, 'c'));
    const s = await r.open();
    await s.turn('1');
    await s.turn('2');
    await s.turn('3');
    await s.close();
    return s.sessionId;
  };

  it('Run counted 0.06, the file says 0.09: the next turn\'s cost includes the 0.03, per model too', async () => {
    const r = await make(wire, priced);
    const id = await paid(r);
    r.push(text(wire, 8, 'd'));
    const res = await (await r.open({ sessionId: id, costBase: 0.06, costBaseByModel: { m: 0.06 } })).turn('go');
    expect(res.cost).toBeCloseTo(0.038, 12);
    expect(res.total).toBeCloseTo(0.098, 12);
    expect(res.totals!.m).toBeCloseTo(0.098, 12);
    expect(res.models!.m).toBeCloseTo(0.038, 12);
  });

  it('the room is computed from 0.09, not from the Run\'s 0.06: a room of 0.03 (0.06 of 0.09 counted) has nothing left', async () => {
    const r = await make(wire, priced);
    const id = await paid(r);
    const before = sent(r);
    r.push(text(wire, 8, 'd'));
    const res = await (await r.open({ sessionId: id, costBase: 0.06, costBaseByModel: { m: 0.06 }, usdRoom: () => 0.03 })).turn('go');
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(before);
  });

  it('one call goes with a room of 0.031, then the next is held (a stale base would send many)', async () => {
    const r = await make(wire, priced);
    const id = await paid(r);
    const before = sent(r);
    r.push(tool(wire, 8, 0), tool(wire, 8, 1), text(wire, 8));
    const res = await (await r.open({ sessionId: id, costBase: 0.06, costBaseByModel: { m: 0.06 }, usdRoom: () => 0.031 })).turn('go');
    expect(res.text).toBe(USED_UP);
    expect(sent(r) - before).toBe(1);
  });

  it('a costBase larger than the file is the total', async () => {
    const r = await make(wire, priced);
    const id = await paid(r);
    r.push(text(wire, 8, 'd'));
    const res = await (await r.open({ sessionId: id, costBase: 5, costBaseByModel: { m: 5 } })).turn('go');
    expect(res.total).toBeCloseTo(5.008, 12);
    expect(res.cost).toBeCloseTo(0.008, 12);
  });

  it('no costBase: the file\'s total alone', async () => {
    const r = await make(wire, priced);
    const id = await paid(r);
    r.push(text(wire, 8, 'd'));
    const res = await (await r.open({ sessionId: id })).turn('go');
    expect(res.total).toBeCloseTo(0.098, 12);
  });

  it('a resumed session with costBase 0.05 and maxUsd 0.02 counts from the base: three calls of 0.008 go, the fourth does not', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 30, 'a'));
    const first = await r.open();
    await first.turn('1');
    await first.close();
    const before = sent(r);
    r.push(text(wire, 8, 'x'), text(wire, 8, 'y'), text(wire, 8, 'z'), text(wire, 8, 'w'));
    const s = await r.open({ sessionId: first.sessionId, costBase: 0.05, costBaseByModel: { m: 0.05 }, maxUsd: 0.02 });
    for (const t of ['x', 'y', 'z']) expect((await s.turn(t)).text).toBe(t);
    expect((await s.turn('w')).text).toBe(USED_UP);
    expect(sent(r) - before).toBe(3);
  });
});

describe.each(WIRES)('maxUsd counts from the total the session was opened with, whoever opened it (fix round) (%s)', (wire) => {
  it('a new session given a costBase (no session id) counts from that base too', async () => {
    const r = await make(wire, priced);
    r.push(text(wire, 8, 'x'), text(wire, 8, 'y'), text(wire, 8, 'z'), text(wire, 8, 'w'));
    const s = await r.open({ costBase: 0.05, costBaseByModel: { m: 0.05 }, maxUsd: 0.02 });
    for (const t of ['x', 'y', 'z']) expect((await s.turn(t)).text).toBe(t);
    expect((await s.turn('w')).text).toBe(USED_UP);
    expect(sent(r)).toBe(3);
  });
});

describe.each(WIRES)('prices that are not numbers cannot slip past the guard (fix round, blocker 2) (%s)', (wire) => {
  const bare = { models: [{ id: 'm', context: 1_000_000, maxOutput: 100 }] };

  it('a catalog price with a NaN output is no price: with a limit the call is not sent, with the no-price words', async () => {
    const r = await make(wire, { manifest: bare, host: { catalogPrice: () => ({ input: 1, output: Number.NaN }) } });
    const res = await (await r.open({ usdRoom: () => 1 })).turn('go');
    expect(res.text).toBe('m has no price, so Reins cannot hold the $1 budget. Add a price in Settings > Providers, or remove the budget.');
    expect(res.budgetStop).toBe(true);
    expect(sent(r)).toBe(0);
  });

  it('the same price with no limit: the call goes and its cost is unknown (not NaN)', async () => {
    const r = await make(wire, { manifest: bare, host: { catalogPrice: () => ({ input: 1, output: Number.NaN }) } });
    r.push(text(wire, 8));
    const res = await (await r.open()).turn('go');
    expect(res.isError).toBeUndefined();
    expect(res.cost).toBeUndefined();
    expect(res.total).toBeUndefined();
  });

  it('a provider default price of { input: 0 } with no output is no price', async () => {
    const r = await make(wire, { manifest: { ...bare, price: { input: 0 } as never } });
    expect((await (await r.open({ maxUsd: 1 })).turn('go')).budgetStop).toBe(true);
    expect(sent(r)).toBe(0);
  });

  it('a negative price is no price', async () => {
    const r = await make(wire, { manifest: { ...bare, price: { input: -1, output: 1 } } });
    expect((await (await r.open({ maxUsd: 1 })).turn('go')).budgetStop).toBe(true);
  });

  it('a reply whose cost is not a number (an infinite one) makes the total unknown, and the next call under a limit is refused', async () => {
    const r = await make(wire, { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100, price: { input: 1e308, output: 0 } }] } });
    r.push(text(wire, 10), text(wire, 10));
    const run: { limit?: number } = {};
    const s = await r.open({ usdRoom: () => run.limit });
    const one = await s.turn('1');
    expect(one.total).toBeUndefined();
    expect(one.cost).toBeUndefined();
    run.limit = 1e6;
    const two = await s.turn('2');
    expect(two.text).toBe(USED_UP);
    expect(sent(r)).toBe(1);
  });

  it('a room that is NaN (the host\'s sum went wrong) is held as no room', async () => {
    const r = await make(wire, priced);
    const res = await (await r.open({ usdRoom: () => Number.NaN })).turn('go');
    expect(res.text).toBe(USED_UP);
    expect(sent(r)).toBe(0);
  });

  it('a cap that is NaN is held as no room', async () => {
    const r = await make(wire, priced);
    expect((await (await r.open({ maxUsd: Number.NaN })).turn('go')).text).toBe(USED_UP);
  });
});

describe.each(WIRES)('every request that goes out is judged against the live budget (fix round, should-fix 3) (%s)', (wire) => {
  const fail500 = { status: 500, body: 'boom' };
  /** A room that is there for the first check and gone for the next ones. */
  const goneAfter = (n: number) => { let calls = 0; return () => (++calls <= n ? 1 : 0); };

  it('a 500, the room goes during the backoff: the retry is not sent, the turn stops as a budget stop', async () => {
    const r = await make(wire, priced);
    r.push(fail500, text(wire, 1));
    const res = await (await r.open({ usdRoom: goneAfter(1) })).turn('go');
    expect(sent(r)).toBe(1);
    expect(res.text).toBe(USED_UP);
    expect(res.budgetStop).toBe(true);
    expect(res.events!.some((e) => e.type === 'error')).toBe(false);
  });

  it('the room goes inside the sleep dependency itself (the allowance changed while it waited)', async () => {
    const room = { v: 1 };
    const r = await make(wire, { ...priced, deps: { sleep: async () => { room.v = 0; } } });
    r.push(fail500, text(wire, 1));
    const res = await (await r.open({ usdRoom: () => room.v })).turn('go');
    expect(sent(r)).toBe(1);
    expect(res.text).toBe(USED_UP);
  });

  it('with room still there the retry goes (the check is not a veto)', async () => {
    const r = await make(wire, priced);
    r.push(fail500, text(wire, 1, 'recovered'));
    const res = await (await r.open({ usdRoom: () => 1 })).turn('go');
    expect(res.text).toBe('recovered');
    expect(sent(r)).toBe(2);
  });

  it('the unpaired repair is a request too: not sent when the room is gone', async () => {
    const body = JSON.stringify(wire === 'openai-chat'
      ? { error: { message: "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'." } }
      : { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected tool_use_id toolu_01 found in tool_result blocks' } });
    const r = await make(wire, priced);
    r.push({ status: 400, body }, text(wire, 1));
    const res = await (await r.open({ usdRoom: goneAfter(1) })).turn('go');
    expect(sent(r)).toBe(1);
    expect(res.text).toBe(USED_UP);
    expect(res.budgetStop).toBe(true);
  });

  it('a turn that got no reply leaves no trace: its text is sent again after the stop, once', async () => {
    const room = { v: 1 };
    const r = await make(wire, { ...priced, deps: { sleep: async () => { room.v = 0; } } });
    r.push(fail500, text(wire, 1, 'ok'));
    const s = await r.open({ usdRoom: () => room.v });
    expect((await s.turn('the question')).budgetStop).toBe(true);
    room.v = 1;
    expect((await s.turn('the question')).text).toBe('ok');
    const sentBody = JSON.stringify(r.fake.requests.at(-1)!.body.messages);
    expect(sentBody.split('the question')).toHaveLength(2);
  });
});

describe.each(WIRES)('limits that sit close together (fix round, review mutations) (%s)', (wire) => {
  it('a room of 5e-9 is still room, 5e-10 is not (epsilon 1e-9)', async () => {
    const a = await make(wire, priced);
    a.push(text(wire, 1, 'went'));
    expect((await (await a.open({ usdRoom: () => 5e-9 })).turn('go')).text).toBe('went');
    const b = await make(wire, priced);
    expect((await (await b.open({ usdRoom: () => 5e-10 })).turn('go')).text).toBe(USED_UP);
  });

  it('the no-price message shows the limit to 6 decimals when it needs them', async () => {
    const r = await make(wire, { manifest: { models: [{ id: 'm', context: 1_000_000, maxOutput: 100 }] } });
    const res = await (await r.open({ usdRoom: () => 0.123456 })).turn('go');
    expect(res.text).toBe('m has no price, so Reins cannot hold the $0.123456 budget. Add a price in Settings > Providers, or remove the budget.');
  });

  it('with the call cap and the USD stop both true, the USD words win (spec 4.1 order)', async () => {
    const r = await make(wire, { ...priced, max: 1 });
    r.push(tool(wire, 12, 0), text(wire, 1));
    const res = await (await r.open({ usdRoom: () => 0.01 })).turn('go');
    expect(res.text).toBe(USED_UP);
    expect(res.budgetStop).toBe(true);
  });

  it('the call cap alone still stops with its own words, as an error', async () => {
    const r = await make(wire, { ...priced, max: 1 });
    r.push(tool(wire, 1, 0), text(wire, 1));
    const res = await (await r.open({ usdRoom: () => 100 })).turn('go');
    expect(res.text).toBe('Reins stopped this reply after 1 model calls (the per-reply limit in Settings).');
    expect(res.budgetStop).toBeUndefined();
  });
});
