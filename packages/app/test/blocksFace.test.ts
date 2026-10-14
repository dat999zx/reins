import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step, Workflow } from '@reins/core';
import { BlocksPane } from '../src/BlocksPane.js';
import { wiresOf } from '../src/canvasKinds.js';

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
  it('a verify block has three handles in order, a run block two, a phase one', () => {
    const lks = (html: string) => [...html.matchAll(/data-lk="([^"]+)"/g)].map((m) => m[1]);
    expect(lks(face(step('verify')))).toEqual(['next', 'on-fail', 'against']);
    expect(lks(face(step('run', { attrs: { cmd: 'x' } })))).toEqual(['next', 'on-fail']);
    expect(lks(face(step('phase')))).toEqual(['next']);
    expect(wiresOf('verify')).toEqual(['next', 'on-fail', 'against']);
    expect(wiresOf('end')).toEqual([]);
  });
  it('handles stack by count: two get sx-two, three get sx-three, one gets neither', () => {
    const cls = (html: string) => [...html.matchAll(/class="sx-handle([^"]*)"/g)].map((m) => m[1]!.trim());
    expect(cls(face(step('verify')))).toEqual(['sx-three', 'sx-three', 'sx-three']);
    expect(cls(face(step('run', { attrs: { cmd: 'ls' } })))).toEqual(['sx-two', 'sx-two']);
    expect(cls(face(step('phase', { title: 'p' })))).toEqual(['']);
  });
  it('a loose verify block shows its links as chips but not its against target', () => {
    const loose = step('verify', { attrs: { against: 'plan' }, links: [{ kind: 'on-fail', to: 'plan' }] as Step['links'] });
    const w = { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps: [loose] } as unknown as Workflow;
    const html = renderToStaticMarkup(createElement(BlocksPane, {
      w, steps: [loose], diags: [], text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 }, loose: { key: 'l:1', selected: false, moving: false, onPick: () => {} },
      models, sessionModel: { id: 'm1', label: 'Model One' }, onEdit: () => true, onSelect: () => {},
    } as never));
    expect(html).toContain('on-fail');
    expect(html).not.toContain('against \u2192');
    expect(html).not.toContain('class="sx-handle');
  });
  it('the against handle says what it does', () => {
    expect(face(step('verify'))).toContain("title=\"Compares this block&#x27;s work against the block you drag this to. Drag to a block to link.\"");
  });
  it('verify against: no dropdown, the target as faint text (its title if it has one), a hint when empty', () => {
    const html = face(step('verify', { attrs: { against: 'phase-1' } }), step('phase', { id: 'phase-1', title: 'Plan' }));
    expect(html).not.toContain('Against of');
    expect(html).toContain('<span class="sx-faint">Plan</span>');
    expect(face(step('verify', { attrs: { against: 'x' } }))).toContain('<span class="sx-faint">x</span>');
    expect(face(step('verify'))).toContain('<span class="sx-faint">drag the blue dot to a block</span>');
  });
  it('the two handles say what they do', () => {
    const html = face(step('run', { attrs: { cmd: 'x' } }));
    expect(html).toContain('title="Runs next when this block finishes. Drag to a block to link."');
    expect(html).toContain('title="Runs if this block fails. Drag to a block to link."');
  });
});
