import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Step } from '@reins/core';
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
