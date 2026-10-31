import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Rail } from '../src/Rail.js';
import { ParallelStart, PreviewLines } from '../src/ParallelStart.js';
import { busyPhase, canClean, canMerge, mergeWords, type ParallelPhase, type ParallelView } from '../src/parallel.js';
import type { Sess, State } from '../src/state.js';
import type { LogRow } from '@reins/server/store.js';

const sess = (id: string, o: Partial<Sess> = {}): Sess => ({
  id, cwd: '/w', autoApprove: false, status: 'idle', rows: [], lastSeq: 1, lastTs: 1, cost: 0,
  open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [], explicitTitle: `title-${id}`, ...o,
});
const props = { selected: null, onSelect: () => {}, onNew: () => {}, onPlus: () => {}, onRename: () => {}, onSettings: () => {}, pathBox: null };
const row = (type: string) => ({ type }) as unknown as LogRow;

const job = (o: Record<string, unknown> = {}) => ({
  repo: '/r', branch: 'main', head: 'abc', folder: '/f', gate: 'npm test', tasks: [], words: '', merged: [], notMerged: [], gateResult: 'not run' as const, ...o,
});
const run = (phase: ParallelPhase, o: Partial<ParallelView> = {}): ParallelView => ({
  id: 'p1', title: 'Big run', createdAt: 1, tasks: [{ name: 'a', sessionId: 'a' }, { name: 'b', sessionId: 'b' }], phase, job: job(), ...o,
});

const ended = [sess('a'), sess('b', { status: 'closed' })];
const live = [sess('a'), sess('b', { status: 'running' })];

describe('canMerge', () => {
  it.each([
    ['setup', ended, false],
    ['running', ended, true],
    ['running', live, false],
    ['merging', ended, false],
    ['gating', ended, false],
    ['done', ended, false],
    ['failed', ended, true],
    ['failed', live, false],
    ['interrupted', ended, true],
    ['interrupted', live, false],
  ] as const)('%s', (phase, sessions, yes) => {
    expect(canMerge(run(phase), [...sessions])).toBe(yes);
  });

  it('is false for no tasks and for no job', () => {
    expect(canMerge(run('failed', { tasks: [] }), [])).toBe(false);
    expect(canMerge(run('interrupted', { tasks: [] }), [])).toBe(false);
    expect(canMerge(run('running', { job: undefined }), ended)).toBe(false);
  });

  it('counts who has ended', () => {
    const m = (s: Sess) => canMerge(run('running'), [sess('a'), s]);
    expect(m(sess('b'))).toBe(true);                                    // idle, no rows
    expect(m(sess('b', { status: 'closed' }))).toBe(true);
    expect(m(sess('b', { detached: [{} as never] }))).toBe(false);      // paused
    expect(m(sess('b', { status: 'waiting' }))).toBe(false);
    expect(m(sess('b', { status: 'running', rows: [row('run_stopped')] }))).toBe(false);   // resumed
  });
});

describe('canClean', () => {
  it.each([
    ['setup', false],
    ['running', false],
    ['merging', false],
    ['gating', false],
    ['done', true],
    ['failed', true],
    ['interrupted', true],
  ] as const)('%s', (phase, yes) => {
    expect(canClean(run(phase))).toBe(yes);
  });
  it('is false for no job', () => {
    expect(canClean(run('done', { job: undefined }))).toBe(false);
  });
});

describe('busyPhase', () => {
  it('is true for setup, merging and gating only', () => {
    expect((['setup', 'merging', 'gating'] as const).map((p) => busyPhase(run(p)))).toEqual([true, true, true]);
    expect((['running', 'done', 'failed', 'interrupted'] as const).map((p) => busyPhase(run(p)))).toEqual([false, false, false, false]);
  });
});

describe('mergeWords', () => {
  const fin = [sess('a', { rows: [row('run_finished')] }), sess('b', { status: 'closed', rows: [row('run_stopped')] })];
  it('names the branch and the gate', () => {
    expect(mergeWords(run('running'), fin)).toBe('Merge into main, then run: npm test?');
  });
  it('says no gate', () => {
    expect(mergeWords(run('running', { job: job({ gate: undefined }) }), fin)).toBe('Merge into main, then run: no gate?');
  });
  it('counts tasks that never ran', () => {
    const w = mergeWords(run('running'), [sess('a'), sess('b', { rows: [row('run_finished')] })]);
    expect(w).toBe('Merge into main, then run: npm test?\n1 task(s) never ran and will not be merged.');
    expect(mergeWords(run('running'), [sess('a', { rows: [row('run_stopped')] }), sess('b', { rows: [row('run_finished')] })])).not.toContain('never ran');
  });
  it('adds nothing for interrupted', () => {
    const j = job({ words: 'The server stopped during gating.' });
    expect(mergeWords(run('interrupted', { job: j }), ended)).not.toContain('The server stopped');
  });
  it('shows a hidden mark in the gate', () => {
    expect(mergeWords(run('running', { job: job({ gate: 'a‮b' }) }), ended)).toContain('<U+202E>');
  });
});

describe('Rail phase and controls', () => {
  const st = (): State => ({ sessions: { a: sess('a'), b: sess('b', { status: 'closed' }) } });
  it('a gating run shows the badge and no button at all', () => {
    const html = renderToStaticMarkup(createElement(Rail, { ...props, state: st(), parallel: [run('gating')] }));
    expect(html).toContain('gating');
    expect(html).not.toContain('>Merge<');
    expect(html).not.toContain('>Clean<');
  });
  it('a failed run shows its words', () => {
    const html = renderToStaticMarkup(createElement(Rail, { ...props, state: st(), parallel: [run('failed', { job: job({ words: 'gate broke' }) })] }));
    expect(html).toContain('gate broke');
  });
  it('a run with no job shows no Merge, no Clean and no phase line', () => {
    const plain: ParallelView = { id: 'p1', title: 'Big run', createdAt: 1, tasks: [{ name: 'a', sessionId: 'a' }] };
    const html = renderToStaticMarkup(createElement(Rail, { ...props, state: st(), parallel: [plain] }));
    expect(html).not.toContain('Merge');
    expect(html).not.toContain('Clean');
    expect(html).not.toContain('class="phase"');
  });
});

describe('PreviewLines', () => {
  const spec = {
    title: 'T', copy: [], gate: 'npm test‮x', install: 'npm ci',
    tasks: [{ name: 'one', slug: 'one', playbook: 'p1.json' }, { name: 'two', slug: 'two', playbook: 'p2.json', model: 'm', effort: 'high' }],
  };
  const html = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec }));
  it('shows both commands in code and the warning', () => {
    expect(html).toContain('<code>npm ci</code>');
    expect(html).toContain('<code>npm test');
    expect(html).toContain('Start runs these commands in a shell.');
    expect(html).not.toContain('every request');
    expect(html).not.toContain('no cap');
  });
  it('escapes a right-to-left mark', () => {
    expect(html).toContain('&lt;U+202E&gt;');
    expect(html).not.toContain('‮');
  });
  it('leaves out a missing install and gate', () => {
    const h = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec: { title: 'T', copy: [], tasks: [] } }));
    expect(h).not.toContain('Install');
    expect(h).not.toContain('Gate');
    expect(h).not.toContain('Start runs');
  });
  it('shows approve and the cap', () => {
    const h = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec: { ...spec, approve: 'fence' as const, capUsd: 5 } }));
    expect(h).toContain('Approve');
    expect(h).toContain('fence');
    expect(h).toContain('$5');
  });
});

describe('ParallelStart', () => {
  it('closed, it is one button', () => {
    const html = renderToStaticMarkup(createElement(ParallelStart, { cwd: '/w', onStarted: () => {}, onError: () => {} }));
    expect(html).toContain('Parallel run');
    expect(html).not.toContain('Tasks file');
  });
});
