import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step, Workflow } from '@reins/core';
import { BlocksPane } from '../src/BlocksPane.js';

const models = [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }];
const step = (kind: string, over: Partial<Step> = {}) => ({ id: `${kind}-1`, kind, attrs: {}, cards: [], links: [], ...over }) as Step;
const face = (...steps: Step[]) => {
  const w = { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps } as unknown as Workflow;
  return renderToStaticMarkup(createElement(BlocksPane, {
    w, steps: steps.map((s) => ({ id: s.id })), diags: [], text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 },
    models, sessionModel: { id: 'm1', label: 'Model One' }, onEdit: () => true, onSelect: () => {},
  } as never));
};

describe('the block face', () => {
  it('a subagent with no model shows a model picker that names the session model, not a text pill', () => {
    const html = face(step('subagent', { title: 'research' }));
    expect(html).toContain('<select aria-label="Model of subagent-1" class="sx-pill">');
    expect(html).toContain('<option value="" selected="">Model One</option>');
  });
  it('a model block with no model asks to pick one; a chosen model is selected', () => {
    expect(face(step('model'))).toContain('<option value="" disabled="" selected="">Pick a model</option>');
    expect(face(step('model', { attrs: { model: 'm2' } }))).toContain('<option value="m2" selected="">Model Two</option>');
  });
  it('the budget pill says optional', () => {
    expect(face(step('subagent'))).toContain('aria-label="Budget (USD) of subagent-1" placeholder="optional"');
  });
  it('an empty prompt says so only on a kind whose validator warns about it', () => {
    expect(face(step('subagent'))).toContain('<span class="sx-faint">no prompt yet</span>');
    expect(face(step('phase', { title: 'plan' }))).toContain('<span class="sx-faint">no prompt yet</span>');
    expect(face(step('say'))).not.toContain('no prompt yet');
    expect(face(step('subagent', { prompt: 'Look.' }))).not.toContain('no prompt yet');
  });
  it('the two handles say what they do', () => {
    const html = face(step('run', { attrs: { cmd: 'x' } }));
    expect(html).toContain('title="Runs next when this block finishes. Drag to a block to link."');
    expect(html).toContain('title="Runs if this block fails. Drag to a block to link."');
  });
});
