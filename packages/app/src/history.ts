import type { Layout } from './editorState.js';

export type Snap = { text: string; lay: Layout; prev?: unknown }; // prev: the preview that matches `text`; not compared by changed()
export type Entry = { before: Snap; after: Snap };
export type History = { done: Entry[]; undone: Entry[] };

export const emptyHistory = (): History => ({ done: [], undone: [] });
export const changed = (a: Snap, b: Snap) => a.text !== b.text || JSON.stringify(a.lay) !== JSON.stringify(b.lay);

export const push = (h: History, e: Entry, cap = 100): History =>
  changed(e.before, e.after) ? { done: [...h.done, e].slice(-cap), undone: [] } : h;

// An entry applies only to the text it was recorded against; anything else was typed in the Text tab.
export function undo(h: History, text: string): { h: History; to: Snap } | 'stale' | undefined {
  const e = h.done.at(-1);
  if (!e) return undefined;
  return e.after.text !== text ? 'stale' : { h: { done: h.done.slice(0, -1), undone: [...h.undone, e] }, to: e.before };
}

export function redo(h: History, text: string): { h: History; to: Snap } | 'stale' | undefined {
  const e = h.undone.at(-1);
  if (!e) return undefined;
  return e.before.text !== text ? 'stale' : { h: { done: [...h.done, e], undone: h.undone.slice(0, -1) }, to: e.after };
}
