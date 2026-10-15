import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step } from '@reins/core';
import { BlockPanel } from '../src/BlockPanel.js';

const step = (over: Partial<Step> = {}) => ({ id: 'plan', kind: 'phase', attrs: {}, cards: [], links: [], ...over }) as Step;
const html = (s: Step, all: Step[] = [s]) => renderToStaticMarkup(createElement(BlockPanel, {
  step: s, all, rev: 0, models: [], efforts: [], onEdit: () => {}, onEditInText: () => {}, onDelete: () => {},
}));

describe('the block panel', () => {
  it('the cards section is Guards: a glob input with a remove button per row, one Add guard button, no kind select', () => {
    const h = html(step({ cards: [{ kind: 'guard', text: 'src/**' }] }));
    expect(h).toContain('<h4>Guards</h4>');
    expect(h).toContain('value="src/**"');
    expect(h).toContain('aria-label="Remove guard card"');
    expect(h).toContain('>Add guard</button>');
    expect(h).not.toContain('Card kind');
    expect(h).not.toContain('Add card');
  });

  it('the Links section shows for outgoing links alone and for incoming links alone', () => {
    const a = step({ links: [{ kind: 'next', to: 'build' }] });
    const b = step({ id: 'build' });
    expect(html(a, [a, b])).toContain('<h4>Links</h4>');
    expect(html(a, [a, b])).not.toContain('(incoming)');
    const into = step({ id: 'build', links: [] }), from = step({ links: [{ kind: 'next', to: 'build' }] });
    expect(html(into, [from, into])).toContain('<h4>Links</h4>');
    expect(html(into, [from, into])).toContain('(incoming)');
  });
  it('the Guards section is named Guards for assistive tech too', () => {
    expect(html(step())).toContain('aria-label="Guards"');
    expect(html(step())).not.toContain('aria-label="Cards"');
  });

  it('a block with no links and none pointing at it has no Links section', () => {
    expect(html(step())).not.toContain('Links');
  });

  it('Links lists the links with their max and a remove button, and the incoming ones, with no add controls', () => {
    const a = step({ links: [{ kind: 'next', to: 'build', max: 2 }] });
    const b = step({ id: 'build', links: [{ kind: 'on-fail', to: 'plan' }] });
    const h = html(a, [a, b]);
    expect(h).toContain('<h4>Links</h4>');
    expect(h).toContain('value="2"');
    expect(h).toContain('aria-label="Remove link next to build"');
    expect(h).toContain('build');
    expect(h).toContain('(incoming)');
    expect(h).not.toContain('Link kind');
    expect(h).not.toContain('Link target');
    expect(h).not.toContain('Add link');
    expect(h).not.toContain('no effect');
  });
});
