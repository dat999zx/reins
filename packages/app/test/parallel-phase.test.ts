import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Rail } from '../src/Rail.js';
import { ParallelStart, PreviewLines } from '../src/ParallelStart.js';
import { busyPhase, cleanBlock, mergeBlock, mergeWords, type ParallelPhase, type ParallelView } from '../src/parallel.js';
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
const WAIT = 'Waiting for 1 task(s) to end. One stopped mid-turn waits on a resume card: press Stop all again, or Resume all.';

describe('mergeBlock', () => {
  it.each([
    ['setup', ended, 'Setup is running.'],
    ['running', ended, undefined],
    ['running', live, WAIT],
    ['merging', ended, 'A merge is running.'],
    ['gating', ended, 'A merge is running.'],
    ['done', ended, 'Already merged.'],
    ['failed', ended, undefined],
    ['failed', live, WAIT],
    ['interrupted', ended, undefined],
    ['interrupted', live, WAIT],
  ] as const)('%s', (phase, sessions, words) => {
    expect(mergeBlock(run(phase), [...sessions])).toBe(words);
  });

  it('a failed or interrupted run with no tasks says setup did not finish', () => {
    expect(mergeBlock(run('failed', { tasks: [] }), [])).toBe('Setup did not finish.');
    expect(mergeBlock(run('interrupted', { tasks: [] }), [])).toBe('Setup did not finish.');
  });

  it('counts who has ended', () => {
    const m = (s: Sess) => mergeBlock(run('running'), [sess('a'), s]);
    expect(m(sess('b'))).toBeUndefined();                                    // idle, no rows
    expect(m(sess('b', { status: 'closed' }))).toBeUndefined();
    expect(m(sess('b', { detached: [{} as never] }))).toBe(WAIT);           // paused
    expect(m(sess('b', { status: 'waiting' }))).toBe(WAIT);
    expect(m(sess('b', { status: 'running', rows: [row('run_stopped')] }))).toBe(WAIT);   // resumed
  });
});

describe('cleanBlock', () => {
  it.each([
    ['setup', 'Setup is running.'],
    ['running', 'Merge first.'],
    ['merging', 'A merge is running.'],
    ['gating', 'A merge is running.'],
    ['done', undefined],
    ['failed', undefined],
    ['interrupted', undefined],
  ] as const)('%s', (phase, words) => {
    expect(cleanBlock(run(phase))).toBe(words);
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
  it('adds job.words for interrupted only', () => {
    const j = job({ words: 'The old gate may still be running.' });
    expect(mergeWords(run('interrupted', { job: j }), ended)).toContain('The old gate may still be running.');
    expect(mergeWords(run('failed', { job: j }), ended)).not.toContain('The old gate');
  });
  it('shows a hidden mark in the gate', () => {
    expect(mergeWords(run('running', { job: job({ gate: 'a‮b' }) }), ended)).toContain('<U+202E>');
  });
});

describe('Rail phase and controls', () => {
  const st = (): State => ({ sessions: { a: sess('a'), b: sess('b', { status: 'closed' }) } });
  it('a gating run shows the phase, a disabled Merge and Clean, and the why', () => {
    const html = renderToStaticMarkup(createElement(Rail, { ...props, state: st(), parallel: [run('gating')] }));
    expect(html).toContain('gating');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Merge<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Clean<\/button>/);
    expect(html).toContain('A merge is running.');
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
  it('shows both commands and the warning', () => {
    expect(html).toContain('npm ci');
    expect(html).toContain('npm test');
    expect(html).toContain('Start runs these commands through the shell on this machine.');
    expect(html).toContain('every request is a card');
    expect(html).toContain('no cap');
  });
  it('escapes a right-to-left mark', () => {
    expect(html).toContain('&lt;U+202E&gt;');
    expect(html).not.toContain('‮');
  });
  it('says none for a missing install and gate', () => {
    const h = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec: { title: 'T', copy: [], tasks: [] } }));
    expect(h).toContain('Install: none');
    expect(h).toContain('Gate: none');
  });
  it('shows auto-approve and the cap', () => {
    const h = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec: { ...spec, approve: 'fence' as const, capUsd: 5 } }));
    expect(h).toContain('auto-approve: fence');
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
