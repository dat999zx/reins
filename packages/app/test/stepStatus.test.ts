import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import type { LogRow } from '@reins/server/store.js';
import { runRows, stepStatus } from '../src/stepStatus.js';

let seq = 0;
const row = (type: string, data?: unknown, runId = 'r1'): LogRow => ({
  sessionId: 's1', seq: ++seq, ts: 1000 + seq, type, data, ...(runId ? { runId } : {}),
});
const plain = (type: string, data?: unknown): LogRow => row(type, data, '');
const refusal = (runId?: string) => row('engine', { type: 'refusal', reason: 'no' }, runId ?? 'r1');
const info = (o: object = {}) => ({ refusals: 0, cost: 0, ...o });

describe('stepStatus', () => {
  it('1. a turn ends done with its cost, the next turn is active', () => {
    expect(stepStatus([row('turn_started', { step: 'a' }), row('turn_ended', { step: 'a', cost: 0.01 }), row('turn_started', { step: 'b' })]))
      .toEqual({ a: info({ state: 'done', cost: 0.01 }), b: info({ state: 'active' }) });
  });

  it('2. a gate waits until it is approved', () => {
    const paused = [row('turn_started', { step: 'p' }), row('turn_ended', { step: 'p' }), row('gate_paused', { step: 'g' })];
    expect(stepStatus(paused).g).toEqual(info({ state: 'waiting' }));
    expect(stepStatus([...paused, row('gate_approved')]).g).toEqual(info({ state: 'done' }));
  });

  it('3. gate "request changes" re-runs the gate step and it goes back to waiting; approve then finishes it', () => {
    const rows = [row('gate_paused', { step: 'g' }), row('turn_started', { step: 'g' }), row('turn_ended', { step: 'g' })];
    expect(stepStatus(rows)).toEqual({ g: info({ state: 'waiting' }) });
    expect(stepStatus([...rows, row('gate_approved')])).toEqual({ g: info({ state: 'done' }) });
  });

  it('4. gate "stop" leaves the gate with no state', () => {
    const m = stepStatus([row('gate_paused', { step: 'g' }), row('run_stopped')]);
    expect(m).toEqual({ g: info() });
    expect('state' in m.g!).toBe(false);
  });

  it('5. a loop shows its attempts, gets stuck, and is active again after run_resumed', () => {
    const it2 = row('loop_iteration', { step: 'l', attempts: 2 });
    expect(stepStatus([it2])).toEqual({ l: info({ attempts: 2 }) });
    const stuck = [it2, row('loop_budget_exceeded', { step: 'l', attempts: 2, max: 2 })];
    expect(stepStatus(stuck).l).toEqual(info({ attempts: 2, state: 'stuck' }));
    expect(stepStatus([...stuck, row('run_resumed')]).l).toEqual(info({ attempts: 2, state: 'active' }));
  });

  it('6. a blocked agent waits and is active again after run_resumed', () => {
    const rows = [row('turn_started', { step: 'b' }), row('question', { id: 'q', kind: 'resume' })];
    expect(stepStatus(rows).b).toEqual(info({ state: 'waiting' }));
    expect(stepStatus([...rows, row('run_resumed')]).b).toEqual(info({ state: 'active' }));
  });

  it('run_resumed keeps the gate step waiting', () => {
    const m = stepStatus([row('gate_paused', { step: 'g' }), row('turn_started', { step: 'x' }), row('question', { kind: 'resume' }), row('run_resumed')]);
    expect(m.g!.state).toBe('waiting');
    expect(m.x!.state).toBe('active');
  });

  it('7. refusals count on the step of the latest turn_started; one before any turn is ignored', () => {
    const m = stepStatus([refusal(), row('turn_started', { step: 'b' }), refusal(), refusal()]);
    expect(m).toEqual({ b: info({ state: 'active', refusals: 2 }) });
  });

  it('8. run_finished finishes the active step; run_detached clears active and keeps waiting', () => {
    const rows = [row('gate_paused', { step: 'g' }), row('turn_started', { step: 'a' })];
    expect(stepStatus([...rows, row('run_finished')]).a!.state).toBe('done');
    const m = stepStatus([...rows, row('run_detached')]);
    expect(m.g!.state).toBe('waiting');
    expect('state' in m.a!).toBe(false);
  });

  it('a started turn leaves a waiting step alone but finishes an active one', () => {
    const m = stepStatus([row('turn_started', { step: 'a' }), row('gate_paused', { step: 'g' }), row('turn_started', { step: 'b' })]);
    expect(m.a!.state).toBe('done');
    expect(m.g!.state).toBe('waiting');
  });

  it('10. unknown types and missing data do not throw', () => {
    const rows = [row('whatever', { x: 1 }), row('turn_started'), row('turn_ended'), row('gate_paused'), row('loop_iteration'),
      row('loop_budget_exceeded'), row('question'), row('engine'), row('run_paused'), row('gate_approved'), row('run_resumed')];
    expect(() => stepStatus(rows)).not.toThrow();
    expect(() => stepStatus([{ sessionId: 's', seq: 1, ts: 1, type: 'turn_started', data: null } as LogRow])).not.toThrow();
  });

  it('11. a real run log with a gate (request changes, then approve) and a verify', () => {
    const rows = JSON.parse(fs.readFileSync(new URL('./fixtures/run-with-gate.json', import.meta.url), 'utf8')) as LogRow[];
    const run = runRows(rows);
    expect(run.workflow).toBe('gated');
    expect(run.live).toBe(false);
    const done = (cost: number) => info({ state: 'done', cost });
    expect(stepStatus(run.rows)).toEqual({
      plan: done(0.0640898), 'gate-1': done(0.0640898), build: done(0.0640898), 'verify-1': done(0.0640898),
    });
  });
});

const ss = (step: string, parents: string[] = []) => row('step_started', { step, parents });
const ts = (step: string) => row('turn_started', { step });
const te = (step: string) => row('turn_ended', { step });
const cr = (step: string, exitCode: number) => row('command_result', { step, exitCode });

describe('stepStatus with step_started (v2)', () => {
  it('a run step after a phase: the phase is done and the run step is active', () => {
    const m = stepStatus([ss('plan'), ts('plan'), te('plan'), ss('run-1')]);
    expect(m.plan!.state).toBe('done');
    expect(m['run-1']!.state).toBe('active');
  });

  it('a container stays active while its kids start; the next top-level step finishes them', () => {
    const rows = [ss('repeat-1'), ss('a', ['repeat-1']), ts('a'), te('a'), ss('b', ['repeat-1'])];
    const m = stepStatus(rows);
    expect(m['repeat-1']!.state).toBe('active');
    expect(m.a!.state).toBe('done');
    expect(m.b!.state).toBe('active');
    const after = stepStatus([...rows, ss('ship')]);
    expect(after['repeat-1']!.state).toBe('done');
    expect(after.b!.state).toBe('done');
    expect(after.ship!.state).toBe('active');
  });

  it('turn_started after its own start changes no other step; a waiting parent stays waiting', () => {
    const m = stepStatus([ss('p'), ss('k', ['p']), ts('k')]);
    expect(m.p!.state).toBe('active');
    expect(m.k!.state).toBe('active');
    const waits = stepStatus([ss('p'), row('gate_paused', { step: 'p' }), ss('k', ['p'])]);
    expect(waits.p!.state).toBe('waiting');
    expect(waits.k!.state).toBe('active');
  });

  it('a gate that asks for changes goes back to waiting', () => {
    const m = stepStatus([ss('g'), row('gate_paused', { step: 'g' }), ts('g'), te('g')]);
    expect(m.g!.state).toBe('waiting');
  });

  it('a failed run step stays failed through the next start and is active again when it re-runs', () => {
    const failed = [ss('run-1'), cr('run-1', 1)];
    expect(stepStatus(failed)['run-1']).toEqual(info({ state: 'failed', why: 'exit 1' }));
    expect(stepStatus([...failed, ss('fix')])['run-1']).toEqual(info({ state: 'failed', why: 'exit 1' }));
    expect(stepStatus([...failed, ss('fix'), ss('run-1')])['run-1']!.state).toBe('active');
    expect(stepStatus([ss('run-1'), cr('run-1', 0)])['run-1']!.state).toBe('active');
  });

  it('a failed verify is failed (verify); a passed one changes nothing', () => {
    const v = [ss('verify-1'), ts('verify-1'), te('verify-1')];
    expect(stepStatus([...v, row('verify_result', { pass: false })])['verify-1']).toEqual(info({ state: 'failed', why: 'verify' }));
    expect(stepStatus([...v, row('verify_result', { pass: true })])['verify-1']!.state).toBe('done');
  });

  it('a log without step_started folds as before; v2 is per fold', () => {
    const old = [row('turn_started', { step: 'a' }, 'B'), row('turn_ended', { step: 'a' }, 'B'), row('turn_started', { step: 'b' }, 'B')];
    const v2 = [ss('x'), ts('x')].map((r) => ({ ...r, runId: 'A' }));
    const both = runRows([...v2, ...old]);
    expect(both.rows).toEqual(old);
    expect(stepStatus(both.rows)).toEqual(stepStatus(old));
    expect(stepStatus(old)).toEqual({ a: info({ state: 'done' }), b: info({ state: 'active' }) });
  });
});

describe('runRows', () => {
  it('9a. one run is live until run_finished or run_stopped', () => {
    const start = [row('run_started', { workflow: 'w' }), row('turn_started', { step: 'a' })];
    expect(runRows(start).live).toBe(true);
    expect(runRows([...start, row('run_finished')]).live).toBe(false);
    expect(runRows([...start, row('run_stopped')]).live).toBe(false);
  });

  it('9b. detach then resume (same runId) is live again', () => {
    const rows = [row('run_started', { workflow: 'w' }), row('run_detached')];
    expect(runRows(rows).live).toBe(false);
    expect(runRows([...rows, row('run_resumed'), row('turn_started', { step: 'a' })]).live).toBe(true);
  });

  it('9c. the newest run is the one of the last row with a runId, even if an older run gets more rows', () => {
    const a1 = row('run_started', { workflow: 'A' }, 'A');
    const b1 = row('run_started', { workflow: 'B' }, 'B');
    const a2 = row('run_resumed', {}, 'A');
    const r = runRows([a1, b1, a2]);
    expect(r.rows).toEqual([a1, a2]);
    expect(r.workflow).toBe('A');
  });

  it('9d. a plain-chat refusal with no runId is not in rows', () => {
    const start = row('run_started', { workflow: 'w' });
    const fin = row('run_finished');
    expect(runRows([start, fin, plain('engine', { type: 'refusal' })]).rows).toEqual([start, fin]);
  });

  it('9e. no rows, or no row with a runId, is empty and not live', () => {
    expect(runRows([])).toEqual({ rows: [], live: false });
    expect(runRows([plain('message', { text: 'hi' })])).toEqual({ rows: [], live: false });
  });

  it('9f. the workflow name comes from run_started, and is undefined for a resumed run without one', () => {
    expect(runRows([row('run_started', { workflow: 'w' })]).workflow).toBe('w');
    expect(runRows([row('run_resumed')]).workflow).toBeUndefined();
  });
});
