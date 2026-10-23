// M2 Task 18: the app reads the question cards, the condition menu and the card words from the served list (as it reads kinds), and a name it has
// no entry for falls to a plain face and never throws. Lists are the builder's answer sent as JSON, with a mod's entry added through the registry.
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Cond, type Step, type Workflow } from '@reins/core';
import { servedKinds } from '../../server/src/mods/kinds-view.js';
import { BlockPanel } from '../src/BlockPanel.js';
import { BlocksPane } from '../src/BlocksPane.js';
import { CARD_KINDS, CARD_LABEL, setCards } from '../src/canvasKinds.js';
import { applyParam, COND_VIEWS, freshCond, setConds } from '../src/condKinds.js';
import { cleanStep } from '../src/editorState.js';
import { Palette } from '../src/Palette.js';
import { actionsFor, detailFor, GENERIC, offersStop, setQuestions } from '../src/questions.js';

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const wire = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const baseline = () => { const s = servedKinds(); setConds(s.conds); setCards(s.cards); setQuestions(s.questions); };
afterEach(baseline); // what the setup file made

const step = (kind: string, over: Partial<Step> = {}) => ({ id: `${kind}-1`, kind, attrs: {}, cards: [], links: [], ...over }) as Step;
const wf = (...steps: Step[]) => ({ name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps }) as unknown as Workflow;
const pane = (...steps: Step[]) => renderToStaticMarkup(createElement(BlocksPane, {
  w: wf(...steps), steps: steps.map((s) => ({ id: s.id })), diags: [], text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 },
  models: [], sessionModel: undefined, efforts: [], sessionEffort: undefined, onEdit: () => true, onSelect: () => {},
} as never));
const palette = () => renderToStaticMarkup(createElement(Palette, { onAdd: () => {}, onCond: () => {}, press: { current: undefined } }));
const panel = (s: Step) => renderToStaticMarkup(createElement(BlockPanel, { step: s, all: [s], rev: 0, models: [], efforts: [], onEdit: () => {}, onEditInText: () => {}, onDelete: () => {} }));

/**
 * The served lists with another label for one condition and one card. (Task 25a: the server no longer lets a mod's view cover a core name, so the
 * reply is edited here, which is all these tests need: the app draws what it is served.)
 */
function withMod() {
  const s = wire(servedKinds());
  s.conds = s.conds.map((c) => (c.t === 'cmd' ? { ...c, label: 'Beep says so', fresh: { t: 'cmd', cmd: 'beep' }, param: { key: 'cmd', look: 'code' } } : c)) as typeof s.conds;
  s.cards = s.cards.map((c) => (c.kind === 'guard' ? { ...c, section: 'Notes', add: 'Add note' } : c));
  return s;
}

describe('the condition menu is built from the served list', () => {
  it('the Blocks pane menu and the palette list the served conditions, in served order', () => {
    const labels = Object.values(COND_VIEWS).map((c) => c.label);
    const html = pane(step('if'));
    const options = [...html.matchAll(/<option value="([a-z]+)"[^>]*>([^<]*)<\/option>/g)].filter((m) => m[1] !== '');
    expect(options.map((m) => m[2])).toEqual(labels.map(esc));
    const p = palette();
    expect([...p.matchAll(/sx-condcard[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(labels.map(esc));
  });

  it('a served list with another label shows that label in both places, and a condition left out of it is not offered', () => {
    const s = withMod();
    s.conds = s.conds.filter((c) => c.t === 'cmd');
    setConds(s.conds);
    expect(Object.keys(COND_VIEWS)).toEqual(['cmd']);
    expect(pane(step('if'))).toContain('>Beep says so</option>');
    expect(pane(step('if'))).not.toContain('>tests pass</option>');
    expect(palette()).toContain('>Beep says so</button>');
    expect(palette()).not.toContain('>tests pass<');
  });

  it('an empty list (before the first reply) draws the menu empty and does not throw', () => {
    setConds(undefined);
    expect(() => pane(step('if'), step('repeat', { cond: { t: 'tests' } as Cond }))).not.toThrow();
    expect(() => palette()).not.toThrow();
    expect(freshCond('tests')).toBeUndefined();
  });

  it('a condition the app has no entry for draws as its name, and its box does not exist', () => {
    setConds(wire(servedKinds().conds).filter((c: { t: string }) => c.t !== 'tests'));
    const html = pane(step('repeat', { cond: { t: 'tests' } as Cond }));
    expect(html).toContain('>tests</span>');
    expect(applyParam({ t: 'tests' } as Cond, 'x')).toBeUndefined();
  });

  it('names of Object are not conditions', () => {
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(COND_VIEWS[t], t).toBeUndefined();
      expect(freshCond(t), t).toBeUndefined();
      expect(cleanStep({ id: 'a', kind: 'if', attrs: {}, cards: [], links: [], cond: { t } }), t).toBeUndefined();
    }
  });

  it('a stored step with a served condition reads back, and one with a condition that is gone does not', () => {
    const raw = { id: 'a', kind: 'if', attrs: {}, cards: [], links: [], cond: { t: 'cmd', cmd: 'x' } };
    expect(cleanStep(raw)).toBeDefined();
    setConds(wire(servedKinds().conds).filter((c: { t: string }) => c.t !== 'cmd'));
    expect(cleanStep(raw)).toBeUndefined();
  });

  it('setConds leaves out an entry the box cannot use: a param key x, a look y, a fresh atom of another t, no label, a non-list', () => {
    const good = { t: 'ok', label: 'Ok', fresh: { t: 'ok' } };
    setConds([
      good,
      { t: 'k', label: 'K', fresh: { t: 'k' }, param: { key: 'x', look: 'str' } },
      { t: 'l', label: 'L', fresh: { t: 'l' }, param: { key: 'q', look: 'y' } },
      { t: 'f', label: 'F', fresh: { t: 'other' } },
      { t: 'n', fresh: { t: 'n' } },
      { t: 'o', label: 'O', fresh: { t: 'o' }, param: { key: 'q', look: 'str', optional: false } },
      { t: 'p', label: 'P', fresh: { t: 'p' }, param: { key: 'toString', look: 'str' } },
      { t: 'r', label: 'R', fresh: { t: 'r' }, param: { key: 'q', look: 'constructor' } },
      null, 3, 'x',
    ]);
    expect(Object.keys(COND_VIEWS)).toEqual(['ok']);
    setConds('not a list');
    expect(Object.keys(COND_VIEWS)).toEqual([]);
    expect(Object.getPrototypeOf(COND_VIEWS)).toBeNull();
  });

  it('the box works for a served condition: the value is set only when it would print back', () => {
    setConds([{ t: 'c', label: 'C', fresh: { t: 'c', n: 1 }, param: { key: 'n', look: 'num' } }]);
    expect(applyParam(freshCond('c')!, '5')).toEqual({ t: 'c', n: 5 });
    expect(applyParam(freshCond('c')!, '-5')).toBeUndefined();
  });
});

describe('the add-card menu is built from the served list', () => {
  it('the panel shows the section and the add button with the served words', () => {
    expect(panel(step('phase'))).toContain('<h4>Guards</h4>');
    const s = withMod();
    setCards(s.cards);
    expect(CARD_KINDS).toEqual(['guard']);
    const html = panel(step('phase'));
    expect(html).toContain('<h4>Notes</h4>');
    expect(html).toContain('>Add note</button>');
    expect(html).not.toContain('Add guard');
  });

  it('with no cards served the section is not drawn and nothing throws', () => {
    setCards(undefined);
    expect(CARD_KINDS).toEqual([]);
    expect(() => panel(step('phase'))).not.toThrow();
    expect(panel(step('phase'))).not.toContain('Guards');
    expect(panel(step('phase'))).not.toContain('Add guard');
  });

  it('a stored card of a kind not served is dropped when the step is read', () => {
    const raw = { id: 'a', kind: 'phase', attrs: {}, links: [], cards: [{ kind: 'guard', text: 'x' }] };
    expect(cleanStep(raw)).toBeDefined();
    setCards([]);
    expect(cleanStep(raw)).toBeUndefined();
  });

  it('setCards leaves out an entry without kind, section and add; names of Object are not cards', () => {
    setCards([{ kind: 'a', section: 'A', add: 'Add a' }, { kind: 'b', section: 'B' }, { section: 'C', add: 'c' }, { kind: 'd', section: 1, add: 'x' }, null]);
    expect(CARD_KINDS).toEqual(['a']);
    expect(Object.getPrototypeOf(CARD_LABEL)).toBeNull();
    for (const k of ['constructor', '__proto__', 'toString']) expect(CARD_LABEL[k], k).toBeUndefined();
  });
});

describe('the question cards are built from the served list', () => {
  it('a card the list names is used, and one it does not hold is the generic card', () => {
    setQuestions([{ kind: 'ask', actions: [{ label: 'Go', primary: true, answer: 'go {text}', field: { placeholder: 'p', initial: 'i', empty: 'go' } }] }]);
    expect(actionsFor('ask').map((a) => a.label)).toEqual(['Go']);
    expect(actionsFor('ask')[0]!.build('')).toBe('go');
    expect(actionsFor('ask')[0]!.build(' now ')).toBe('go now');
    expect(actionsFor('ask')[0]!.field).toEqual({ placeholder: 'p', initial: 'i' });
    expect(actionsFor('gate')).toBe(GENERIC.actions);
  });

  it('before any reply every kind is the generic card', () => {
    setQuestions(undefined);
    for (const k of ['gate', 'budget', 'tool']) expect(actionsFor(k)).toBe(GENERIC.actions);
    expect(detailFor('tool')).toBeUndefined();
    expect(offersStop('gate')).toBe(false);
  });

  it('a card with a check the app does not know, or a missing word, is left out (its kind is generic); the rest still work', () => {
    setQuestions([
      { kind: 'a', actions: [{ label: 'X', answer: 'x', field: { placeholder: 'p', check: 'eval' } }] },
      { kind: 'b', actions: [{ label: 'X' }] },
      { kind: 'c', actions: [] },
      { kind: 'd', actions: [{ label: 'X', answer: 'x', field: { placeholder: 1 } }] },
      { kind: 'e', actions: [{ label: 'X', answer: 'x', field: { placeholder: 'p', check: 'constructor' } }] },
      { kind: 'ok', actions: [{ label: 'Y', answer: 'y' }] },
      { actions: [] }, null,
    ]);
    for (const k of ['a', 'b', 'c', 'd', 'e']) expect(actionsFor(k), k).toBe(GENERIC.actions);
    expect(actionsFor('ok')[0]!.build('')).toBe('y');
  });

  it('a question named like a property of Object is found nowhere', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(actionsFor(k), k).toBe(GENERIC.actions);
      expect(detailFor(k), k).toBeUndefined();
    }
  });

  it('a name only the prototype has is not a check', () => {
    setQuestions([{ kind: 'a', actions: [{ label: 'X', answer: 'x {text}', field: { placeholder: 'p', check: 'toString' } }] }]);
    expect(actionsFor('a')).toBe(GENERIC.actions);
  });

  it('the json detail comes only from the card', () => {
    setQuestions([{ kind: 'a', detail: 'json', actions: [{ label: 'Y', answer: 'y' }] }, { kind: 'b', detail: 'html', actions: [{ label: 'Y', answer: 'y' }] }]);
    expect(detailFor('a')).toBe('json');
    expect(detailFor('b')).toBeUndefined();
  });
});
