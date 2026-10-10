import { describe, expect, it } from 'vitest';
import { isTyping, KEYS, matchKey } from '../src/keys.js';

const ev = (key: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ key, ctrl: !!m.ctrl, shift: !!m.shift, alt: !!m.alt });

describe('keys', () => {
  it('every row matches its own event and no other row does', () => {
    for (const r of KEYS) {
      const e = ev(r.key, { ctrl: r.ctrl, shift: r.shift, alt: r.alt });
      const hits = KEYS.filter((x) => (x.on === 'any' || x.on === r.on) && x.key.toLowerCase() === e.key.toLowerCase() && !!x.ctrl === e.ctrl && !!x.shift === e.shift && !!x.alt === e.alt);
      expect(matchKey(e, r.on)).toBe(r.act);
      expect(hits).toEqual([r]);
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
  it('Delete and Backspace on the viewport delete the selection (Select all and a box leave the focus there)', () => {
    expect(matchKey(ev('Delete'), 'view')).toBe('delete');
    expect(matchKey(ev('Backspace'), 'view')).toBe('delete');
  });
  it('Delete and Backspace on a link arrow delete the link', () => {
    expect(matchKey(ev('Delete'), 'link')).toBe('deleteLink');
    expect(matchKey(ev('Backspace'), 'link')).toBe('deleteLink');
    expect(matchKey(ev('ContextMenu'), 'link')).toBe('menu');
    expect(matchKey(ev('Enter'), 'link')).toBeUndefined();
  });
  it('Alt+arrows move and nest a block', () => {
    expect(matchKey(ev('ArrowUp', { alt: true }), 'block')).toBe('moveUp');
    expect(matchKey(ev('ArrowDown', { alt: true }), 'block')).toBe('moveDown');
    expect(matchKey(ev('ArrowRight', { alt: true }), 'block')).toBe('nestIn');
    expect(matchKey(ev('ArrowLeft', { alt: true }), 'block')).toBe('nestOut');
    expect(matchKey(ev('ArrowUp'), 'block')).toBe('focusPrev');
  });
  it('Ctrl+A selects all, from the viewport or a block', () => {
    expect(matchKey(ev('a', { ctrl: true }), 'any')).toBe('selectAll');
    expect(matchKey(ev('A', { ctrl: true }), 'block')).toBe('selectAll');
    expect(matchKey(ev('a'), 'any')).toBeUndefined();
  });
  it('copy, cut, paste and duplicate are Ctrl rows on the viewport or a block', () => {
    for (const [key, act] of [['c', 'copy'], ['x', 'cut'], ['v', 'paste'], ['d', 'duplicate']] as const) {
      expect(matchKey(ev(key, { ctrl: true }), 'any')).toBe(act);
      expect(matchKey(ev(key.toUpperCase(), { ctrl: true }), 'block')).toBe(act);
      expect(matchKey(ev(key), 'any')).toBeUndefined();
    }
  });
  it('the ContextMenu key and Shift+F10 open the menu, from the viewport or a block', () => {
    for (const on of ['any', 'block'] as const) {
      expect(matchKey(ev('ContextMenu'), on)).toBe('menu');
      expect(matchKey(ev('F10', { shift: true }), on)).toBe('menu');
    }
    expect(matchKey(ev('F10'), 'any')).toBeUndefined();
  });
  it('Up / Down move the focus between blocks, Shift extends the selection; the viewport pans with the arrows', () => {
    for (const on of ['block', 'positioned'] as const) {
      expect(matchKey(ev('ArrowUp'), on)).toBe('focusPrev');
      expect(matchKey(ev('ArrowDown'), on)).toBe('focusNext');
      expect(matchKey(ev('ArrowUp', { shift: true }), on)).toBe('extendPrev');
      expect(matchKey(ev('ArrowDown', { shift: true }), on)).toBe('extendNext');
    }
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(matchKey(ev(key), 'view')).toBe('pan');
      expect(matchKey(ev(key), 'any')).toBeUndefined();
      expect(matchKey(ev(key, { alt: true }), 'positioned')).toBe('nudge');
    }
    expect(matchKey(ev('ArrowLeft'), 'block')).toBeUndefined();
  });
  it('Alt+arrows never mean both: a free or loose block nudges, a stack block moves, the viewport does nothing', () => {
    expect(matchKey(ev('ArrowUp', { alt: true }), 'positioned')).toBe('nudge');
    expect(matchKey(ev('ArrowUp', { alt: true }), 'block')).toBe('moveUp');
    expect(matchKey(ev('ArrowRight', { alt: true }), 'block')).toBe('nestIn');
    expect(matchKey(ev('ArrowUp', { alt: true }), 'view')).toBeUndefined();
  });
  it('a free or loose block still answers the block keys', () => {
    expect(matchKey(ev('Delete'), 'positioned')).toBe('delete');
    expect(matchKey(ev('Enter'), 'positioned')).toBe('select');
    expect(matchKey(ev('Enter'), 'view')).toBeUndefined();
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
