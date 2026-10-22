import type { CardKind, StepKind } from '@reins/core';

import { showText } from '../../core/src/display.js';
import type { KindView } from '../../core/src/nodes/fields.js';
import type { WireKind } from './canvas.js';

export type { Field, KindView, Token } from '../../core/src/nodes/fields.js';

// The faces of the blocks come from the server (`GET /api/kinds`, read in App.tsx); the app holds no list of its own. Empty until the first reply.
// No prototype: a kind named `constructor` or `__proto__` in a workflow is not found, rather than finding Object's.
export type ServedView = KindView & { trusted?: false }; // trusted: false = a mod's block whose code has not been trusted yet
export const KINDS: Record<StepKind, ServedView> = Object.create(null);
const kinds: Record<string, ServedView> = KINDS;
// Re-sorts in place: importers hold this object. A view without an order goes last, in the order it came.
const fill = (all: (Omit<ServedView, 'order' | 'colour'> & Partial<ServedView>)[]) => {
  const sorted = all.map((v) => v as ServedView).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  for (const k of Object.keys(kinds)) delete kinds[k];
  for (const v of sorted) kinds[v.kind] = v;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Fills KINDS from the server's list. An entry that is not a view (no kind, fields or line) is left out: the server checks, the app does not trust.
export function setKinds(list: unknown): void {
  fill(Array.isArray(list) ? list.filter((v): v is ServedView => isObj(v) && typeof v.kind === 'string' && Array.isArray(v.fields) && Array.isArray(v.line)) : []);
}

// Adds a view for tests and later kinds; the disposer takes it out again.
export function registerView(v: Omit<ServedView, 'order' | 'colour'> & Partial<ServedView>): () => void {
  if (v.kind in kinds) throw new Error(`a view for ${v.kind} is already registered`);
  fill([...Object.values(kinds), v]);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    delete kinds[v.kind];
  };
}

// The face of a kind the app does not know (a workflow names a block that is not loaded): a neutral block that says so, with the name shown safe.
const cut = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);
export const unknownView = (kind: string): ServedView => ({ kind, order: 1e9, colour: 'soft', fields: [], line: [`unknown block ${showText(cut(kind))}`] });
// What to draw for a kind: its view, or the unknown face.
export const viewOf = (kind: string): ServedView => kinds[kind] ?? unknownView(kind);

// The one kind that ends the workflow. Empty (no block can be made of it) until the list has come.
export const capKind = (): StepKind => (Object.values(KINDS).find((v) => v.stops)?.kind ?? '') as StepKind;
// The handles on a block, top to bottom.
export const wiresOf = (kind: StepKind): WireKind[] => {
  const k = viewOf(kind);
  return k.stops ? [] :['next', ...(k.fails ? ['on-fail' as const] : []), ...(k.against ? ['against' as const] : [])];
};

// The card kinds a block holds, and the words the panel uses for each; both come from the server (`GET /api/kinds`) in core's order and are empty
// until the first reply. A card kind with no words is not offered (whenever-only kinds, now and stop, have none).
// guard is enforced in core/src/policy.ts: the tool-approval hook blocks edits to a matching path and shell commands naming one.
export const CARD_KINDS: CardKind[] = [];
export const CARD_LABEL: Record<string, { section: string; add: string }> = Object.create(null);
// Fills the cards in place (importers hold these). An entry without a kind, section and add is left out.
export function setCards(list: unknown): void {
  CARD_KINDS.length = 0;
  for (const k of Object.keys(CARD_LABEL)) delete CARD_LABEL[k];
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (!isObj(c) || typeof c.kind !== 'string' || typeof c.section !== 'string' || typeof c.add !== 'string') continue;
    CARD_KINDS.push(c.kind as CardKind);
    CARD_LABEL[c.kind] = { section: c.section, add: c.add };
  }
}
