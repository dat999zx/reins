// Milestone P, Task 15 (spec 6.3, B2): the session hands its engine the run's USD room, read live; with no run it is undefined.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSession } from '../src/session.js';
import { openStore, type LogRow } from '../src/store.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-usd-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

function setup(script: TestTurn[]) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  const seen: LogRow[] = [];
  const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp(), onRow: (r) => seen.push(r) }, row, true);
  const open = () => {
    const l = store.readLog('s1');
    return l.filter((r) => r.type === 'question').map((r) => r.data as { id: string; kind: string })
      .filter((q) => !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
  };
  const question = async (kind: string) => { await until(() => open().some((q) => q.kind === kind)); return open().find((q) => q.kind === kind)!; };
  const start = async (budget: string) => {
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, `---\nreins: 1\nname: w\nbudget: { ${budget} }\nalways: []\n---\n\n## phase one\n> Go.\n\n## phase two\n> Again.\n`);
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await question('trust')).id, 'y');
  };
  return { t, s, start };
}

describe('openEngine passes usdRoom (B2)', () => {
  it('a run with usd 0.10: the opened engine\'s usdRoom is 0.10, then 0.04 after a 0.06 reply; and undefined once the run is over', async () => {
    const x = setup([{ cost: 0.06, hold: true }, { cost: 0.01, hold: true }]);
    await x.start('turns: 10, minutes: 10, usd: 0.10');
    await until(() => x.t.turns.length === 1);
    expect(x.t.opens).toHaveLength(1);
    const room = x.t.opens[0]!.usdRoom;
    expect(room).toBeTypeOf('function');
    expect(room!()).toBe(0.1);
    x.t.release();
    await until(() => x.t.turns.length === 2);
    expect(room!()).toBeCloseTo(0.04, 12);
    x.t.release();
    await x.s.idle();
    expect(room!()).toBeUndefined();   // the run is gone; the engine is the session's again
  });

  it('in plain chat it returns undefined: no limit', async () => {
    const x = setup([{}]);
    x.s.message('hello');
    await x.s.idle();
    expect(x.t.opens[0]!.usdRoom).toBeTypeOf('function');
    expect(x.t.opens[0]!.usdRoom!()).toBeUndefined();
  });

  it('a run with no USD budget: undefined as well', async () => {
    const x = setup([{ hold: true }, {}]);
    await x.start('turns: 10, minutes: 10');
    await until(() => x.t.turns.length === 1);
    expect(x.t.opens[0]!.usdRoom!()).toBeUndefined();
    x.t.release();
    await x.s.idle();
  });

  it('the same engine, plain chat first and then a run: the room follows the run', async () => {
    const x = setup([{}, { cost: 0.03, hold: true }, {}]);
    x.s.message('hello');
    await x.s.idle();
    const room = x.t.opens[0]!.usdRoom!;
    expect(room()).toBeUndefined();
    await x.start('turns: 10, minutes: 10, usd: 0.20');
    await until(() => x.t.turns.length === 2);
    expect(x.t.opens).toHaveLength(1);
    expect(room()).toBe(0.2);
    x.t.release();
    await x.s.idle();
  });
});
