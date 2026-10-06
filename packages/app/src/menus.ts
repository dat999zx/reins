import type { ActName } from './keys.js';

export type MenuTarget = 'block' | 'loose' | 'link' | 'surface';
export type MenuCtx = { count: number; topLevel: boolean; free: boolean; isEnd: boolean; clip: boolean };
export type Item = { label: string; act: ActName; hint?: string; when?: (c: MenuCtx) => boolean } | '-';

const edit: Item[] = [
  { label: 'Duplicate', act: 'duplicate', hint: 'Ctrl+D' },
  { label: 'Copy', act: 'copy', hint: 'Ctrl+C' },
  { label: 'Cut', act: 'cut', hint: 'Ctrl+X' },
  { label: 'Delete', act: 'delete', hint: 'Del' },
  '-',
];

export const MENUS: Record<MenuTarget, Item[]> = {
  block: [...edit, { label: 'Park (leaves the workflow)', act: 'park' }, '-', { label: 'Edit in Text', act: 'editInText', when: (c) => c.count === 1 }],
  loose: [...edit, { label: 'Put into script at the end', act: 'putEnd' }],
  link: [{ label: 'Delete link', act: 'deleteLink', hint: 'Del' }, { label: 'Edit in Text', act: 'editInText' }],
  surface: [
    { label: 'Paste', act: 'paste', hint: 'Ctrl+V', when: (c) => c.clip },
    { label: 'Select all', act: 'selectAll', hint: 'Ctrl+A' },
    '-',
    { label: 'Fit view', act: 'fit', hint: 'Shift+1' },
    { label: 'Reset zoom', act: 'zoomReset', hint: 'Ctrl+0' },
  ],
};

export function itemsFor(t: MenuTarget, c: MenuCtx): Item[] {
  const out: Item[] = [];
  for (const i of MENUS[t]) if (i === '-' ? out.length && out.at(-1) !== '-' : !i.when || i.when(c)) out.push(i);
  if (out.at(-1) === '-') out.pop();
  return out;
}
