import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Rail } from '../src/Rail.js';
import type { ParallelView } from '../src/parallel.js';
import type { Sess, State } from '../src/state.js';

const sess = (id: string, o: Partial<Sess> = {}): Sess => ({
  id, cwd: '/w', autoApprove: false, status: 'idle', rows: [], lastSeq: 1, lastTs: 1, cost: 0,
  open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [], explicitTitle: `title-${id}`, ...o,
});
const state: State = { sessions: {
  a: sess('a', { status: 'running', cost: 2.4 }), b: sess('b', { status: 'running', cost: 1.5 }),
  c: sess('c', { status: 'waiting', cost: 1.1 }), z: sess('z', { cwd: '/other' }),
} };
const parallel: ParallelView[] = [{ id: 'p1', title: 'Big run', capUsd: 5, createdAt: 1, tasks: ['a', 'b', 'c'].map((n) => ({ name: n, sessionId: n })) }];
const props = { state, selected: null, onSelect: () => {}, onNew: () => {}, onPlus: () => {}, onRename: () => {}, onSettings: () => {}, pathBox: null };

describe('Rail parallel group', () => {
  const html = renderToStaticMarkup(createElement(Rail, { ...props, parallel }));

  it('shows counts, cost against the cap, and the over class', () => {
    expect(html).toContain('2 running · 1 waiting · 0 paused · 0 done');
    expect(html).toContain('$5.00 of $5.00');
    expect(html).toMatch(/class="[^"]*\bover\b[^"]*"[^>]*>[^<]*\$5\.00 of \$5\.00/);
    expect(html).toContain('Big run');
  });

  it('keeps a grouped session out of its folder group', () => {
    expect(html.split('title-a').length - 1).toBe(1);   // only in the parallel group
    expect(html).not.toContain('title="/w"');            // no folder group for /w
    expect(html).toContain('title-z');
  });

  it('has Stop all, Resume all and a labelled cap input', () => {
    expect(html).toContain('Stop all');
    expect(html).toContain('Resume all');
    expect(html).toMatch(/<input[^>]*aria-label="Cap in USD"|aria-label="Cap in USD"[^>]*<input/);
  });

  it('still renders with today\'s props only', () => {
    const plain = renderToStaticMarkup(createElement(Rail, props));
    expect(plain).toContain('title-z');
    expect(plain).not.toContain('Stop all');
  });
});
