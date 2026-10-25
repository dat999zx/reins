// M2 Task 17b: the app holds no list of kinds. It is filled from the server's list (`GET /api/kinds`); a kind the app does not know draws a neutral
// "unknown block" face and nothing throws, also before the first reply (an empty KINDS). The setup file fills KINDS for the other app tests.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Registry, type Step, type Workflow } from '@reins/core';
import { servedKinds } from '../../server/src/mods/kinds-view.js';
import { served as packServed } from './app-pack.js';
import { linksToDraw } from '../src/arrows.js';
import { ensureEnd } from '../src/arrange.js';
import { addStep, dropPlace, freshOf, insertSteps, moveStep, nestPlace, setCond, stackEnd } from '../src/blocks.js';
import { BlocksPane } from '../src/BlocksPane.js';
import { capKind, KINDS, setKinds, unknownView, viewOf, wiresOf } from '../src/canvasKinds.js';
import { cleanStep } from '../src/editorState.js';
import { Palette } from '../src/Palette.js';

const beepManifest = JSON.parse(fs.readFileSync(new URL('../../server/test/fixtures/mods/toy-beep/mod.json', import.meta.url), 'utf8'));
const beepView = beepManifest.view;
/** The list as the app gets it: the builder's answer, sent as JSON. */
const served = (trusted = true) => {
  const registry = new Registry();
  registry.register('block-view', 'beep', beepView);
  const mods = { registry, mods: [{ id: 'toy-beep', kind: 'block', trusted, hasCode: true, manifest: { order: 140, provides: beepManifest.provides, view: beepView } }] };
  return JSON.parse(JSON.stringify(servedKinds(mods as never).kinds));
};
afterEach(() => setKinds(packServed().kinds)); // what the setup file made

const models = [{ id: 'm1', label: 'Model One' }];
const efforts = [{ id: 'medium', label: 'Medium' }];
const step = (kind: string, over: Partial<Step> = {}) => ({ id: `${kind}-1`, kind, attrs: {}, cards: [], links: [], ...over }) as Step;
const wf = (...steps: Step[]) => ({ name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps }) as unknown as Workflow;
const face = (...steps: Step[]) => renderToStaticMarkup(createElement(BlocksPane, {
  w: wf(...steps), steps: steps.map((s) => ({ id: s.id })), diags: [], text: '', sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 },
  models, sessionModel: { id: 'm1', label: 'Model One' }, efforts, sessionEffort: { id: 'medium', label: 'Medium' }, onEdit: () => true, onSelect: () => {},
} as never));
const palette = () => renderToStaticMarkup(createElement(Palette, { onAdd: () => {}, onCond: () => {}, press: { current: undefined } }));
const RLO = '\u202e';

describe('the app builds its kinds from the served list', () => {
  it('starts from the setup file\'s list: the 14 built-ins, no glob', () => {
    expect(Object.keys(KINDS)).toHaveLength(14);
    expect(Object.getPrototypeOf(KINDS)).toBeNull();
  });

  it('renders toy-beep from the served JSON: face, palette card, a new block from `fresh`', () => {
    expect(palette()).not.toContain('data-kind="beep"');
    setKinds(served());
    expect(Object.keys(KINDS).at(-1)).toBe('beep');
    const html = face(step('beep', { attrs: { times: '2' } }));
    expect(html).toContain('data-kind="beep"');
    expect(html).toContain('data-colour="soft"');
    expect(html).toContain('<b>beep</b>');
    expect(html).toContain('aria-label="Times of beep-1"');
    expect(html).toContain('aria-label="beep beep-1"');
    expect(html).not.toContain('unknown block');
    expect(palette()).toMatch(/<button[^>]*data-kind="beep"[^>]*><i><\/i>beep<\/button>/);
    expect(palette()).not.toContain('data-untrusted');
    const w = addStep(wf(step('say')), 'beep');
    expect(w.steps.map((s) => s.kind)).toEqual(['say', 'beep']);
    expect(w.steps[1]!.attrs).toEqual({ times: '1' });
  });

  it('a block of a mod that is not trusted yet says so on its palette card', () => {
    setKinds(served(false));
    expect(palette()).toMatch(/<button[^>]*data-kind="beep"[^>]*data-untrusted="true"[^>]*title="This block&#x27;s code is not trusted yet, so it will not run\."/);
  });

  it('setKinds leaves out what is not a view and replaces what was there', () => {
    setKinds([null, 5, 'x', { kind: 'nofields' }, { kind: 'a', fields: [], line: 'x' }, { kind: 'ok', fields: [], line: ['ok'] }]);
    expect(Object.keys(KINDS)).toEqual(['ok']);
    setKinds({ kinds: [] });
    expect(Object.keys(KINDS)).toEqual([]);
    setKinds(undefined);
    expect(Object.keys(KINDS)).toEqual([]);
  });

  it('sorts by order, a view without one last', () => {
    setKinds([{ kind: 'b', order: 20, fields: [], line: [] }, { kind: 'none', fields: [], line: [] }, { kind: 'a', order: 10, fields: [], line: [] }]);
    expect(Object.keys(KINDS)).toEqual(['a', 'b', 'none']);
  });
});

describe('a kind the app does not know draws the unknown block face', () => {
  it('a neutral block that names the kind; nothing throws', () => {
    const html = face(step('nonesuch'));
    expect(html).toContain('data-kind="nonesuch"');
    expect(html).toContain('data-colour="soft"');
    expect(html).toContain('<b>unknown block nonesuch</b>');
    expect(html).toContain('aria-label="nonesuch nonesuch-1"');
    expect(html).not.toContain('data-stops');
  });

  it('inside a block that holds others, beside known ones, in the palette order of the workflow', () => {
    const html = face(step('say'), step('repeat', { kids: [step('ghost', { id: 'g' })] }), step('nonesuch'));
    expect(html).toContain('<b>unknown block ghost</b>');
    expect(html).toContain('<b>unknown block nonesuch</b>');
    expect(html).toContain('data-kind="say"');
    expect(html).toContain('data-kind="repeat"');
  });

  it('the name is shown visible-safe and cut', () => {
    const html = face(step(`no${RLO}ne`, { id: 'x' }));
    expect(html).toContain('<b>unknown block no&lt;U+202E&gt;ne</b>');
    expect(html).not.toContain(RLO + 'ne</b>');
    expect(html).toContain('aria-label="no&lt;U+202E&gt;ne x"'); // what a screen reader is given
    expect(unknownView('x'.repeat(100)).line[0]).toBe(`unknown block ${'x'.repeat(40)}...`);
    expect(unknownView('a\nb').line[0]).toBe('unknown block a\\nb');
  });

  it('a kind named like something on Object.prototype is just unknown', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(k in KINDS, k).toBe(false);
      expect(() => face(step(k, { id: 'p' })), k).not.toThrow();
      expect(face(step(k, { id: 'p' })), k).toContain(`unknown block ${k}`);
      expect(viewOf(k).fields, k).toEqual([]);
      expect(cleanStep({ id: 'p', kind: k, attrs: {}, cards: [], links: [] }), k).toBeUndefined();
    }
  });

  it('wires: the unknown block has no handle (the gray `next` is the fork\'s only)', () => {
    expect(wiresOf('nonesuch' as never)).toEqual([]);
    expect(face(step('nonesuch'))).not.toContain('data-lk=');
  });

  it('the readers in blocks, arrows, editor state and the palette do not throw', () => {
    const w = wf(step('say'), step('nonesuch'), step('ghost', { id: 'g', links: [{ kind: 'next', to: 'say-1' }] }), step('repeat', { kids: [step('nonesuch', { id: 'n2' })] }));
    expect(addStep(w, 'nonesuch' as never)).toBe(w);
    expect(addStep(w, 'nonesuch' as never, 'nonesuch-1')).toBe(w);
    expect(() => stackEnd(w)).not.toThrow();
    expect(dropPlace(w, { body: 'nonesuch-1', branch: 'kids' })).toBeUndefined();
    expect(dropPlace(w, { block: 'nonesuch-1', edge: 'into' })).toBeUndefined();
    expect(nestPlace(w, 'g', 'in')).toBeUndefined(); // the step before it is unknown: not a container
    expect(setCond(w, 'nonesuch-1', [], { t: 'approve' } as never)).toBe(w);
    expect(() => linksToDraw(w, new Map())).not.toThrow();
    expect(cleanStep({ id: 'a', kind: 'nonesuch', attrs: {}, cards: [], links: [] })).toBeUndefined();
    expect(() => palette()).not.toThrow();
  });

  it('a place inside an unknown block takes nothing; a new block of it is empty; free blocks of it get no `then` arrow', () => {
    const w = wf(step('say'), step('end'), step('ghost', { id: 'g1' }), step('ghost', { id: 'g2' }));
    expect(insertSteps(w, [step('say', { id: 'z' })], { parent: 'g1', branch: 'kids', index: 0 })).toBe(w);
    expect(moveStep(w, 'say-1', { parent: 'g1', branch: 'kids', index: 0 })).toBe(w);
    expect(freshOf('ghost' as never)).toEqual({});
    expect(linksToDraw(w, new Map()).then).toEqual([{ from: 'g1', to: 'g2' }]);
  });
});

describe('before the first reply KINDS is empty and nothing throws', () => {
  it('every reader of KINDS takes it', () => {
    setKinds([]);
    expect(Object.keys(KINDS)).toEqual([]);
    const w = wf(step('say'), step('repeat', { kids: [step('run', { id: 'r' })] }), step('end'));
    expect(() => face(...w.steps)).not.toThrow();
    expect(face(...w.steps)).toContain('<b>unknown block say</b>');
    expect(() => palette()).not.toThrow();
    expect(palette()).not.toContain('sx-card" data-kind');
    expect(capKind()).toBe('');
    expect(ensureEnd(w)).toBe(w);
    expect(addStep(w, 'say')).toBe(w);
    expect(stackEnd(w)).toBe(3);
    expect(dropPlace(w, { top: 'end' })).toEqual({ branch: 'kids', index: 3 });
    expect(dropPlace(w, { body: 'repeat-1', branch: 'kids' })).toBeUndefined();
    expect(nestPlace(w, 'r', 'in')).toBeUndefined();
    expect(setCond(w, 'repeat-1', [], { t: 'approve' } as never)).toBe(w);
    expect(() => linksToDraw(w, new Map())).not.toThrow();
    expect(cleanStep({ id: 'a', kind: 'say', attrs: {}, cards: [], links: [] })).toBeUndefined();
    expect(wiresOf('say')).toEqual([]);
  });

  it('then the list arrives and the same workflow draws its real faces', () => {
    setKinds([]);
    expect(face(step('say'))).toContain('unknown block say');
    setKinds(packServed().kinds);
    expect(face(step('say'))).not.toContain('unknown block');
    expect(face(step('say'))).toContain('data-colour="soft"');
    expect(capKind()).toBe('end');
  });
});
