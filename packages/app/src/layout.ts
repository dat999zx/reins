import type { Step } from '@reins/core';
import { KINDS } from './canvasKinds.js';

export type Pos = { x: number; y: number };
export type Box = Pos & { w: number; h: number; elseX?: number };
export const NODE_W = 220, NODE_H = 56, GAP = 28, PAD = 16, HEAD = 34;

type Size = { w: number; h: number; elseX?: number };

// ponytail: auto positions ignore saved ones, and a group grown by a saved child does not push the boxes below it down, so boxes can overlap; lay out around saved boxes if it bites
export function layout(steps: Step[], saved: Record<string, Pos> = {}): Record<string, Box> {
  const out: Record<string, Box> = {};

  // Places a list as a centred column at (ox, oy); returns its size.
  const column = (list: Step[], ox: number, oy: number): { w: number; h: number } => {
    const sizes = list.map(size);
    const w = Math.max(NODE_W, ...sizes.map((z) => z.w));
    let y = oy;
    list.forEach((st, i) => {
      const z = sizes[i]!;
      out[st.id] = { ...z, x: ox + (w - z.w) / 2, y };
      y += z.h + GAP;
    });
    return { w, h: list.length ? y - GAP - oy : 0 };
  };

  // Lays out a step's children (relative to it) and returns the step's own size.
  const size = (st: Step): Size => {
    const group = KINDS[st.kind].group;
    if (group === undefined) return { w: NODE_W, h: NODE_H };
    if (group === 'kids') {
      if (!st.kids?.length) return { w: NODE_W, h: HEAD + PAD };
      const c = column(st.kids, PAD, HEAD);
      return { w: PAD + c.w + PAD, h: HEAD + c.h + PAD };
    }
    const then = column(st.kids ?? [], PAD, HEAD);
    const elseX = PAD + then.w + GAP;
    const els = column(st.else ?? [], elseX, HEAD);
    return { w: elseX + els.w + PAD, h: HEAD + Math.max(then.h, els.h) + PAD, elseX };
  };

  column(steps, 0, 0);

  for (const [id, p] of Object.entries(saved)) if (out[id]) { out[id].x = p.x; out[id].y = p.y; }

  // Deepest first: a child grows its group, which may then grow its own parent.
  const grow = (st: Step) => {
    const kids = [...(st.kids ?? []), ...(st.else ?? [])];
    if (!kids.length) return;
    kids.forEach(grow);
    const g = out[st.id]!;
    g.w = Math.max(g.w, ...kids.map((k) => out[k.id]!.x + out[k.id]!.w + PAD));
    g.h = Math.max(g.h, ...kids.map((k) => out[k.id]!.y + out[k.id]!.h + PAD));
  };
  steps.forEach(grow);

  return out;
}
