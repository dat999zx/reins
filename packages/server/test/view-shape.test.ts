import { describe, expect, it } from 'vitest';
import { kindOf, ROW_CLASSES } from '../src/mods/kinds.js';
import { Registry } from '../src/mods/registry.js';

const view = (extra: Record<string, unknown> = {}) => ({ kind: 'toy', order: 9, colour: 'soft', fields: [], line: ['toy'], ...extra });
const check = (v: unknown) => kindOf('block')!.validate({ kind: 'block', main: 'x.js', order: 1, provides: { kinds: ['toy'], events: ['say', 'note', 'step_ended'] }, view: v }, { id: 'toy', registry: new Registry() });
const rows = (r: unknown) => check(view({ rows: { say: r } }));
const one = (out: unknown[]) => out.map(String).join('\n');

describe('a block mod view: sub and rows', () => {
  it('accepts a plain view with sub and rows', () => {
    expect(check(view({ sub: 'beeps {n}', rows: { say: { text: 'hi', details: 'more', className: 'sx-sub' }, note: { text: 'x', className: 'faint' }, step_ended: { text: 'plain' } } }))).toEqual([]);
  });

  it('refuses a sub that is not text, or too long', () => {
    expect(one(check(view({ sub: 5 })))).toMatch(/view\.sub/);
    expect(one(check(view({ sub: 'a'.repeat(201) })))).toMatch(/view\.sub/);
    expect(check(view({ sub: 'a'.repeat(200) }))).toEqual([]);
  });

  it('refuses rows that is not an object, or a row that is not', () => {
    expect(one(check(view({ rows: [] })))).toMatch(/view\.rows/);
    expect(one(check(view({ rows: 'x' })))).toMatch(/view\.rows/);
    for (const r of [null, 'x', 5, []]) expect(one(rows(r)), String(r)).toMatch(/view\.rows\.say/);
  });

  it('refuses a key besides text, details and className', () => {
    expect(one(rows({ text: 'a', onClick: 'x' }))).toMatch(/view\.rows\.say.*onClick/);
    expect(one(rows({ text: 'a', style: 'x' }))).toMatch(/style/);
  });

  it('needs text, as text, at most 200 characters', () => {
    expect(one(rows({}))).toMatch(/view\.rows\.say.*text/);
    expect(one(rows({ text: 3 }))).toMatch(/text/);
    expect(one(rows({ text: 'a'.repeat(201) }))).toMatch(/text/);
    expect(rows({ text: 'a'.repeat(200) })).toEqual([]);
  });

  it('keeps details to text of at most 400 characters', () => {
    expect(one(rows({ text: 'a', details: 3 }))).toMatch(/details/);
    expect(one(rows({ text: 'a', details: 'b'.repeat(401) }))).toMatch(/details/);
    expect(rows({ text: 'a', details: 'b'.repeat(400) })).toEqual([]);
  });

  it('allows only the classes the built-in views use', () => {
    expect(ROW_CLASSES).toEqual(['sx-sub', 'faint']);
    for (const c of ['bad', 'row bad', 'sx-sub faint', '', 5, null, 'constructor', '__proto__']) expect(one(rows({ text: 'a', className: c })), String(c)).toMatch(/className/);
  });

  it('refuses a hidden character in a row or sub, naming the view', () => {
    for (const bad of ['a‮b', 'a​b', 'a\nb', 'a\u0000b']) {
      expect(one(rows({ text: bad })), JSON.stringify(bad)).toMatch(/view/);
      expect(one(rows({ text: 'a', details: bad })), JSON.stringify(bad)).toMatch(/view/);
      expect(one(check(view({ sub: bad }))), JSON.stringify(bad)).toMatch(/view/);
    }
  });

  it('does not take an event type that is an inherited name as a harmless one', () => {
    expect(one(check(view({ rows: JSON.parse('{"__proto__":{"text":3}}') })))).toMatch(/view\.rows/);
  });
});
