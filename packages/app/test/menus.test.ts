import { describe, expect, it } from 'vitest';
import { itemsFor, MENUS, type Item, type MenuCtx } from '../src/menus.js';

const ctx = (c: Partial<MenuCtx> = {}): MenuCtx => ({ count: 1, topLevel: true, free: false, isEnd: false, clip: false, ...c });
const acts = (items: Item[]) => items.map((i) => (i === '-' ? '-' : i.act));

describe('menus', () => {
  it('a block gets the edit items, park and Edit in Text', () => {
    expect(acts(itemsFor('block', ctx()))).toEqual(['duplicate', 'copy', 'cut', 'delete', '-', 'park', '-', 'editInText']);
  });
  it('Edit in Text is single only; several blocks keep the rest and the separators stay tidy', () => {
    expect(acts(itemsFor('block', ctx({ count: 3 })))).toEqual(['duplicate', 'copy', 'cut', 'delete', '-', 'park']);
  });
  it('a loose block can be put into the script, and cannot be parked', () => {
    expect(acts(itemsFor('loose', ctx()))).toEqual(['duplicate', 'copy', 'cut', 'delete', '-', 'putEnd']);
  });
  it('a link can be deleted or opened in Text', () => {
    expect(acts(itemsFor('link', ctx()))).toEqual(['deleteLink', 'editInText']);
  });
  it('the surface offers Paste only with a clipboard', () => {
    expect(acts(itemsFor('surface', ctx()))).toEqual(['selectAll', '-', 'fit', 'zoomReset']);
    expect(acts(itemsFor('surface', ctx({ clip: true })))).toEqual(['paste', 'selectAll', '-', 'fit', 'zoomReset']);
  });
  it('no menu starts or ends with a separator, or has two in a row', () => {
    for (const t of Object.keys(MENUS) as Array<keyof typeof MENUS>) for (const c of [ctx(), ctx({ count: 2 }), ctx({ clip: true })]) {
      const a = acts(itemsFor(t, c));
      expect(a[0]).not.toBe('-');
      expect(a.at(-1)).not.toBe('-');
      expect(a.join(',')).not.toContain('-,-');
    }
  });
  it('a hint comes with the shortcut', () => {
    const del = itemsFor('block', ctx()).find((i) => i !== '-' && i.act === 'delete');
    expect(del).toMatchObject({ label: 'Delete', hint: 'Del' });
  });
});
