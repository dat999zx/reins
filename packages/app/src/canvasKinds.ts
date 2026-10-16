import type { CardKind, StepKind } from '@reins/core';

import type { KindView } from '../../core/src/nodes/fields.js';
import type { WireKind } from './canvas.js';

export type { Field, KindView, Token } from '../../core/src/nodes/fields.js';

// Each kind's face is a view file in core, next to its node; the order field sets the palette order.
const views = Object.values(import.meta.glob<{ default: KindView }>('../../core/src/nodes/*.view.ts', { eager: true })).map((m) => m.default);
export const KINDS = {} as Record<StepKind, KindView>;
const kinds: Record<string, KindView> = KINDS;
// Re-sorts in place: importers hold this object. A view without an order goes last, in the order it came.
const fill = (all: (Omit<KindView, 'order' | 'colour'> & Partial<KindView>)[]) => {
  const sorted = all.map((v) => v as KindView).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  for (const k of Object.keys(kinds)) delete kinds[k];
  for (const v of sorted) kinds[v.kind] = v;
};
fill(views);

// Adds a view for tests and later kinds; the disposer takes it out again.
export function registerView(v: Omit<KindView, 'order' | 'colour'> & Partial<KindView>): () => void {
  if (v.kind in kinds) throw new Error(`a view for ${v.kind} is already registered`);
  fill([...Object.values(kinds), v]);
  return () => { delete kinds[v.kind]; };
}

// The one kind that ends the workflow.
export const capKind = (): StepKind => Object.values(KINDS).find((v) => v.stops)!.kind as StepKind;
// The handles on a block, top to bottom.
export const wiresOf = (kind: StepKind): WireKind[] => {
  const k = KINDS[kind];
  return k.stops ? [] : ['next', ...(k.fails ? ['on-fail' as const] : []), ...(k.against ? ['against' as const] : [])];
};

// The card kinds a block holds; whenever-only kinds (now, stop) are left out.
// guard is enforced in core/src/policy.ts: the tool-approval hook blocks edits to a matching path and shell commands naming one.
export const CARD_KINDS = ['guard'] as const satisfies readonly CardKind[];
// The words the panel uses for a kind: a second kind is one entry here.
export const CARD_LABEL: Record<(typeof CARD_KINDS)[number], { section: string; add: string }> = {
  guard: { section: 'Guards', add: 'Add guard' },
};
