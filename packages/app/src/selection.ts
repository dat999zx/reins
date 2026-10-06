import type { Workflow } from '@reins/core';
import { flatSteps } from './canvas.js';
import { inside, type Rect } from './surface.js';

export type Key = string; // 's:<stepId>' | 'l:<looseKey>' | 'k:<from>/<index>'
export const stepKey = (id: string): Key => `s:${id}`;
export const stepIds = (keys: Iterable<Key>): string[] => [...keys].filter((k) => k.startsWith('s:')).map((k) => k.slice(2));

export function toggle(sel: Set<Key>, k: Key): Set<Key> {
  const n = new Set(sel);
  if (!n.delete(k)) n.add(k);
  return n;
}

export const boxSelect = (rects: Array<{ key: Key; r: Rect }>, box: Rect): Set<Key> => new Set(rects.filter((x) => inside(x.r, box)).map((x) => x.key));

// A step whose ancestor is selected moves, copies and deletes with it, so it is not listed on its own.
export function withoutNested(w: Workflow, keys: Set<Key>): Set<Key> {
  const nested = new Set(flatSteps(w.steps).filter((s) => keys.has(stepKey(s.id)))
    .flatMap((s) => flatSteps([...(s.kids ?? []), ...(s.else ?? [])]).map((x) => stepKey(x.id))));
  return new Set([...keys].filter((k) => !nested.has(k)));
}

export const allKeys = (w: Workflow, looseKeys: string[] = []): Set<Key> => new Set([...w.steps.map((s) => stepKey(s.id)), ...looseKeys.map((k) => `l:${k}`)]);