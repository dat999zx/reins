import { describe, it, expect } from 'vitest';
import { FakeEngine, Run } from '../src/index.js';
import { phase, workflow } from './wf3b.js';

// main's fields ARE the Run's own: [main name, Run field, a value, another value]
const policy = (mode: 'write' | 'read') => ({ mode, guards: [], allowShell: true });
const session = (id: string) => ({ sessionId: id }) as any;
const fields: Array<[string, string, unknown, unknown]> = [
  ['pc', 'programCounter', 3, 5],
  ['pause', 'pauseReason', { type: 'stop' }, { type: 'gate' }],
  ['session', 'engineSession', session('a'), session('b')],
  ['turnInFlight', 'turnInFlight', true, false],
  ['turnSession', 'turnSession', session('c'), session('d')],
  ['interruptCard', 'interruptCard', { text: 'x', kind: 'now' }, { text: 'y', kind: 'stop' }],
  ['capped', 'capped', true, false],
  ['handback', 'handback', ['one'], ['two']],
  ['lastTurnText', 'lastTurnText', 'hello', 'bye'],
  ['lastStepId', 'lastStepId', 's1', 's2'],
  ['policy', 'currentPolicy', policy('read'), policy('write')],
  ['recall', 'lastRecallContext', ['m'], ['n']],
];

describe('main track forwards to the Run', () => {
  it.each(fields)('%s: write through main, read the Run; write the Run, read main', (name, field, a, b) => {
    const run = new Run({ workflow: workflow([phase('a')]), engine: new FakeEngine() });
    const r = run as any;
    (run.main as any)[name] = a;
    expect(r[field]).toBe(a);
    expect((run.main as any)[name]).toBe(a);
    r[field] = b;
    expect((run.main as any)[name]).toBe(b);
  });

  it('starts with no tracks and nothing ended', () => {
    const run = new Run({ workflow: workflow([phase('a')]), engine: new FakeEngine() });
    expect(run.tracks.size).toBe(0);
    expect(run.ended).toEqual([]);
    expect(run.main.key).toBe('');
    expect(run.main.state).toBe('running');
  });
});
