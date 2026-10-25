// M3 group Y: `run`, `verify` and `repeat` move out of core into the default pack. This file runs the three kinds through the REAL loader (`startMods`, a temp home)
// and compares everything they produce with `m3-task-y-pin.expected.json`, which was recorded at HEAD (the commit before the move, where core registered them):
// the parse, the printed file, the diagnostics, the compiled program, the events, the receipt, the commands and the pauses of runs (a scripted engine and a
// scripted command runner), the trust list, the chat tags and the served views.
// To record again (only ever at a commit where the answer is known to be right): `PIN_WRITE=1 npx vitest run --project server packages/server/test/m3-task-y-pin.test.ts`.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProgram, parseWorkflow, printWorkflow, validate } from '@reins/core';
import { startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { buildTagged, tagCatalogue, taggedWorkflow } from '../src/tags.js';
import { commandsOf, hashCommands } from '../src/trust.js';
import { tempHome } from './mods-harness.js';
import { WF, drive, stopDuring } from './m3-task-y-drive.js';

const EXPECTED = new URL('./m3-task-y-pin.expected.json', import.meta.url);
const homes: Array<ReturnType<typeof tempHome>> = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

async function record() {
  const h = tempHome();
  homes.push(h);
  const mods = await startMods({ dir: h.home, env: {} });
  try {
    const parsed = (text: string) => {
      const p = parseWorkflow(text);
      return {
        diagnostics: p.diagnostics, steps: p.workflow?.steps, printed: p.workflow ? printWorkflow(p.workflow) : undefined, validate: p.workflow ? validate(p.workflow) : undefined,
        program: p.workflow ? compileProgram(p.workflow) : undefined,
        commands: p.workflow ? (() => { const c = commandsOf(p.workflow, () => undefined); return { list: c, hash: hashCommands(c) }; })() : undefined,
      };
    };
    const served = servedKinds(mods).kinds;
    const tags = [[{ tag: 'verify' }], [{ tag: 'verify', arg: 'x' }], [{ tag: 'repeat' }], [{ tag: 'repeat', arg: 'tests pass' }], [{ tag: 'repeat', arg: 'tests pass' }, { tag: 'verify' }], [{ tag: 'run' }]];
    return JSON.parse(JSON.stringify({
      parsed: Object.fromEntries(Object.entries(WF).map(([k, v]) => [k, parsed(v)])),
      runs: {
        runFixPass: await drive(WF.runFix!, { cmds: [1, 0] }),
        runFixBudget: await drive(WF.runFix!, { cmds: [1], allow: 1 }),
        runFixHeld: await drive(WF.runFix!, { cmds: [1] }),
        runFailTarget: await drive(WF.runFailTarget!, { cmds: [1] }),
        verifyFailTarget: await drive(WF.verifyFailTarget!, { turns: ['plan', 'REINS: fail: x', 'fixed'] }),
        runOdd: await drive(WF.runOdd!, { cmds: [0] }),
        runNext: await drive(WF.runNext!, { cmds: [1] }),
        repeatTests: await drive(WF.repeatTests!, { cmds: [1, 1, 0] }),
        repeatTestsFirstPass: await drive(WF.repeatTests!, { cmds: [0] }),
        repeatLint: await drive(WF.repeatLint!, { cmds: [1, 0] }),
        repeatOther: await drive(WF.repeatOther!, { cmds: [0, 1, 0, 0] }),
        repeatOtherFailRun: await drive(WF.repeatOther!, { cmds: [1] }),
        repeatLate: await drive(WF.repeatLate!, { cmds: [0] }),
        repeatLateFail: await drive(WF.repeatLate!, { cmds: [1, 0] }),
        repeatNoCmd: await drive(WF.repeatNoCmd!, { cmds: [1, 0] }),
        repeatAgent: await drive(WF.repeatAgent!, { turns: ['a', 'b', 'c\nREINS: done'] }),
        repeatBudgetHeld: await drive(WF.repeatBudget!, { cmds: [1] }),
        repeatBudgetMore: await drive(WF.repeatBudget!, { cmds: [1, 1, 1, 0], allow: 2 }),
        repeatNested: await drive(WF.repeatNested!, { cmds: [1, 0, 0, 1, 0] }),
        repeatNot: await drive(WF.repeatNot!, { cmds: [0, 1] }),
        repeatEmpty: await drive(WF.repeatEmpty!, {}),
        verifyFlow: await drive(WF.verify!, { turns: ['plan', 'REINS: fail: nothing', 'plan again', 'REINS: pass', 'no against', 'checked', 'later'] }),
        verifyBudget: await drive(WF.verify!, { turns: ['plan', 'REINS: fail', 'p', 'REINS: fail', 'p', 'REINS: fail', 'p', 'REINS: pass'], allow: 1 }),
        verifyHeld: await drive(WF.verify!, { turns: ['plan', 'REINS: fail', 'p', 'REINS: fail', 'p', 'REINS: fail'] }),
        verifyDeep: await drive(WF.verifyDeep!, { turns: ['plan', 'REINS: fail: x', 'plan', 'REINS: pass', 'ok\nREINS: done'] }),
      },
      stops: {
        runStopThenSettle: await stopDuring(WF.runFix!, false),
        runSettleThenStop: await stopDuring(WF.runFix!, true),
        repeatStop: await stopDuring(WF.repeatTests!, false),
      },
      tagged: tags.map((t) => buildTagged('hello\nworld', t)),
      taggedWorkflow: [taggedWorkflow('hi', [{ tag: 'repeat', arg: 'tests pass' }]), taggedWorkflow('hi', [{ tag: 'verify' }])],
      catalogue: tagCatalogue(),
      order: served.map((k) => k.kind),
      views: served.filter((k) => ['run', 'verify', 'repeat'].includes(k.kind)),
    }));
  } finally {
    mods.dispose();
  }
}

describe('M3 group Y: run, verify and repeat behave exactly as when core registered them', () => {
  it('the parse, print, diagnostics, program, trust list, runs, receipts, stops, chat tags and served views match the record made at HEAD', async () => {
    const actual = await record();
    if (process.env.PIN_WRITE === '1') {
      fs.writeFileSync(EXPECTED, JSON.stringify(actual, null, 1) + '\n');
      return;
    }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(EXPECTED, 'utf8')));
  }, 60_000);

  it('the recording is not empty (a missing file or an empty pack would pass an empty comparison)', () => {
    const e = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(e.parsed.runFix.program.map((i: { op: string }) => i.op)).toEqual(['RUN', 'END', 'TURN', 'JUMP', 'END']);
    expect(e.parsed.repeatTests.program.map((i: { op: string }) => i.op)).toEqual(['LOOP_IN', 'RUN', 'TURN', 'LOOP_BK', 'END']);
    expect(e.parsed.repeatTests.program[1].onPassJump).toBe(e.parsed.repeatTests.program[1].loopExit);
    expect(e.parsed.verify.program.some((i: { op: string }) => i.op === 'VERIFY')).toBe(true);
    expect(e.parsed.repeatBad.validate.length).toBeGreaterThan(2);
    expect(e.parsed.verifyBad.validate.length).toBeGreaterThan(1);
    expect(e.runs.runFixPass.status).toBe('done');
    expect(e.runs.repeatBudgetHeld.pauses.at(-1)[0].type).toBe('budget-used');
    expect(e.runs.verifyFlow.receipt.verifyResults).toEqual({ passed: 3, failed: 1 });
    expect(e.runs.repeatTests.receipt.loopAttempts).toBeGreaterThan(0);
    expect(e.runs.repeatOther.commands.length).toBeGreaterThan(2);
    expect(e.stops.runStopThenSettle.events.length).toBeGreaterThan(1);
    expect(e.views.map((v: { kind: string }) => v.kind)).toEqual(['run', 'repeat', 'verify']);
    expect(e.parsed.repeatTests.commands.list).toEqual(['npm test', 'tests pass', 'npm test']);
  });
});
