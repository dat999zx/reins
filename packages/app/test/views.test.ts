import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NODES, type Step, type Workflow } from '@reins/core';
import { BlocksPane } from '../src/BlocksPane.js';
import { KINDS, registerView } from '../src/canvasKinds.js';
import { applyField } from '../src/panelEdit.js';

const step = (): Step => ({ id: 'x', kind: 'toy', attrs: {}, cards: [], links: [] }) as unknown as Step;
const toy = { kind: 'toy', fields: [{ key: 'times', label: 'Times', input: 'number' as const, check: 'count' as const }], line: ['toy'] };

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
const css = () => readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

describe('view files', () => {
  it('(a) every node kind has <kind>.view.ts and the folder holds exactly those', () => {
    for (const k of NODES.keys()) expect(existsSync(new URL(`${k}.view.ts`, nodesDir)), k).toBe(true);
    expect(viewFiles()).toHaveLength(13);
  });
  it('(b) each default export names the kind of its file', async () => {
    expect(viewFiles()).toHaveLength(13);
    for (const f of viewFiles()) {
      const mod = (await import(/* @vite-ignore */ new URL(f, nodesDir).href)) as { default: { kind: string } };
      expect(mod.default.kind, f).toBe(f.replace('.view.ts', ''));
    }
  });
  it('(c) imports are `import type` or from ./fields.js', () => {
    expect(viewFiles()).toHaveLength(13);
    for (const f of viewFiles()) {
      const imports = readFileSync(new URL(f, nodesDir), 'utf8').split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
      for (const l of imports) expect(l, f).toMatch(/^import type |from '\.\/fields\.js';$/);
    }
  });
});

describe('colour', () => {
  const COLOUR: Record<string, string> = {
    phase: 'soft', say: 'soft', run: 'hard', gate: 'gate', repeat: 'loop', if: 'loop', verify: 'verify', end: 'hand',
    recall: 'mem', store: 'mem', use: 'mine', model: 'mine', subagent: 'mine',
  };
  // before the move the table is read from the css, after it from the views
  const fromCss = () => Object.fromEntries([...css().matchAll(/^((?:\[data-kind='\w+'\](?:, )?)+) \{ --c: var\(--(\w+)\); \}$/gm)]
    .flatMap((m) => [...m[1]!.matchAll(/data-kind='(\w+)'/g)].map((k) => [k[1]!, m[2]!])));
  const table = () => (css().includes('[data-kind=') ? fromCss() : Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.colour])));
  it('every kind keeps its colour', () => { expect(table()).toEqual(COLOUR); });
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
    expect(Object.entries(KINDS).filter(([, v]) => v.icon).map(([k]) => k)).toEqual(['recall', 'store']);
    expect(Object.entries(KINDS).filter(([, v]) => v.slice).map(([k, v]) => [k, v.slice])).toEqual([['model', 'opens'], ['subagent', 'own']]);
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
    expect(applyField(s, 'times', 'x')).toBe(false);
    expect(applyField(s, 'times', '3')).toBe(true);
    expect(s.attrs.times).toBe('3');
    off();
    expect('toy' in KINDS).toBe(false);
    expect(applyField(s, 'times', 'x')).toBe(true);
  });
  it('throws on a kind that is already there', () => {
    expect(() => registerView({ ...toy, kind: 'phase' })).toThrow();
    const off = registerView(toy);
    expect(() => registerView(toy)).toThrow();
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
