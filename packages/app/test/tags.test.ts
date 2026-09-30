import { describe, it, expect } from 'vitest';
import type { TagEntry } from '@reins/server/tags.js';
import { chipsToTags, filterTags, missingArg, pickerFor, takeTag } from '../src/tags.js';

const cat: TagEntry[] = [
  { name: 'gate', place: 'after', enforced: true },
  { name: 'until', place: 'wrap', arg: 'until', argRequired: true, enforced: true },
  { name: 'read-only', place: 'attr', argRequired: false, enforced: true },
  { name: 'steer', place: 'card', arg: 'steer', argRequired: true, enforced: false },
];

describe('filterTags', () => {
  it('lists everything for a bare #, and filters by prefix, ignoring case', () => {
    expect(filterTags(cat, '')).toHaveLength(4);
    expect(filterTags(cat, 'G').map((t) => t.name)).toEqual(['gate']);
    expect(filterTags(cat, 're').map((t) => t.name)).toEqual(['read-only']);
    expect(filterTags(cat, '12')).toEqual([]);
  });
});

describe('pickerFor', () => {
  it('opens for a #word at the start of a word before the caret', () => {
    expect(pickerFor('fix #ga', 7, cat)).toMatchObject({ start: 4, end: 7, matches: [{ name: 'gate' }] });
    expect(pickerFor('#', 1, cat)?.matches).toHaveLength(4);
    expect(pickerFor('a #gate more', 7, cat)?.end).toBe(7);
  });

  it('stays closed mid-word, when nothing matches, and away from a #word', () => {
    expect(pickerFor('C#', 2, cat)).toBeNull();
    expect(pickerFor('fix #12', 7, cat)).toBeNull();
    expect(pickerFor('plain text', 5, cat)).toBeNull();
    expect(pickerFor('#gate done', 10, cat)).toBeNull();
  });
});

describe('takeTag', () => {
  it('removes the #word and the space before it, and returns the caret', () => {
    expect(takeTag('fix #ga now', { start: 4, end: 7 })).toEqual({ text: 'fix now', caret: 3 });
    expect(takeTag('#ga', { start: 0, end: 3 })).toEqual({ text: '', caret: 0 });
    expect(takeTag('fix #ga', { start: 4, end: 7 })).toEqual({ text: 'fix', caret: 3 });
  });
});

describe('chips', () => {
  it('converts chips to tags, trimming the arg and leaving out an empty one', () => {
    expect(chipsToTags([{ tag: 'gate' }, { tag: 'until', arg: ' tests pass ' }, { tag: 'x', arg: '  ' }])).toEqual([
      { tag: 'gate' }, { tag: 'until', arg: 'tests pass' }, { tag: 'x' },
    ]);
  });

  it('names the first chip whose required argument is empty', () => {
    expect(missingArg([{ tag: 'gate' }, { tag: 'until', arg: ' ' }], cat)).toBe('until');
    expect(missingArg([{ tag: 'until', arg: 'x' }, { tag: 'read-only' }], cat)).toBeNull();
    expect(missingArg([{ tag: 'unknown' }], cat)).toBeNull();
  });
});
