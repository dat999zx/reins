import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Rail } from '../src/Rail.js';
import { PreviewLines } from '../src/ParallelStart.js';
import { PHASE_BADGE, countWords, type ParallelPhase, type ParallelView } from '../src/parallel.js';
import { dropSessions, type Sess, type State } from '../src/state.js';

const sess = (id: string, o: Partial<Sess> = {}): Sess => ({
  id, cwd: '/w', autoApprove: false, status: 'idle', rows: [], lastSeq: 1, lastTs: 1, cost: 0,
  open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [], explicitTitle: `title-${id}`, ...o,
});
const props = { selected: null, onSelect: () => {}, onNew: () => {}, onPlus: () => {}, onRename: () => {}, onSettings: () => {}, pathBox: null };

const job = (o: Record<string, unknown> = {}) => ({
  repo: '/r', branch: 'main', head: 'abc', folder: '/f', gate: 'npm test', tasks: [], words: '', merged: [], notMerged: [], gateResult: 'not run' as const, ...o,
});
const run = (phase: ParallelPhase, o: Partial<ParallelView> = {}): ParallelView => ({
  id: 'p1', title: 'Big run', createdAt: 1, tasks: [{ name: 'a', sessionId: 'a' }, { name: 'b', sessionId: 'b' }], phase, job: job(), ...o,
});

const ended = [sess('a'), sess('b', { status: 'closed' })];
const render = (r: ParallelView, ss: Sess[]) =>
  renderToStaticMarkup(createElement(Rail, { ...props, state: { sessions: Object.fromEntries(ss.map((s) => [s.id, s])) }, parallel: [r] }));

type Shown = Array<'Stop all' | 'Resume all' | 'Merge' | 'Clean' | 'Cap USD'>;
const probes: Array<[string, RegExp]> = [['Stop all', />Stop all</], ['Resume all', />Resume all</], ['Merge', />Merge</], ['Clean', />Clean</], ['Cap USD', /Cap USD/]];

describe('Rail controls', () => {
  it.each([
    ['setup, no sessions', run('setup', { tasks: [] }), [], []],
    ['running, one running', run('running'), [sess('a', { status: 'running' }), sess('b', { status: 'closed' })], ['Stop all', 'Cap USD']],
    ['running, one paused', run('running'), [sess('a', { status: 'idle', detached: ['r'] }), sess('b', { status: 'closed' })], ['Resume all', 'Cap USD']],
    ['running, one waiting', run('running'), [sess('a', { status: 'waiting' }), sess('b', { status: 'closed' })], ['Stop all', 'Resume all', 'Cap USD']],
    ['running, all ended', run('running'), ended, ['Merge']],
    ['running, all ended, over cap', run('running', { capUsd: 1 }), [sess('a', { cost: 2 }), sess('b', { status: 'closed' })], ['Merge', 'Cap USD']],
    ['merging', run('merging'), ended, []],
    ['gating', run('gating'), ended, []],
    ['done', run('done'), ended, ['Clean']],
    ['failed, tasks', run('failed'), ended, ['Merge', 'Clean']],
    ['failed, no tasks', run('failed', { tasks: [] }), [], ['Clean']],
    ['failed, one running', run('failed'), [sess('a', { status: 'running' }), sess('b', { status: 'closed' })], ['Stop all', 'Cap USD', 'Clean']],
    ['interrupted', run('interrupted'), ended, ['Merge', 'Clean']],
    ['no job', run('running', { job: undefined, phase: undefined }), ended, ['Cap USD']],
  ] as Array<[string, ParallelView, Sess[], Shown]>)('%s', (_n, r, ss, shown) => {
    const html = render(r, ss);
    expect(probes.filter(([, re]) => re.test(html)).map(([k]) => k)).toEqual(probes.map(([k]) => k).filter((k) => (shown as string[]).includes(k)));
    if (shown.length === 0) expect(html).not.toContain('class="actions"');
    for (const bad of ['disabled=""', 'Setup is running', 'Merge first', 'Already merged', 'A merge is running']) expect(html).not.toContain(bad);
  });

  it('shows the card line once, and only with a waiting task', () => {
    const line = 'Answer the card, or press Stop all.';
    const html = render(run('running'), [sess('a', { status: 'waiting' }), sess('b', { status: 'waiting' })]);
    expect(html.split(line).length - 1).toBe(1);
    expect(render(run('running'), [sess('a', { status: 'running' }), sess('b')])).not.toContain(line);
  });

  it.each(Object.keys(PHASE_BADGE) as ParallelPhase[])('the %s badge', (phase) => {
    const html = render(run(phase), ended);
    expect(html).toContain(`class="sstate ${PHASE_BADGE[phase]}"`);
    expect(html).toContain(`>${phase}</span>`);
  });

  it('a run with no job has no badge', () => {
    expect(render(run('running', { job: undefined }), ended)).not.toContain('sstate');
  });
});

describe('countWords', () => {
  it('leaves out zeros', () => {
    expect(countWords({ running: 2, waiting: 0, paused: 0, done: 1 })).toBe('2 running · 1 done');
    expect(countWords({ running: 0, waiting: 0, paused: 0, done: 0 })).toBe('');
  });
});

describe('PreviewLines', () => {
  const spec = {
    title: 'T', copy: ['a‮b'], reports: 'r‮s', gate: 'npm test', install: 'npm ci',
    tasks: [{ name: 'one', slug: 'one', playbook: 'p1.json' }, { name: 'two‮x', slug: 'two', playbook: 'p2.json', model: 'm1', effort: 'high' }],
  };
  it('puts the commands in code', () => {
    const html = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec }));
    expect(html).toContain('<dd class="cmd"><code>npm ci</code></dd>');
    expect(html).toContain('<dd class="cmd"><code>npm test</code></dd>');
    expect(html).toContain('Start runs these commands in a shell.');
  });
  it('a bare spec has the repo and tasks only', () => {
    const html = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec: { title: 'T', copy: [], tasks: [{ name: 'one', slug: 'one', playbook: 'p' }] } }));
    expect(html.split('<dt>Repo</dt>').length - 1).toBe(1);
    expect(html.split('<dt>Task</dt>').length - 1).toBe(1);
    for (const no of ['Install', 'Gate', 'Retry', 'Reports', 'Copy', 'Cap', 'Approve', 'none', 'default', 'Start runs']) expect(html).not.toContain(no);
  });
  it('shows model and effort, and escapes hidden marks', () => {
    const html = renderToStaticMarkup(createElement(PreviewLines, { repo: '/r', spec }));
    expect(html).toContain('m1');
    expect(html).toContain('high');
    expect(html).not.toContain('‮');
    expect(html.split('&lt;U+202E&gt;').length - 1).toBe(3);
  });
});

describe('dropSessions', () => {
  it('removes the ids, keeps the rest and replayed', () => {
    const st: State = { sessions: { a: sess('a'), b: sess('b'), c: sess('c') }, replayed: true };
    const n = dropSessions(st, ['a', 'c']);
    expect(Object.keys(n.sessions)).toEqual(['b']);
    expect(n.replayed).toBe(true);
  });
});
