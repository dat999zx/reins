// The run store (plan 15b 2.5): node:sqlite, runs + append-only events.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Run, FakeEngine, parseWorkflow } from '@reins/core';
import { openStore } from '../src/store.js';

const WF = parseWorkflow('---\nreins: 1\nname: s\nbudget: { turns: 9, minutes: 9 }\n---\n\n## phase one\n> a\n\n## gate\nuntil: you approve\n\n## phase two\n> b\n').workflow!;

describe('store', () => {
  it('round-trips a run: events and the snapshot survive a reopen, and restore resumes', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-store-')), 'sub', 'reins.db');
    const store = openStore(file);
    store.createRun({ id: 'r1', workflowPath: '/w.reins.md', cwd: '/repo' });
    const eng = new FakeEngine();
    // Not const: onEvent fires inside the constructor, before `run` is assigned.
    let run: Run | undefined = undefined;
    run = new Run({ workflow: WF, engine: eng, onEvent: (e) => { store.appendEvent('r1', e); if (run) store.saveSnapshot('r1', run.snapshot()); } });
    while (run.status === 'running') await run.step();
    store.saveSnapshot('r1', run.snapshot());
    const before = run.snapshot();
    store.close();

    const again = openStore(file);
    const loaded = again.loadRun('r1')!;
    expect(loaded.workflowPath).toBe('/w.reins.md');
    expect(loaded.cwd).toBe('/repo');
    expect(loaded.snapshot).toEqual(before);
    expect(loaded.snapshot.sessionId).toBe(before.sessionId);

    const restored = Run.restore(loaded.snapshot, { engine: eng });
    restored.approve();
    while (restored.status === 'running') await restored.step();
    expect(restored.status).toBe('done');
    expect(eng.receivedTexts.at(-1)).toContain('b');
    expect(again.loadRun('nope')).toBeUndefined();
    again.close();
  });

  it('events are append-only: the same event id cannot be written twice', () => {
    const store = openStore(':memory:');
    store.createRun({ id: 'r', workflowPath: 'w', cwd: 'c' });
    const ev = { id: 'ev-1', timestamp: 1, type: 'run_started' as const, data: {} };
    store.appendEvent('r', ev);
    expect(() => store.appendEvent('r', ev)).toThrow();
    store.close();
  });
});
