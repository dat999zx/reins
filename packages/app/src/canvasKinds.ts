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

// The card kinds a block holds; whenever-only kinds (now, stop) are left out.
// guard is enforced in core/src/policy.ts: the tool-approval hook blocks edits to a matching path and shell commands naming one.
export const CARD_KINDS = ['guard'] as const satisfies readonly CardKind[];
// The words the panel uses for a kind: a second kind is one entry here.
export const CARD_LABEL: Record<(typeof CARD_KINDS)[number], { section: string; add: string }> = {
  guard: { section: 'Guards', add: 'Add guard' },
};
