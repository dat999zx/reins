// Milestone P, Task 29 phase B3: the cost of an auto-compaction is a debit the session holds until the Run has it. The reply that follows is judged
// with the room that is really left, a reply that fails still leaves the cost with the run, and the stored total moves only when the Run takes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineSession, TurnResult } from '@reins/core';
import { loopEngine } from '../src/loop/engine.js';
import { openSession, type MakeEngine } from '../src/session.js';
import { openStore, type Store } from '../src/store.js';
import { rig, type Rig } from './loop-harness.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29b-')); tmps.push(d); return d; };
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(f: () => boolean) {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

const front = (usd: string) => `---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: ${usd} }\nalways: []\n---\n\n`;
const WORKFLOW = (usd: string) => `${front(usd)}## phase one\n> Go.\n`;

/** The open questions of kind `kind` in the log, and a wait for one. */
const asked = (store: Store, kind: string) => {
  const l = store.readLog('s1');
  return l.filter((r) => r.type === 'question').map((r) => r.data as { id: string; kind: string })
    .filter((q) => q.kind === kind && !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
};
const question = async (store: Store, kind: string) => {
  await until(() => asked(store, kind).length > 0);
  return asked(store, kind)[0]!;
};
/** The run's own record of what it spent: its engine_cost events (they are the receipt's cost), by run. */
const runIdOf = (store: Store) => store.readLog('s1').find((r) => r.type === 'run_started')?.runId;
const runCosts = (store: Store): number[] => {
  const rid = runIdOf(store);
  const events = rid ? store.loadRun(rid)?.snapshot.events ?? [] : [];
  return events.filter((e) => e.type === 'engine_cost').map((e) => (e.data as { usd: number }).usd);
};

// ---- with the scripted engine --------------------------------------------------------------------------------------------------------------
function scripted(script: TestTurn[], o: { origin?: () => string } = {}) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const rooms: Array<number | undefined> = [];
  const hooks = { afterCompact: () => {} };
  const makeEngine: MakeEngine = (e) => {
    const eng = t.makeEngine(e);
    return {
      ...eng,
      open: async (opts) => {
        const s = await eng.open(opts);
        const wrapped: EngineSession = {
          ...s,
          // The room the engine is given, as it reads it when the reply starts.
          turn: (text) => { rooms.push(opts.usdRoom?.()); return s.turn(text); },
          compact: async (): Promise<TurnResult> => { const r = await s.compact!(); hooks.afterCompact(); return r; },
        };
        return wrapped;
      },
    };
  };
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  store.putSetting('autoCompressAt', 0.5);
  const s = openSession({ store, makeEngine, folderTrust: t.folderTrust, dir: tmp(), ...(o.origin ? { origin: o.origin } : {}) }, row, true);
  const go = async (usd: string) => {
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, WORKFLOW(usd));
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await question(store, 'trust')).id, 'y');
  };
  return { store, t, s, rooms, hooks, go, cwd };
}

describe('B3 (a): the reply after an auto-compaction is judged with the room that is really left', () => {
  it('room 0.01 and a compaction of 0.02: the reply is handed a room of -0.01, not 0.01', async () => {
    const x = scripted([{ usage: 600_000 }, { cost: 0.02 }, { cost: 0.02 }]);
    x.s.message('one');
    await x.s.idle();
    await x.go('0.01');
    await until(() => x.t.compacts === 1 && x.rooms.length === 2);
    expect(x.rooms[1]).toBeCloseTo(-0.01, 12);
    await x.s.shutdown();
  });

  it('plain chat has no room at all, compaction or not', async () => {
    const x = scripted([{ usage: 600_000 }, { cost: 0.02 }, {}]);
    x.s.message('one');
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    expect(x.t.compacts).toBe(1);
    expect(x.rooms).toEqual([undefined, undefined]);
  });

  it('once the reply is handed to the run the debit is gone: the next reply sees the run room, with the compaction counted by the run', async () => {
    const x = scripted([{ usage: 600_000 }, { cost: 0.02 }, { cost: 0.02 }, { cost: 0.001 }]);
    x.s.message('one');
    await x.s.idle();
    const file = path.join(x.cwd, 'w.reins.md');
    fs.writeFileSync(file, `${front('1.00')}## phase one\n> Go.\n\n## phase two\n> Again.\n`);
    expect(x.s.runFile(file)).toEqual({ ok: true });
    x.s.answer((await question(x.store, 'trust')).id, 'y');
    await x.s.idle();
    expect(x.rooms).toHaveLength(3);
    expect(x.rooms[1]).toBeCloseTo(0.98, 12); // 1.00 less the compaction, held
    expect(x.rooms[2]).toBeCloseTo(1 - 0.04, 12); // the run holds 0.02 + 0.02 now, and nothing is held twice
  });
});

describe('B3 (b): a reply that fails after a paid compaction leaves the cost with the run', () => {
  it('the cost is an engine_cost row of the run, and the plain unassociated row is not written', async () => {
    const x = scripted([{ usage: 600_000 }, { cost: 0.02 }, { reject: 'the provider fell over' }]);
    x.s.message('one');
    await x.s.idle();
    await x.go('5.00');
    await until(() => runCosts(x.store).length > 0);
    expect(runCosts(x.store)).toEqual([0.02]);
    expect(x.store.readLog('s1').filter((r) => r.type === 'turn_ended' && r.runId === undefined).map((r) => (r.data as { cost?: number }).cost)).toEqual([0.01]); // the first plain reply only
    await x.s.shutdown();
  });

  it('in plain chat there is no run: its own row says it, as before', async () => {
    const x = scripted([{ usage: 600_000 }, { cost: 0.02 }, { reject: 'x' }]);
    x.s.message('one');
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    expect(x.store.readLog('s1').filter((r) => r.type === 'turn_ended').map((r) => (r.data as { cost?: number }).cost)).toEqual([0.01, 0.02]);
    expect(runCosts(x.store)).toEqual([]);
  });
});

describe('B3 (c): the stored total moves only when the run has the compaction', () => {
  it('while the reply after a compaction is still running, the stored total is the one from before the compaction', async () => {
    const x = scripted([{ usage: 600_000, total: 0.5 }, { cost: 0.2, total: 0.7 }, { hold: true, cost: 0.2, total: 0.9 }]);
    x.s.message('one');
    await x.s.idle();
    const sid = x.store.getSession('s1')!.engineSessionId!;
    expect(x.store.getEngineTotal(sid)).toBe(0.5);
    x.s.message('two');
    await until(() => x.t.turns.length === 2);
    expect(x.t.compacts).toBe(1);
    expect(x.store.getEngineTotal(sid)).toBe(0.5); // a restart now finds the compaction in the conversation, not here: the engine charges the difference
    x.t.release();
    await x.s.idle();
    expect(x.store.getEngineTotal(sid)).toBe(0.9);
  });

  it('a reply that fails after the compaction still moves the stored total (the run has the cost with the error)', async () => {
    const x = scripted([{ usage: 600_000, total: 0.5 }, { cost: 0.2, total: 0.7 }, { reject: 'x' }]);
    x.s.message('one');
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    expect(x.store.getEngineTotal(x.store.getSession('s1')!.engineSessionId!)).toBe(0.7);
  });

  it('a Stop right after the compaction hands the cost over and moves the stored total', async () => {
    const x = scripted([{ usage: 600_000, total: 0.5 }, { cost: 0.2, total: 0.7 }, {}]);
    x.s.message('one');
    await x.s.idle();
    x.hooks.afterCompact = () => { void x.s.card('', 'stop'); };
    x.s.message('two');
    await x.s.idle();
    expect(x.t.turns).toEqual(['one']);
    expect(x.store.getEngineTotal(x.store.getSession('s1')!.engineSessionId!)).toBe(0.7);
  });

  it('a reply on a NEW engine (the old one was retired between the two) is not charged the compaction twice', async () => {
    let origin = 'a';
    const x = scripted([{ usage: 600_000, total: 0.5 }, { cost: 0.2, total: 0.7 }, { cost: 0.3, total: 1.0 }], { origin: () => origin });
    x.s.message('one');
    await x.s.idle();
    x.hooks.afterCompact = () => { origin = 'b'; };
    x.s.message('two');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    // The new engine's base is the stored total from before the compaction, so its reply already holds the compaction: 0.3, not 0.5.
    expect(x.store.readLog('s1').filter((r) => r.type === 'turn_ended').map((r) => (r.data as { cost?: number }).cost)).toEqual([0.01, 0.3]);
  });
});

// ---- with the loop engine, Codex's numbers -------------------------------------------------------------------------------------------------
const PRICE = { input: 1000, output: 1000 }; // a call of 20 tokens costs 0.02
const para = (tag: string, n = 900) => `${tag} ${'w'.repeat(n)}`;
const loopSession = async (usd: string) => {
  const r = await rig('openai-chat', { manifest: { models: [{ id: 'm', context: 1000, maxOutput: 100, price: PRICE }] } });
  rigs.push(r);
  const store = openStore(':memory:');
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'p' });
  store.putSetting('autoCompressAt', 0.5);
  const s = openSession({
    store, dir: r.host.home,
    makeEngine: ({ onApprove, onLive }) => loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive }, { sleep: async () => {}, random: () => 0 }),
  }, row, true);
  const use = (n: number, out = 5) => ({ prompt_tokens: n, completion_tokens: out });
  // Two plain replies that leave the context at 600 of 1000 tokens, so the next reply compresses first.
  r.push({ text: para('A1'), usage: use(600) }, { text: para('A2'), usage: use(600) });
  s.message(para('Q1'));
  await s.idle();
  s.message(para('Q2'));
  await s.idle();
  const before = r.fake.requests.length;
  const file = path.join(cwd, 'w.reins.md');
  fs.writeFileSync(file, WORKFLOW(usd));
  const start = async () => {
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await question(store, 'trust')).id, 'y');
  };
  return { r, store, s, start, before, use };
};
const spentOnRun = (store: Store) => runCosts(store).reduce((a, usd) => a + usd, 0);

describe('B3 with the loop engine (Codex 7): $0.01 room, $0.02 calls', () => {
  it('the compaction runs (the one overrun) and the reply is refused, not sent: $0.02 spent, not $0.04', async () => {
    const x = await loopSession('0.01');
    x.r.push({ text: 'SUMMARY', usage: x.use(20, 0) }, { text: 'the reply', usage: x.use(20, 0) });
    await x.start();
    await question(x.store, 'usd');
    expect(x.r.fake.requests.length - x.before).toBe(1); // the summary only
    expect(spentOnRun(x.store)).toBeCloseTo(0.02, 12);
    await x.s.shutdown();
  });

  it('a reply that fails after the compaction: the 0.02 of the compaction is still the run\'s', async () => {
    const x = await loopSession('5.00');
    x.r.push({ text: 'SUMMARY', usage: x.use(20, 0) }, { status: 500, body: 'a' }, { status: 500, body: 'b' }, { status: 500, body: 'c' }, { status: 500, body: 'd' });
    await x.start();
    await until(() => runCosts(x.store).length > 0);
    expect(spentOnRun(x.store)).toBeCloseTo(0.02, 12);
    await x.s.shutdown();
  });
});
