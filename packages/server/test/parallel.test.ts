import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { capWords, checkBody, folderGone, parallelSeam, runOfSession, spentOf, usdOf } from '../src/parallel.js';

const abs = (...p: string[]) => path.resolve(os.tmpdir(), 'reins-par-test', ...p);

const withRun = (capUsd?: number) => {
  const store = openStore(':memory:');
  store.createParallel({ id: 'r1', title: 'My run', ...(capUsd !== undefined ? { capUsd } : {}), tasks: [{ name: 'a', sessionId: 's1' }, { name: 'b', sessionId: 's2' }] });
  return store;
};
const cost = (store: ReturnType<typeof openStore>, id: string, c: number) => store.appendLog(id, { type: 'turn_ended', data: { cost: c } });

describe('spentOf', () => {
  it('sums turn_ended costs and flags an unknown one', () => {
    const store = openStore(':memory:');
    const rows = [cost(store, 'x', 2.4), cost(store, 'x', 1.5), cost(store, 'x', 1.1)];
    const r = spentOf(rows);
    expect(r.usd).toBeCloseTo(5.0, 9);
    expect(r.unknown).toBe(false);
    expect(spentOf([...rows, store.appendLog('x', { type: 'turn_ended', data: {} })]).unknown).toBe(true);
    expect(spentOf([store.appendLog('x', { type: 'engine_cost', data: { unknown: true } })]).unknown).toBe(true);
  });
});

describe('capWords and the seam', () => {
  it('undefined under the cap, the exact words at the cap, undefined with no cap or no run', () => {
    const store = withRun(5);
    cost(store, 's1', 2.4); cost(store, 's2', 1.5);
    expect(capWords(store, 's1')).toBeUndefined();
    cost(store, 's2', 1.1);
    const words = 'The parallel run "My run" has spent $5.00 of its $5.00 cap, so no new model call starts. Raise the cap in the rail, then Resume.';
    expect(capWords(store, 's1')).toBe(words);
    expect(capWords(store, 's2')).toBe(words);
    expect(capWords(store, 'other')).toBeUndefined();
    const seam = parallelSeam(store);
    expect(seam.fenced('s1')).toBe(true);
    expect(seam.fenced('other')).toBe(false);
    expect(seam.capWords('s2')).toBe(words);
    expect(runOfSession(store, 's2')?.id).toBe('r1');
    store.setParallelCap('r1', null);
    expect(capWords(store, 's1')).toBeUndefined();
  });
});

describe('checkBody', () => {
  const repo = abs('repo');
  const ok = () => ({ title: 'T', repo, capUsd: 3, tasks: [{ name: 'a', dir: abs('wt', 'a') }, { name: 'b', dir: abs('wt', 'b') }] });
  it('accepts a valid body', () => {
    expect(checkBody(ok())).toEqual({ value: { title: 'T', repo, capUsd: 3, tasks: ok().tasks } });
    const { capUsd: _c, ...noCap } = ok();
    const r = checkBody(noCap);
    expect('value' in r && r.value).not.toHaveProperty('capUsd');
  });
  it('refuses each bad shape', () => {
    const bad = (patch: Record<string, unknown>) => expect(checkBody({ ...ok(), ...patch })).toHaveProperty('error');
    expect(checkBody(null)).toHaveProperty('error');
    bad({ title: '' }); bad({ title: 3 });
    bad({ repo: 'rel/repo' }); bad({ repo: undefined });
    bad({ capUsd: 0 }); bad({ capUsd: -1 }); bad({ capUsd: Number.NaN }); bad({ capUsd: '5' });
    bad({ tasks: [] }); bad({ tasks: 'x' });
    bad({ tasks: [{ name: '', dir: abs('wt', 'a') }] });
    bad({ tasks: [{ name: 'a', dir: 'rel' }] });
    bad({ tasks: [{ name: 'a', dir: abs('wt', 'a') }, { name: 'a', dir: abs('wt', 'b') }] });
    bad({ tasks: [{ name: 'a', dir: abs('wt', 'a') }, { name: 'b', dir: abs('wt', 'a') }] });
    bad({ tasks: [{ name: 'a', dir: repo }] });
    bad({ tasks: [{ name: 'a', dir: abs() }] });
  });
});

describe('folderGone and usdOf', () => {
  it('folderGone is true for a deleted temp dir and false for a live one', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-gone-'));
    expect(folderGone(d)).toBe(false);
    fs.rmSync(d, { recursive: true });
    expect(folderGone(d)).toBe(true);
  });
  it('usdOf: null or a positive finite number, else a string', () => {
    expect(usdOf(null)).toBeNull();
    expect(usdOf(2.5)).toBe(2.5);
    for (const v of [0, -1, Number.NaN, Infinity, '5', undefined]) expect(typeof usdOf(v)).toBe('string');
  });
});
