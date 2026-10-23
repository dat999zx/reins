import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LogRow } from '@reins/server/store.js';
import { registerView } from '../src/canvasKinds.js';
import { renderRow } from '../src/rows.js';
import { initial, reduce } from '../src/state.js';
import { fill } from '../src/template.js';

describe('fill: paths', () => {
  const d = { title: 'T', attrs: { use: 'lint-fix', n: 0 }, id: 'use-1', list: ['a', 'b'], deep: { x: { y: 'Y' } }, flag: true, none: null };
  it('walks own properties', () => {
    expect(fill('{title}', d)).toBe('T');
    expect(fill('{attrs.use}', d)).toBe('lint-fix');
    expect(fill('{deep.x.y}', d)).toBe('Y');
    expect(fill('{list.1}', d)).toBe('b');
    expect(fill('a {id} b {attrs.n} c {flag}', d)).toBe('a use-1 b 0 c true');
  });
  it('fills inherited names, __proto__ and functions as empty', () => {
    for (const p of ['constructor', '__proto__', '__proto__.x', 'constructor.name', 'toString', 'hasOwnProperty', 'attrs.constructor', 'title.length', 'title.constructor', 'deep.__proto__.x']) {
      expect(fill(`[{${p}}]`, d), p).toBe('[]');
    }
    expect(fill('[{__proto__.x}]', JSON.parse('{"__proto__":{"x":"own"}}'))).toBe('[]');
  });
  it('fills a missing key, an object, an array, null and a bad index as empty', () => {
    for (const p of ['nope', 'deep', 'deep.x', 'list', 'none', 'list.2', 'list.-1', 'list.01x', 'title.0', 'attrs.nope.deeper']) expect(fill(`[{${p}}]`, d), p).toBe('[]');
  });
  it('never prints undefined, [object Object] or code', () => {
    const out = fill('{nope}{deep}{list}{constructor}{toString}{__proto__}', d);
    expect(out).toBe('');
  });
  it('does not call a getter', () => {
    let hit = 0;
    const g = { get a() { hit++; return 'x'; } };
    expect(fill('[{a}]', g)).toBe('[]');
    expect(hit).toBe(0);
  });
  it('fills from a null or plain-value data as empty', () => {
    expect(fill('[{a}]', null)).toBe('[]');
    expect(fill('[{a}]', 'str')).toBe('[]');
  });
});

describe('fill: first non-empty', () => {
  it('takes the first of a|b|c that has text', () => {
    const f = (d: object) => fill('{title|attrs.use|id}', d);
    expect(f({ title: 'T', attrs: { use: 'U' }, id: 'I' })).toBe('T');
    expect(f({ title: '', attrs: { use: 'U' }, id: 'I' })).toBe('U');
    expect(f({ attrs: {}, id: 'I' })).toBe('I');
    expect(f({ title: {}, attrs: { use: 'U' }, id: 'I' })).toBe('U');
    expect(f({})).toBe('');
  });
  it('picks the first, not the last, when several have text', () => {
    expect(fill('{a|b|c}', { a: '1', b: '2', c: '3' })).toBe('1');
    expect(fill('{c|b|a}', { a: '1', b: '2', c: '3' })).toBe('3');
  });
});

describe('fill: formats', () => {
  it('a format on a number that is not finite fills empty', () => {
    expect(fill('{n:usd}', { n: NaN })).toBe('');
    expect(fill('{n:count}', { n: Infinity })).toBe('');
    expect(fill('[{n:usd}]', { n: -Infinity })).toBe('[]');
  });

  it('usd is the dollar figure of the row files: a dollar sign and four decimals', () => {
    expect(fill('{cost:usd}', { cost: 0.0123 })).toBe('$0.0123');
    expect(fill('{cost:usd}', { cost: 1 })).toBe('$1.0000');
    expect(fill('{cost:usd}', { cost: 0.12345 })).toBe('$' + (0.12345).toFixed(4));
    expect(fill('{cost:usd}', { cost: 0.00005 })).toBe('$' + (0.00005).toFixed(4));
  });
  it('count is the en-US grouped number of the engine rows', () => {
    expect(fill('{n:count}', { n: 1234567 })).toBe('1,234,567');
    expect(fill('{n:count}', { n: 0 })).toBe('0');
  });
  it('a format of a non-number fills empty, and works over a|b', () => {
    expect(fill('[{cost:usd}]', { cost: 'x' })).toBe('[]');
    expect(fill('[{cost:usd}]', {})).toBe('[]');
    expect(fill('{a|b:usd}', { b: 2 })).toBe('$2.0000');
  });
  it('a format it does not know is not a template', () => {
    expect(fill('x {cost:eur} y', { cost: 1 })).toBe('x {cost:eur} y');
    expect(fill('x {cost:USD} y', { cost: 1 })).toBe('x {cost:USD} y');
  });
});

describe('fill: text and unparsable templates', () => {
  it('shows a hidden character of a filled value as <U+XXXX>', () => {
    expect(fill('{a}', { a: 'x‮y' })).toBe('x<U+202E>y');
    expect(fill('{a}', { a: 'x​y' })).toBe('x<U+200B>y');
    expect(fill('{a}', { a: 'l1\nl2' })).toBe('l1\\nl2');
    expect(fill('{a}', { a: 'l1\nl2' }, { lines: true })).toBe('l1\nl2');
    expect(fill('{a|b}', { a: '', b: 'q\u0007' })).toBe('q<U+0007>');
  });
  it('leaves plain text and a stray brace alone', () => {
    expect(fill('no fields', {})).toBe('no fields');
    expect(fill('a } b', {})).toBe('a } b');
  });
  it('shows an unparsable template as its literal text and does not throw', () => {
    for (const t of ['{', 'a {b', '{}', '{|}', '{a|}', '{a..b}', '{a:}', '{a:usd:count}', '{{a}}', '{a b']) {
      expect(() => fill(t, { a: 1, b: 2 }), t).not.toThrow();
      expect(fill(t, { a: 1, b: 2 }), t).toBe(t);
    }
    expect(fill('{a‮', {})).toBe('{a<U+202E>');
  });
});

describe('quoted words in a hole', () => {
  it("'word' is an alternative that always has text, so it is the fallback of a list", () => {
    expect(fill("{label|model|'the session model'}", {})).toBe('the session model');
    expect(fill("{label|model|'the session model'}", { model: 'm' })).toBe('m');
    expect(fill("{label|model|'the session model'}", { label: 'L', model: 'm' })).toBe('L');
    expect(fill("{label|model|'the session model'}", { label: '', model: '' })).toBe('the session model');
  });
  it("path?'word' gives the word when the data has a finite number or true there, and nothing for anything else", () => {
    const f = (d: unknown) => fill("[{on?'yes'}]", d);
    expect(f({ on: true })).toBe('[yes]');
    expect(f({ on: 0 })).toBe('[yes]');
    expect(f({ on: 1.5 })).toBe('[yes]');
    for (const on of [false, undefined, null, '', 'text', 'true', NaN, Infinity, [], {}, () => 1]) expect(f({ on }), String(on)).toBe('[]');
    expect(f({})).toBe('[]');
    expect(f(null)).toBe('[]');
    expect(f(JSON.parse('{"__proto__":{"on":true}}'))).toBe('[]');
    expect(fill("{resumed?'resumed'|'started'}", { resumed: true })).toBe('resumed');
    expect(fill("{resumed?'resumed'|'started'}", { resumed: false })).toBe('started');
  });
  it('the words go through showText like any filled value, and a word may hold spaces and a question mark', () => {
    expect(fill("a{n?' ('}{n:usd}{u?' + ?'}{n?')'}.", { n: 0.5, u: true })).toBe('a ($0.5000 + ?).');
    expect(fill("a{n?' ('}{n:usd}{u?' + ?'}{n?')'}.", {})).toBe('a.');
    expect(fill("{x?'a\u202Eb'}", { x: true })).toBe('a<U+202E>b');
  });
  it('a malformed quoted word is shown as the template is', () => {
    for (const t of ["{'a}", "{a'}", "{'a'b'}", "{'a|b'}", "{'a:b'}", "{a?'x}", "{?'x'}", "{a..b?'x'}", "{'a'?}"]) {
      expect(() => fill(t, { a: true }), t).not.toThrow();
      expect(fill(t, { a: true }), t).toBe(t);
    }
  });
});

describe('a row template', () => {
  const row = (type: string, data: unknown = {}) => ({ sessionId: 's', seq: 1, ts: 1, type, data }) as LogRow;
  const ctx = { sess: reduce(initial(), row('note'), 0).sessions.s!, act: { answer: async () => {}, resume: () => {} } };
  const draw = (r: LogRow) => renderToStaticMarkup(renderRow(r, ctx) as never);

  it('{cost:usd} prints as the turn_ended row file does', () => {
    const real = draw(row('turn_ended', { cost: 0.0123 }));
    expect(real).toContain('turn ended · $0.0123');
    expect(fill('turn ended · {cost:usd}', { cost: 0.0123 })).toBe('turn ended · $0.0123');
  });
  it('a view row is filled from the event data, and a details template makes a collapsible row', () => {
    const off = registerView({ kind: 'tplrows', order: 99, colour: 'soft', fields: [], line: [], rows: { beeped: { text: 'beeped x{times:count} ({cost:usd})', details: '{note}', className: 'sx-sub' } } });
    try {
      expect(draw(row('beeped', { times: 2000, cost: 0.5, note: 'hi' }))).toBe('<details class="row sx-sub"><summary>beeped x2,000 ($0.5000)</summary><div class="md"><p>hi</p></div></details>');
      expect(draw(row('beeped', { times: 2 }))).toBe('<div class="row sx-sub">beeped x2 ()</div>');
      expect(draw(row('beeped', { times: '‮' }))).toBe('<div class="row sx-sub">beeped x ()</div>');
    } finally { off(); }
  });
});
