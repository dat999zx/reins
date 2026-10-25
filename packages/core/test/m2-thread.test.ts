import { describe, it, expect } from 'vitest';
import { FakeEngine, Run } from '../src/index.js';
import type { Track } from '../src/run.js';
import { phase, step, workflow } from './wf3b.js';

// Task 5 threads the track through every run method. No second track can exist yet, so these hand a plain
// stub Track to the private methods and check that each reads and writes the stub, never the main line.
const stub = (over: Partial<Track> = {}): Track => ({
  key: 'b', title: 'B', pc: 0, state: 'running', turnInFlight: false, capped: false, handback: [],
  policy: { mode: 'write', guards: [], allowShell: true }, recall: [], ...over,
}) as Track;
const make = () => new Run({ workflow: workflow([phase('a')]), engine: new FakeEngine() });

describe('the track is threaded through the run', () => {
  it('logEvent: the main line row is as it was; another track adds its key', () => {
    const run = make() as any;
    run.logEvent('hook', { x: 1 }, run.main);
    run.logEvent('hook', { x: 2 }, stub());
    const [m, o] = run.getEvents().slice(-2);
    expect(m.data).toEqual({ x: 1 });
    expect(o.data).toEqual({ x: 2, track: 'b' });
  });

  it('execCtx.log: a step run by another track logs with its own track key', () => {
    const run = make() as any;
    run.execCtx(stub(), 's').log('hook', { x: 3 });
    run.execCtx(run.main, 's').log('hook', { x: 4 });
    const [o, m] = run.getEvents().slice(-2);
    expect(o.data).toEqual({ x: 3, track: 'b' });
    expect(m.data).toEqual({ x: 4 });
  });

  it('alive and vm.running: the run is going and the track is', () => {
    const run = make() as any;
    const b = stub();
    expect(run.alive(run.main)).toBe(true);
    expect(run.vm(b).running()).toBe(true);
    b.state = 'paused';
    expect(run.vm(b).running()).toBe(false);
    expect(run.vm(run.main).running()).toBe(true);
    b.state = 'running';
    run.status = 'stopped';
    expect(run.vm(b).running()).toBe(false);
    expect(run.vm(run.main).running()).toBe(false);
  });

  it('vm(t): at, next, goto, recall and pause work on the track, not the main line', () => {
    const run = make() as any;
    const b = stub({ pc: 4 });
    const vm = run.vm(b);
    expect(vm.at).toBe(4);
    vm.next();
    expect(b.pc).toBe(5);
    vm.goto(2);
    expect(b.pc).toBe(2);
    vm.setRecall(['m']);
    expect(b.recall).toEqual(['m']);
    expect(run.main.recall).toEqual([]);
    expect(run.main.pc).toBe(0);
    vm.pause({ type: 'stop', text: 'x' });
    expect(b.state).toBe('paused');
    expect(b.pause).toEqual({ type: 'stop', text: 'x' });
    expect(run.status).toBe('running');
    expect(run.pauseReason).toBeUndefined();
  });

  it('pauseTrack on the main line writes the run status and reason; vm(main).at reads the main counter', () => {
    const run = make() as any;
    run.main.pc = 3;
    expect(run.vm(run.main).at).toBe(3);
    run.vm(run.main).pause({ type: 'gate' });
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'gate' });
  });

  it('pauseForStop pauses the track it is given and logs on it', () => {
    const run = make() as any;
    const b = stub();
    run.pauseForStop(b, 'hold', 's');
    expect(b.pause).toEqual({ type: 'stop', text: 'hold', stepId: 's' });
    expect(run.status).toBe('running');
    expect(run.getEvents().at(-1).data.track).toBe('b');
  });

  it('countCost: only the main line writes the engine totals', () => {
    const run = make() as any;
    const r = { text: 't', cost: 0.01, total: 5, totals: { m: 5 } };
    run.countCost(r, undefined, stub());
    expect(run.lastTotal).toBeUndefined();
    expect(run.lastTotals).toBeUndefined();
    expect(run.runCost).toBeCloseTo(0.01, 12);
    run.countCost(r, undefined, run.main);
    expect(run.lastTotal).toBe(5);
    expect(run.lastTotals).toEqual({ m: 5 });
  });

  it('evalCtx(t): the last reply and the op at the counter are the track\'s', () => {
    const run = new Run({ workflow: workflow([phase('a'), step('r', 'run', { cmd: 'x' } as any)]), engine: new FakeEngine() }) as any;
    const at = run.program.findIndex((i: any) => i.op === 'RUN');
    expect(at).toBeGreaterThan(0);
    const b = stub({ pc: at, lastTurnText: 'from b' });
    run.main.lastTurnText = 'from main';
    expect(run.evalCtx(b).lastTurnText).toBe('from b');
    expect(run.evalCtx(b).atRun).toBe(true);
    expect(run.evalCtx(run.main).lastTurnText).toBe('from main');
    expect(run.evalCtx(run.main).atRun).toBe(false);
    run.evalCtx(b).logEvent('hook', {});
    expect(run.getEvents().at(-1).data.track).toBe('b');
  });

  it('handedTurn: the handback and the capped flag are the track\'s', async () => {
    const run = make() as any;
    const b = stub({ handback: ['one'] });
    run.main.handback = ['main one'];
    run.main.capped = true;
    const seen: string[][] = [];
    await run.handedTurn(b, { sessionId: 's', turn: async () => ({ text: 'ok' }), interrupt: async () => {}, close: async () => {} }, 'a', (h: string[]) => { seen.push(h); return 'go'; });
    expect(seen).toEqual([['one']]);
    expect(b.handback).toEqual([]);
    expect(run.main.handback).toEqual(['main one']);
    expect(run.main.capped).toBe(true);
    // a capped turn on the track keeps the track's results, whatever the main line says
    run.main.capped = false;
    b.handback = ['two'];
    const capped = { sessionId: 's', turn: async () => ({ text: '', isError: true, budgetStop: true }), interrupt: async () => {}, close: async () => {} };
    run.workflow.budget.usd = 0.5;
    run.runCost = 1;
    await run.handedTurn(b, capped, 'a', () => 'go');
    expect(b.capped).toBe(true);
    expect(b.handback).toEqual(['two']);
    expect(run.main.capped).toBe(false);
  });

  it('takeLink pauses the track it is given', () => {
    const run = make() as any;
    const b = stub();
    expect(run.takeLink('k', 1, 1, b)).toBe(true);
    expect(run.takeLink('k', 1, 1, b)).toBe(false);
    expect(b.state).toBe('paused');
    expect(b.pause?.type).toBe('link-budget-used');
    expect(run.status).toBe('running');
    expect(run.getEvents().at(-1).data.track).toBe('b');
  });
});
