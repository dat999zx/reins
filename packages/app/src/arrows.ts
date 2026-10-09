import type { Workflow } from '@reins/core';
import { splitAtEnd } from './arrange.js';
import { edgeId, flatSteps, type Mark } from './canvas.js';
import { KINDS } from './canvasKinds.js';
import type { Pt, Rect } from './surface.js';

export type LinkRef = { from: string; index: number; kind: string; to: string };
export type LinkArrow = LinkRef & { mark?: Mark };

export function linksToDraw(w: Workflow, wires: Map<string, Mark>): { arrows: LinkArrow[]; missing: LinkRef[]; then: Array<{ from: string; to: string }> } {
  const all = flatSteps(w.steps), ids = new Set(all.map((s) => s.id));
  const arrows: LinkArrow[] = [], missing: LinkRef[] = [];
  // a free block with no `next` runs into the free block under it
  const tail = splitAtEnd(w).tail;
  const then = tail.flatMap((s, i) => (tail[i + 1] && !KINDS[s.kind].stops && !s.links.some((l) => l.kind === 'next') ? [{ from: s.id, to: tail[i + 1]!.id }] : []));
  for (const s of all) {
    s.links.forEach((l, index) => {
      const ref = { from: s.id, index, kind: l.kind, to: l.to };
      if (!ids.has(l.to)) return void missing.push(ref);
      const mark = wires.get(edgeId(s.id, index, l.to));
      arrows.push(mark ? { ...ref, mark } : ref);
    });
  }
  return { arrows, missing, then };
}

// The arrows a run went along: `from/index` of a link, `from>to` of a then-arrow, for each consecutive pair of started steps.
export function taken(arrows: LinkArrow[], then: Array<{ from: string; to: string }>, went: Array<{ from: string; to: string }>): Set<string> {
  const pairs = new Set(went.map((p) => `${p.from}>${p.to}`));
  return new Set([
    ...arrows.filter((a) => pairs.has(`${a.from}>${a.to}`)).map((a) => `${a.from}/${a.index}`),
    ...then.map((t) => `${t.from}>${t.to}`).filter((k) => pairs.has(k)),
  ]);
}

// From the right side of `from`; into the left side of `to` when it is clearly further right, else round the right of both (a bracket).
const geo = (from: Rect, to: Rect, lane: number) => {
  const x1 = from.x + from.w, x2 = to.x + to.w;
  return { x1, y1: from.y + from.h / 2, y2: to.y + to.h / 2, x2, curve: to.x - x1 > 40, out: Math.max(x1, x2) + 24 + 10 * lane };
};

export function arrowPath(from: Rect, to: Rect, lane: number): string {
  const { x1, y1, y2, x2, curve, out } = geo(from, to, lane);
  if (curve) {
    const c = Math.max(20, (to.x - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + c} ${y1} ${to.x - c} ${y2} ${to.x} ${y2}`;
  }
  const dy = y2 - y1, s = dy < 0 ? -1 : 1, r = Math.min(8, Math.abs(dy) / 2);
  return `M ${x1} ${y1} H ${out - r} Q ${out} ${y1} ${out} ${y1 + s * r} V ${y2 - s * r} Q ${out} ${y2} ${out - r} ${y2} H ${x2}`;
}

export function labelAt(from: Rect, to: Rect, lane: number): Pt {
  const { x1, y1, y2, curve, out } = geo(from, to, lane);
  return curve ? { x: (x1 + to.x) / 2 + 4, y: (y1 + y2) / 2 - 4 } : { x: out + 4, y: (y1 + y2) / 2 + 4 };
}

export const labelW = (t: string) => t.length * 5.4 + 6;
const LABEL_H = 12;

// Labels that would overprint (x spans overlap and baselines are closer than a text line) are pushed down, in order, until they stand apart.
export function placeLabels(items: Array<{ key: string; at: Pt; text: string }>): Map<string, Pt> {
  const placed: Array<{ at: Pt; text: string }> = [];
  const out = new Map<string, Pt>();
  for (const it of items) {
    const at = { ...it.at };
    while (placed.some((p) => Math.abs(p.at.x - at.x) < Math.max(labelW(p.text), labelW(it.text)) && Math.abs(p.at.y - at.y) < LABEL_H)) at.y += LABEL_H;
    placed.push({ at, text: it.text });
    out.set(it.key, at);
  }
  return out;
}

// Arrows whose vertical spans touch (counted in rows of `order`) get different lanes, so they do not draw on top of each other.
export function lanes(arrows: LinkArrow[], order: string[]): Map<string, number> {
  const items = arrows.map((a) => {
    const i = order.indexOf(a.from), j = order.indexOf(a.to);
    return { key: `${a.from}/${a.index}`, lo: Math.min(i, j), hi: Math.max(i, j), lane: 0 };
  }).sort((a, b) => a.lo - b.lo || b.hi - a.hi);
  const placed: typeof items = [];
  for (const it of items) {
    while (placed.some((p) => p.lane === it.lane && p.lo <= it.hi && it.lo <= p.hi)) it.lane++;
    placed.push(it);
  }
  return new Map(items.map((it) => [it.key, it.lane]));
}
