import { describe, expect, it } from 'vitest';
import { changed, emptyHistory, push, redo, undo, type Entry } from '../src/history.js';

const e = (a: string, b: string, la = 0, lb = 0): Entry => ({ before: { text: a, lay: la ? { script: { x: la, y: 0 } } : {} }, after: { text: b, lay: lb ? { script: { x: lb, y: 0 } } : {} } });

describe('history', () => {
  it('undo then redo round-trips and moves the entry between the sides', () => {
    const h = push(emptyHistory(), e('a', 'b'));
    const u = undo(h, 'b');
    expect(u).not.toBe('stale');
    if (!u || u === 'stale') return;
    expect(u.to.text).toBe('a');
    expect(u.h.done).toHaveLength(0);
    const r = redo(u.h, 'a');
    expect(r && r !== 'stale' && r.to.text).toBe('b');
    expect(r && r !== 'stale' && r.h.done).toHaveLength(1);
  });
  it('an entry that changes neither text nor layout is ignored', () => {
    expect(push(emptyHistory(), e('a', 'a')).done).toHaveLength(0);
    expect(push(emptyHistory(), e('a', 'a', 1, 2)).done).toHaveLength(1);
    expect(changed(e('a', 'a').before, e('a', 'a').after)).toBe(false);
  });
  it('a new entry clears the redo side', () => {
    const u = undo(push(emptyHistory(), e('a', 'b')), 'b');
    if (!u || u === 'stale') throw new Error('no undo');
    expect(u.h.undone).toHaveLength(1);
    expect(push(u.h, e('a', 'c')).undone).toHaveLength(0);
  });
  it('keeps the newest 100 entries', () => {
    let h = emptyHistory();
    for (let i = 0; i < 105; i++) h = push(h, e(String(i), String(i + 1)));
    expect(h.done).toHaveLength(100);
    expect(h.done[0]!.before.text).toBe('5');
  });
  it('is stale when the text is not the one the entry produced', () => {
    const h = push(emptyHistory(), e('a', 'b'));
    expect(undo(h, 'typed')).toBe('stale');
    const u = undo(h, 'b');
    if (!u || u === 'stale') throw new Error('no undo');
    expect(redo(u.h, 'typed')).toBe('stale');
  });
  it('has nothing to undo or redo when empty', () => {
    expect(undo(emptyHistory(), 'a')).toBeUndefined();
    expect(redo(emptyHistory(), 'a')).toBeUndefined();
  });
});
