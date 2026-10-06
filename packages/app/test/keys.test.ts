import { describe, expect, it } from 'vitest';
import { isTyping, KEYS, matchKey } from '../src/keys.js';

const ev = (key: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ key, ctrl: !!m.ctrl, shift: !!m.shift, alt: !!m.alt });

describe('keys', () => {
  it('every row matches its own event and no other row does', () => {
    for (const r of KEYS) {
      const hits = KEYS.filter((x) => x.on === r.on && matchKey(ev(x.key, { ctrl: x.ctrl, shift: x.shift, alt: x.alt }), r.on) === r.act);
      expect(matchKey(ev(r.key, { ctrl: r.ctrl, shift: r.shift, alt: r.alt }), r.on)).toBe(r.act);
      expect(hits.length).toBeGreaterThan(0);
    }
  });
  it('no two rows share key, modifiers and target', () => {
    const ids = KEYS.map((r) => [r.key.toLowerCase(), !!r.ctrl, !!r.shift, !!r.alt, r.on].join('|'));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('undo and redo', () => {
    expect(matchKey(ev('z', { ctrl: true }), 'any')).toBe('undo');
    expect(matchKey(ev('Z', { ctrl: true, shift: true }), 'any')).toBe('redo');
    expect(matchKey(ev('y', { ctrl: true }), 'any')).toBe('redo');
  });
  it('Delete and Backspace delete a block, not the viewport', () => {
    expect(matchKey(ev('Delete'), 'block')).toBe('delete');
    expect(matchKey(ev('Backspace'), 'block')).toBe('delete');
    expect(matchKey(ev('Delete'), 'any')).toBeUndefined();
  });
  it('Alt+arrows move and nest a block', () => {
    expect(matchKey(ev('ArrowUp', { alt: true }), 'block')).toBe('moveUp');
    expect(matchKey(ev('ArrowDown', { alt: true }), 'block')).toBe('moveDown');
    expect(matchKey(ev('ArrowRight', { alt: true }), 'block')).toBe('nestIn');
    expect(matchKey(ev('ArrowLeft', { alt: true }), 'block')).toBe('nestOut');
    expect(matchKey(ev('ArrowUp'), 'block')).toBeUndefined();
  });
  it('an extra modifier does not match', () => {
    expect(matchKey(ev('z', { ctrl: true, alt: true }), 'any')).toBeUndefined();
    expect(matchKey(ev('Escape', { shift: true }), 'any')).toBeUndefined();
  });
  it('isTyping is true for input, textarea and select only', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTyping(t)).toBe(true);
    for (const t of ['DIV', 'BUTTON']) expect(isTyping(t)).toBe(false);
  });
});
