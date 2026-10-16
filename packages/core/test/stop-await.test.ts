// Characterization of cd6e958 (M1 task 5): run.stop() while one await of a step is out, then the await is released.
import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { Run } from '../src/run.js';
import { harness, type HoldName } from './m1-harness.js';

const wf = (body: string) => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};

/** Runs the first step of `body` until it awaits `name`, stops the run, releases the await and lets the step finish. */
async function stopDuring(id: string, body: string, name: HoldName) {
  const h = harness(id);
  const stored: string[] = [];
  const hold = h.hold(name);
  const run = new Run({
    workflow: wf(body), engine: h.engine, now: h.now, judge: h.judge, commandRunner: h.commandRunner, recall: h.recall,
    store: async (what, summary) => { await h.store(what, summary); stored.push(what); },
  });
  const p = run.step();
  await hold.started;
  await run.stop();
  hold.release();
  const returned = await p;
  const out = {
    returned, status: run.status, pauseReason: run.pauseReason, programCounter: run.snapshot().programCounter,
    events: run.getEvents().map((e) => e.type), receivedTexts: h.engine.receivedTexts.length, stored,
  };
  return out;
}

describe('a stop during each await of a step', () => {
  const stopped = { returned: 'stopped', status: 'stopped', pauseReason: undefined };

  // KEEP-AS-IS: no status check after this await today (spec 4.8)
  it('RUN command: the result is recorded and the program counter moves on', async () => {
    expect(await stopDuring('A1', '## run `echo hi`', 'command')).toEqual({
      ...stopped, programCounter: 1, receivedTexts: 0, stored: [],
      events: ['run_started', 'step_started', 'run_stopped', 'command_result'],
    });
  });

  // KEEP-AS-IS: no status check after this await today (spec 4.8)
  it('STORE ensureSession: the turn is still sent, then runTurn sees the stop and the step stays put', async () => {
    expect(await stopDuring('A2', '## store\nknowl: decision', 'open')).toEqual({
      ...stopped, programCounter: 0, receivedTexts: 1, stored: [],
      events: ['run_started', 'step_started', 'run_stopped', 'turn_started', 'turn_ended'],
    });
  });

  // KEEP-AS-IS: no status check after this await today (spec 4.8)
  it('STORE storeFn: the store is still written and the program counter moves on', async () => {
    expect(await stopDuring('A3', '## store\nknowl: decision', 'store')).toEqual({
      ...stopped, programCounter: 1, receivedTexts: 1, stored: ['decision'],
      events: ['run_started', 'step_started', 'turn_started', 'turn_ended', 'run_stopped', 'store'],
    });
  });

  // KEEP-AS-IS: no status check after this await today (spec 4.8)
  it('VERIFY ensureSession: the turn is still sent, then runTurn sees the stop and the step stays put', async () => {
    expect(await stopDuring('A4', '## verify\nagainst: plan', 'open')).toEqual({
      ...stopped, programCounter: 0, receivedTexts: 1, stored: [],
      events: ['run_started', 'step_started', 'run_stopped', 'turn_started', 'turn_ended'],
    });
  });

  // The real handling: runTurn logs turn_ended, sees status stopped (run.ts ~609) and returns undefined, so VERIFY returns without a verify_result or a program counter move.
  it('VERIFY turn: turn_ended is logged, no verify_result, the step stays put', async () => {
    expect(await stopDuring('A5', '## verify\nagainst: plan', 'turn')).toEqual({
      ...stopped, programCounter: 0, receivedTexts: 1, stored: [],
      events: ['run_started', 'step_started', 'turn_started', 'run_stopped', 'turn_ended'],
    });
  });

  // KEEP-AS-IS: no status check after this await today (spec 4.8)
  it('RECALL recall: the recall event is logged and the program counter moves on', async () => {
    expect(await stopDuring('A6', '## recall\nknowl: upload', 'recall')).toEqual({
      ...stopped, programCounter: 1, receivedTexts: 0, stored: [],
      events: ['run_started', 'step_started', 'run_stopped', 'recall'],
    });
  });
});
