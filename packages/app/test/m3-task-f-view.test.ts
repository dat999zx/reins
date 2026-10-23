// M3 Task 9 (group F), the app side of the fork block: its view comes from the pack mod's manifest, its face reads `fork` and the chip `runs N at once`, it is the only block
// with the gray `next` handle, the palette offers it in Flow, its feed rows read from the manifest, and the canvas marks it active while its branches run.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step, Workflow } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import { BlocksPane } from '../src/BlocksPane.js';
import { KINDS, wiresOf } from '../src/canvasKinds.js';
import { Palette } from '../src/Palette.js';
import { stepStatus } from '../src/stepStatus.js';
import { fill } from '../src/template.js';

const step = (kind: string, over: Partial<Step> = {}) => ({ id: `${kind}-1`, kind, attrs: {}, cards: [], links: [], ...over }) as Step;
const next = (...to: string[]) => to.map((t) => ({ kind: 'next', to: t })) as Step['links'];
const face = (...steps: Step[]) => renderToStaticMarkup(createElement(BlocksPane, {
  w: { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps } as unknown as Workflow, steps: steps.map((s) => ({ id: s.id })), diags: [], text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 },
  models: [], sessionModel: undefined, efforts: [], sessionEffort: undefined, onEdit: () => true, onSelect: () => {},
} as never));

describe('the fork in the served list', () => {
  it('sits after the end, takes several wires, and is coloured as a loop', () => {
    const kinds = Object.keys(KINDS);
    expect(kinds.indexOf('fork')).toBeGreaterThan(kinds.indexOf('end'));
    expect(KINDS.fork).toMatchObject({ order: 135, colour: 'loop', manyNext: true, sub: 'runs {links.length} at once', fields: [], line: ['fork', 'sub'], card: { label: 'fork', section: 'Flow' }, fresh: {} });
    expect(KINDS.fork.stops).toBeUndefined();
    expect(KINDS.fork.fails).toBeUndefined();
    expect(KINDS.fork.cards).toBeUndefined();   // a fork sends no turn: no cards, no prompt
  });

  it('is the only block with the gray next handle', () => {
    const withNext = Object.keys(KINDS).filter((k) => wiresOf(k as never).includes('next'));
    expect(withNext).toEqual(['fork']);
  });
});

describe('the face', () => {
  it('says fork and how many it runs at once', () => {
    expect(face(step('fork', { links: next('a', 'b') }))).toContain('<b>fork</b><span>runs 2 at once</span>');
    expect(face(step('fork', { links: next('a', 'b', 'c') }))).toContain('runs 3 at once');
    expect(face(step('fork', { links: next('a') }))).toContain('runs 1 at once');
  });
  it('a fork with no wire yet says 0, and its wire is the one handle it has', () => {
    const html = face(step('fork'));
    expect(html).toContain('runs 0 at once');
    expect([...html.matchAll(/data-lk="([^"]+)"/g)].map((m) => m[1])).toEqual(['next']);
  });
  it('a fork is not dressed up: no prompt, no card chips, no pills', () => {
    const html = face(step('fork', { links: next('a', 'b') }));
    const block = html.slice(html.indexOf('data-id="fork-1"'));   // the hat before it holds the budget pills
    expect(block).toContain('runs 2 at once');
    expect(block).not.toContain('sx-pill');
    expect(html).not.toContain('no prompt yet');
  });
  it('a hostile link target cannot change the chip: it counts wires, it does not print them', () => {
    expect(face(step('fork', { links: next('<script>', '`x`') }))).toContain('runs 2 at once');
    expect(face(step('fork', { links: next('<script>') }))).not.toContain('<script>');
  });
});

describe('the palette', () => {
  it('offers a fork card in the Flow section', () => {
    const html = renderToStaticMarkup(createElement(Palette, { onAdd: () => {}, onCond: () => {}, press: { current: undefined } }));
    expect(html).toMatch(/data-kind="fork"/);
    const at = (s: string) => html.indexOf(s);
    expect(at('data-kind="fork"')).toBeGreaterThan(at('Flow'));
  });
});

describe('the feed rows', () => {
  it('read from the manifest: the fork starting its branches, and every branch done', () => {
    const rows = KINDS.fork.rows!;
    expect(fill(rows.fork_started!.text, { step: 'fork-1', words: '2 branches' })).toBe('Fork fork-1: 2 branches started.');
    expect(fill(rows.fork_started!.text, { step: 'fork-1', words: '1 branch' })).toBe('Fork fork-1: 1 branch started.');
    expect(fill(rows.fork_done!.text, { step: 'fork-1' })).toBe('Fork fork-1: every branch finished.');
    expect(rows.fork_started!.className).toBe('sx-sub');
  });
});

describe('while the branches run', () => {
  let seq = 0;
  const row = (type: string, data?: unknown): LogRow => ({ sessionId: 's1', seq: ++seq, ts: 1000 + seq, type, data, runId: 'r1' });
  it('the fork stays active until the last branch ended, and both branch blocks are active together', () => {
    const rows = [
      row('run_started', { workflow: 'w' }), row('step_started', { step: 'fork-1' }),
      row('track_started', { track: 'a', parent: '', group: 'fork-1', title: 'Branch A' }), row('track_started', { track: 'b', parent: '', group: 'fork-1', title: 'Branch B' }),
      row('fork_started', { step: 'fork-1', branches: 2, words: '2 branches' }),
      row('step_started', { step: 'a', track: 'a' }), row('step_started', { step: 'b', track: 'b' }),
    ];
    const live = stepStatus(rows);
    expect([live['fork-1']?.state, live.a?.state, live.b?.state]).toEqual(['active', 'active', 'active']);
    const oneEnded = stepStatus([...rows, row('turn_ended', { step: 'a', track: 'a', cost: 0.01 }), row('track_ended', { track: 'a', group: 'fork-1', title: 'Branch A' })]);
    expect(oneEnded['fork-1']?.state).toBe('active');
    expect(oneEnded.b?.state).toBe('active');
    const allEnded = stepStatus([...rows, row('track_ended', { track: 'a', group: 'fork-1', title: 'Branch A' }), row('track_ended', { track: 'b', group: 'fork-1', title: 'Branch B' }), row('fork_done', { step: 'fork-1' }), row('step_started', { step: 'build' })]);
    expect(allEnded['fork-1']?.state).not.toBe('active');
  });
});
