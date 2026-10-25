import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NODES, type Step, type Workflow } from '@reins/core';
import { BlocksPane } from '../src/BlocksPane.js';
import { KINDS, registerView } from '../src/canvasKinds.js';
import { applyField } from '../src/panelEdit.js';
import { renderRow, rowTypes } from '../src/rows.js';
import { initial, reduce } from '../src/state.js';
import type { LogRow } from '@reins/server/store.js';
import { PACK_DIR, packMods } from '../../core/test/pack.js';

const step = (): Step => ({ id: 'x', kind: 'toy', attrs: {}, cards: [], links: [] }) as unknown as Step;
const toy = { kind: 'toy', fields: [{ key: 'toytimes', label: 'Times', input: 'number' as const, check: 'count' as const }], line: ['toy'] };

describe('fields.ts', () => {
  it('has only `import type` lines (the front side stays browser-safe)', () => {
    const text = readFileSync(new URL('../../core/src/nodes/fields.ts', import.meta.url), 'utf8');
    const imports = text.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/^import type /);
  });
});

const nodesDir = new URL('../../core/src/nodes/', import.meta.url);
const viewFiles = () => readdirSync(nodesDir).filter((f) => f.endsWith('.view.ts'));
// M3: a kind of the default pack has its view in its mod.json, not in a core file; every other kind keeps its <kind>.view.ts in core.
const packKinds = new Set(packMods(PACK_DIR).flatMap((p) => (p.manifest as { provides?: { kinds?: string[] } }).provides?.kinds ?? []));
const inCore = () => [...NODES.keys()].filter((k) => !packKinds.has(k));
const css = () => readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

describe('view files', () => {
  it('(a) every node kind has <kind>.view.ts and the folder holds exactly those', () => {
    for (const k of inCore()) expect(existsSync(new URL(`${k}.view.ts`, nodesDir)), k).toBe(true);
    for (const k of packKinds) expect(existsSync(new URL(`${k}.view.ts`, nodesDir)), `pack kind ${k} has no core view file`).toBe(false);
    expect(packKinds.size).toBeGreaterThan(0);
    expect(viewFiles()).toHaveLength(inCore().length);
  });
  it('(b) each default export names the kind of its file', async () => {
    expect(viewFiles()).toHaveLength(inCore().length);
    for (const f of viewFiles()) {
      const mod = (await import(/* @vite-ignore */ new URL(f, nodesDir).href)) as { default: { kind: string } };
      expect(mod.default.kind, f).toBe(f.replace('.view.ts', ''));
    }
  });
  it('(c) imports are `import type` or from ./fields.js', () => {
    expect(viewFiles()).toHaveLength(inCore().length);
    for (const f of viewFiles()) {
      const imports = readFileSync(new URL(f, nodesDir), 'utf8').split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
      for (const l of imports) expect(l, f).toMatch(/^import type |from '\.\/fields\.js';$/);
    }
  });
});

describe('colour', () => {
  const COLOUR: Record<string, string> = {
    phase: 'soft', say: 'soft', run: 'hard', gate: 'gate', repeat: 'loop', if: 'loop', verify: 'verify', end: 'hand',
    recall: 'mem', store: 'mem', model: 'mine', subagent: 'mine',
  };
  // before the move the table is read from the css, after it from the views
  const fromCss = () => Object.fromEntries([...css().matchAll(/^((?:\[data-kind='\w+'\](?:, )?)+) \{ --c: var\(--(\w+)\); \}$/gm)]
    .flatMap((m) => [...m[1]!.matchAll(/data-kind='(\w+)'/g)].map((k) => [k[1]!, m[2]!])));
  const table = () => (css().includes('[data-kind=') ? fromCss() : Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.colour])));
  // the 12 built-ins keep their colour; a kind added later is only checked to have one
  const builtIn = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => k in COLOUR));
  it('every kind keeps its colour', () => { expect(builtIn(table())).toEqual(COLOUR); });
  it('every node kind has some colour', () => { for (const k of NODES.keys()) expect(table()[k], k).toBeTruthy(); });
  it('app.css maps each colour, the round icon and the cap', () => {
    const text = css();
    if (!text.includes('[data-kind=')) {
      for (const c of new Set(Object.values(COLOUR))) expect(text, c).toContain(`[data-colour='${c}'] { --c: var(--${c}); }`);
      expect(text).toContain("[data-icon='round'].sx-card i { border-radius: 50%; }");
      expect(text).toContain(".sx-blk[data-stops] { border-radius: 6px 6px 12px 12px; }");
      expect(text).toContain(".sx-blk[data-stops]::after { content: none; }");
    } else {
      expect(text).toContain("[data-kind='recall'].sx-card i, [data-kind='store'].sx-card i { border-radius: 50%; }");
      expect(text).toContain(".sx-blk[data-kind='end'] { border-radius: 6px 6px 12px 12px; }");
    }
  });
  it('(d) app.css has no [data-kind= rule', () => { expect(css()).not.toContain('[data-kind='); });
  it('the views carry the icon and slice flags', () => {
    const own = Object.entries(KINDS).filter(([k]) => k in COLOUR);
    expect(own.filter(([, v]) => v.icon).map(([k]) => k)).toEqual(['recall', 'store']);
    expect(own.filter(([, v]) => v.slice).map(([k, v]) => [k, v.slice])).toEqual([['model', 'opens'], ['subagent', 'own']]);
  });
});

describe('the block element', () => {
  const face = (...steps: Step[]) => renderToStaticMarkup(createElement(BlocksPane, {
    w: { name: 't', budget: { turns: 10, minutes: 30 }, always: [], steps } as unknown as Workflow, steps: steps.map((s) => ({ id: s.id })), diags: [], text: '',
    sel: new Set<string>(), rev: 0, at: { x: 0, y: 0 }, models: [], sessionModel: { id: 'm', label: 'M' }, efforts: [], sessionEffort: { id: 'e', label: 'E' },
    onEdit: () => true, onSelect: () => {},
  } as never));
  const of = (kind: string) => face({ id: `${kind}-1`, kind, attrs: {}, cards: [], links: [] } as unknown as Step);
  it('(e) end has data-stops, phase has no data-stops attribute at all', () => {
    expect(of('end')).toContain('data-stops="true"');
    expect(of('phase')).not.toContain('data-stops');
    expect(of('end')).toContain('data-kind="end"');
    expect(of('end')).toContain('data-colour="hand"');
  });
});

describe('registerView', () => {
  it('a field with a check on a registered view is judged by it, until the disposer runs', () => {
    const off = registerView(toy);
    const s = step();
    expect(applyField(s, 'toytimes', 'x')).toBe(false);
    expect(applyField(s, 'toytimes', '3')).toBe(true);
    expect(s.attrs.toytimes).toBe('3');
    off();
    expect('toy' in KINDS).toBe(false);
    expect(applyField(s, 'toytimes', 'x')).toBe(true);
  });
  it('the disposer is one-shot: a second call does not remove a later registration of the same kind', () => {
    const off = registerView(toy);
    off();
    const off2 = registerView(toy);
    off();
    expect('toy' in KINDS).toBe(true);
    off2();
    expect('toy' in KINDS).toBe(false);
  });
  it('throws on a kind that is already there', () => {
    expect(() => registerView({ ...toy, kind: 'phase' })).toThrow();
    const off = registerView(toy);
    expect(() => registerView(toy)).toThrow();
    off();
  });
});

describe('rows a view brings', () => {
  const row = (type: string, data: unknown = {}) => ({ sessionId: 's', seq: 1, ts: 1, type, data }) as LogRow;
  const ctx = { sess: reduce(initial(), row('note'), 0).sessions.s!, act: { answer: async () => {}, resume: () => {} } };
  const draw = (r: LogRow) => renderToStaticMarkup(renderRow(r, ctx) as never);
  const beep = { text: 'beep x{n}', details: '{more}', className: 'sx-sub' };
  const toyRows = (rows: Record<string, unknown>) => ({ kind: 'toyrows', order: 99, colour: 'soft' as const, fields: [], line: [], rows: rows as never });

  it('draws a details row with an Md body, or a plain row without details, until the disposer runs', () => {
    const off = registerView(toyRows({ beeped: beep }));
    expect(rowTypes()).toContain('beeped');
    expect(draw(row('beeped', { n: 2, more: 'more' }))).toBe('<details class="row sx-sub"><summary>beep x2</summary><div class="md"><p>more</p></div></details>');
    expect(draw(row('beeped', { n: 3 }))).toBe('<div class="row sx-sub">beep x3</div>');
    off();
    expect(rowTypes()).not.toContain('beeped');
    expect(draw(row('beeped', { n: 2 }))).toContain('<summary>beeped</summary>');
  });
  it('a row file of the same type wins over a view row, and the type is listed once', () => {
    const real = draw(row('subagent_result', { title: 'r', text: 'found it' }));
    const off = registerView({ ...toyRows({ subagent_result: { text: 'toy' } }), kind: 'toyrows2' });
    expect(draw(row('subagent_result', { title: 'r', text: 'found it' }))).toBe(real);
    expect(rowTypes().filter((t) => t === 'subagent_result')).toHaveLength(1);
    off();
  });
});

describe('field rules', () => {
  it('no key carries two different check or unset across KINDS', () => {
    const seen = new Map<string, string>();
    for (const k of Object.values(KINDS)) {
      for (const f of k.fields) {
        const rule = JSON.stringify([f.check ?? null, f.unset ?? null]);
        expect(seen.get(f.key) ?? rule, f.key).toBe(rule);
        seen.set(f.key, rule);
      }
    }
  });
});
