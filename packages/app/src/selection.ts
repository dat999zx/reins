import type { Workflow } from '@reins/core';
import { flatSteps } from './canvas.js';
import { inside, type Pt, type Rect } from './surface.js';

export type Key = string; // 's:<stepId>' | 'l:<looseKey>' | 'k:<from>/<index>'
export const stepKey = (id: string): Key => `s:${id}`;
export const stepIds = (keys: Iterable<Key>): string[] => [...keys].filter((k) => k.startsWith('s:')).map((k) => k.slice(2));

export function toggle(sel: Set<Key>, k: Key): Set<Key> {
  const n = new Set(sel);
  if (!n.delete(k)) n.add(k);
  return n;
}

export const boxSelect = (rects: Array<{ key: Key; r: Rect }>, box: Rect): Set<Key> => new Set(rects.filter((x) => inside(x.r, box)).map((x) => x.key));

// Every step below a selected step: it moves, copies and deletes with its ancestor, so it is not listed on its own.
export const nestedKeys = (w: Workflow, keys: Set<Key>): Set<Key> => new Set(flatSteps(w.steps).filter((s) => keys.has(stepKey(s.id)))
  .flatMap((s) => flatSteps([...(s.kids ?? []), ...(s.else ?? [])]).map((x) => stepKey(x.id))));
export const withoutNested = (w: Workflow, keys: Set<Key>): Set<Key> => { const n = nestedKeys(w, keys); return new Set([...keys].filter((k) => !n.has(k))); };

// Reading order: the file top to bottom (stack with nested steps, the cap, then the free blocks), then the loose blocks, top-left first.
export const readingOrder = (w: Workflow, loose: Array<{ key: string; at: Pt }> = []): Key[] => [
  ...flatSteps(w.steps).map((s) => stepKey(s.id)),
  ...[...loose].sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x).map((l) => `l:${l.key}`),
];

// Where focus goes when `gone` is deleted: the next block in reading order, else the previous one.
export function neighbour(order: Key[], gone: Set<Key>): Key | undefined {
  const i = order.findIndex((k) => gone.has(k));
  return order.slice(i + 1).find((k) => !gone.has(k)) ?? order.slice(0, Math.max(i, 0)).filter((k) => !gone.has(k)).at(-1);
}

export const allKeys = (w: Workflow, looseKeys: string[] = []): Set<Key> => new Set([...w.steps.map((s) => stepKey(s.id)), ...looseKeys.map((k) => `l:${k}`)]);
