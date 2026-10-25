import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step, Workflow } from '@reins/core';
import { BlocksPane } from '../src/BlocksPane.js';
import { wiresOf } from '../src/canvasKinds.js';

const models = [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }];
const efforts = [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }];
const step = (kind: string, over: Partial<Step> = {}) => ({ id: `${kind}-1`, kind, attrs: {}, cards: [], links: [], ...over }) as Step;
const face = (...steps: Step[]) => {
  const w = { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps } as unknown as Workflow;
  return renderToStaticMarkup(createElement(BlocksPane, {
    w, steps: steps.map((s) => ({ id: s.id })), diags: [], text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 },
    models, sessionModel: { id: 'm1', label: 'Model One' }, efforts, sessionEffort: { id: 'medium', label: 'Medium' }, onEdit: () => true, onSelect: () => {},
  } as never));
};

describe('the block face', () => {
  it('a subagent and a switch-model block show a Reasoning picker: blank is the session level, a chosen level is selected', () => {
    const sub = face(step('subagent', { title: 'research' }));
    expect(sub).toContain('<select aria-label="Reasoning of subagent-1" class="sx-pill">');
    expect(sub).toContain('<option value="" selected="">Medium</option><option value="medium">Medium</option><option value="high">High</option>');
    expect(face(step('subagent', { attrs: { reasoning: 'high' } }))).toContain('<option value="high" selected="">High</option>');
    expect(face(step('model', { attrs: { model: 'm2' } }))).toContain('<select aria-label="Reasoning of model-1" class="sx-pill">');
  });
  it('a subagent with no model shows a model picker that names the session model, not a text pill', () => {
    const html = face(step('subagent', { title: 'research' }));
    expect(html).toContain('<select aria-label="Model of subagent-1" class="sx-pill">');
    expect(html).toContain('<option value="" selected="">Model One</option>');
  });
  it('a model block with no model asks to pick one; a chosen model is selected', () => {
    expect(face(step('model'))).toContain('<option value="" disabled="" selected="">Pick a model</option>');
    expect(face(step('model', { attrs: { model: 'm2' } }))).toContain('<option value="m2" selected="">Model Two</option>');
  });
  it('a subagent shows its mode as a pill: write when the file has none, read-only when it says so; a phase has none', () => {
    const html = face(step('subagent'));
    expect(html).toContain('<select aria-label="Mode of subagent-1" class="sx-pill">');
    expect(html).toContain('<option value="write" selected="">write</option><option value="read-only">read-only</option>');
    expect(face(step('subagent', { attrs: { mode: 'read-only' } }))).toContain('<option value="write">write</option><option value="read-only" selected="">read-only</option>');
    expect(face(step('phase', { title: 'p' }))).not.toContain('Mode of');
  });
  it('a card chip reads guard: <glob>, with guard as its own chip', () => {
    const html = face(step('phase', { title: 'p', cards: [{ kind: 'guard', text: 'src/**' }] }));
    expect(html).toContain('<span class="sx-mod"><span class="sx-cardkind">guard:</span> src/**</span>');
  });
  it('a model block says switch model to', () => {
    expect(face(step('model'))).toContain('switch model to');
  });  it('the budget pill says optional', () => {
    expect(face(step('subagent'))).toContain('aria-label="Budget (USD) of subagent-1" placeholder="optional"');
  });
  it('an empty prompt says so only on a kind whose validator warns about it', () => {
    expect(face(step('subagent'))).toContain('<span class="sx-faint">no prompt yet</span>');
    expect(face(step('phase', { title: 'plan' }))).toContain('<span class="sx-faint">no prompt yet</span>');
    expect(face(step('say'))).not.toContain('no prompt yet');
    expect(face(step('subagent', { prompt: 'Look.' }))).not.toContain('no prompt yet');
  });
  it('a verify block has two handles in order (on-fail, against), a run block one (on-fail), a phase none, and only the fork has the gray next', () => {
    const lks = (html: string) => [...html.matchAll(/data-lk="([^"]+)"/g)].map((m) => m[1]);
    expect(lks(face(step('verify')))).toEqual(['on-fail', 'against']);
    expect(lks(face(step('run', { attrs: { cmd: 'x' } })))).toEqual(['on-fail']);
    expect(lks(face(step('phase')))).toEqual([]);
    expect(lks(face(step('fork')))).toEqual(['next']);
    expect(wiresOf('verify')).toEqual(['on-fail', 'against']);
    expect(wiresOf('phase')).toEqual([]);
    expect(wiresOf('fork')).toEqual(['next']);
    expect(wiresOf('end')).toEqual([]);
  });
  it('handles stack by count: two get sx-two, one gets neither', () => {
    const cls = (html: string) => [...html.matchAll(/class="sx-handle([^"]*)"/g)].map((m) => m[1]!.trim());
    expect(cls(face(step('verify')))).toEqual(['sx-two', 'sx-two']);
    expect(cls(face(step('run', { attrs: { cmd: 'ls' } })))).toEqual(['']);
    expect(cls(face(step('fork')))).toEqual(['']);
    expect(cls(face(step('phase', { title: 'p' })))).toEqual([]);
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
  describe('the hat holds the workflow budget', () => {
    const hat = (w: Partial<Workflow>, diags: unknown[] = []) => renderToStaticMarkup(createElement(BlocksPane, {
      w: { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps: [], ...w } as unknown as Workflow, steps: [], diags, text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 },
      models, onEdit: () => true, onSelect: () => {},
    } as never));
    it('three pills: turns, minutes, USD (empty says optional)', () => {
      const html = hat({});
      expect(html).toContain('aria-label="Turns of the playbook"');
      expect(html).toContain('aria-label="Minutes of the playbook"');
      expect(html).toContain('aria-label="USD of the playbook"');
      expect(html).toMatch(/aria-label="Turns of the playbook"[^>]*value="10"/);
      expect(html).toMatch(/aria-label="Minutes of the playbook"[^>]*value="30"/);
      expect(html).toMatch(/aria-label="USD of the playbook" placeholder="optional"/);
      expect(hat({ budget: { turns: 10, minutes: 30, usd: 2 } })).toMatch(/aria-label="USD of the playbook"[^>]*value="2.00"/);
    });
    it('a block file has no budget, so no pills', () => {
      expect(hat({ block: 'b' } as never)).not.toContain('of the playbook');
    });
    it('the over-sum error is said under the pills, only while it is true', () => {
      const d = { severity: 'error', message: "The blocks' budgets add up to $3.00, over the playbook's $2.00.", pos: { line: 9, col: 1 } };
      expect(hat({}, [d])).toContain('<div class="sx-bad">The blocks&#x27; budgets add up to $3.00, over the playbook&#x27;s $2.00.</div>');
      expect(hat({})).not.toContain('sx-bad');
      // any other error is not the hat's to say
      expect(hat({}, [{ severity: 'error', message: 'Unknown attribute "x"', pos: { line: 9, col: 1 } }])).not.toContain('sx-bad');
      expect(hat({}, [{ severity: 'warning', message: d.message, pos: d.pos }])).not.toContain('sx-bad');
    });
  });
  it('the handles say what they do', () => {
    expect(face(step('fork'))).toContain('title="Starts a branch at the block you drag this to. Drag to a block to link."');
    expect(face(step('run', { attrs: { cmd: 'x' } }))).toContain('title="Runs if this block fails. Drag to a block to link."');
  });
});
