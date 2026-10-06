export type ActName = 'delete' | 'select' | 'moveUp' | 'moveDown' | 'nestIn' | 'nestOut' | 'undo' | 'redo' | 'escape' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'fit' | 'selectAll' | 'copy' | 'cut' | 'paste' | 'duplicate' | 'menu' | 'park' | 'putEnd' | 'editInText' | 'deleteLink';
export type On = 'block' | 'link' | 'any';
type Row = { key: string; ctrl?: true; shift?: true; alt?: true; on: On; act: ActName };

export const isTyping = (tag: string) => tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

// ponytail: Fit is Shift+1, which reports key "!" on a US layout only
export const KEYS: ReadonlyArray<Row> = [
  { key: 'Delete', on: 'block', act: 'delete' },
  { key: 'Backspace', on: 'block', act: 'delete' },
  { key: 'Delete', on: 'link', act: 'deleteLink' },
  { key: 'Backspace', on: 'link', act: 'deleteLink' },
  { key: 'Enter', on: 'block', act: 'select' },
  { key: ' ', on: 'block', act: 'select' },
  { key: 'ArrowUp', alt: true, on: 'block', act: 'moveUp' },
  { key: 'ArrowDown', alt: true, on: 'block', act: 'moveDown' },
  { key: 'ArrowRight', alt: true, on: 'block', act: 'nestIn' },
  { key: 'ArrowLeft', alt: true, on: 'block', act: 'nestOut' },
  { key: 'z', ctrl: true, on: 'any', act: 'undo' },
  { key: 'z', ctrl: true, shift: true, on: 'any', act: 'redo' },
  { key: 'y', ctrl: true, on: 'any', act: 'redo' },
  { key: 'a', ctrl: true, on: 'any', act: 'selectAll' },
  { key: 'c', ctrl: true, on: 'any', act: 'copy' },
  { key: 'x', ctrl: true, on: 'any', act: 'cut' },
  { key: 'v', ctrl: true, on: 'any', act: 'paste' },
  { key: 'd', ctrl: true, on: 'any', act: 'duplicate' },
  { key: 'Escape', on: 'any', act: 'escape' },
  { key: 'ContextMenu', on: 'any', act: 'menu' },
  { key: 'F10', shift: true, on: 'any', act: 'menu' },
  { key: '=', ctrl: true, on: 'any', act: 'zoomIn' },
  { key: '+', ctrl: true, shift: true, on: 'any', act: 'zoomIn' },
  { key: '-', ctrl: true, on: 'any', act: 'zoomOut' },
  { key: '0', ctrl: true, on: 'any', act: 'zoomReset' },
  { key: '!', shift: true, on: 'any', act: 'fit' },
];

// `ctrl` is Ctrl or Cmd. A row on 'any' applies to a block too.
export function matchKey(e: { key: string; ctrl: boolean; shift: boolean; alt: boolean }, on: On): ActName | undefined {
  return KEYS.find((r) => (r.on === 'any' || r.on === on) && r.key.toLowerCase() === e.key.toLowerCase()
    && !!r.ctrl === e.ctrl && !!r.shift === e.shift && !!r.alt === e.alt)?.act;
}
