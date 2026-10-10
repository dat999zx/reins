import type { Step, Workflow } from '@reins/core';
import { addStepAt, capBackward, deleteSteps, dropSteps, insertSteps, stackEnd, takeSteps, withFreshIds, type Hit, type Place } from './blocks.js';
import { flatSteps } from './canvas.js';
import { LOOSE_MAX, type Layout, type Loose, type Pt } from './editorState.js';

export const HOME: Pt = { x: 40, y: 40 };
export const FULL = 'The parking area is full: delete some loose blocks first.';
export const STATE_MAX = 60000; // the server refuses 64 KB of editor state

// Takes the steps (with their subtrees) out of the file as stand-alone copies. `lost` names every link and `against` cut on the way.
export function park(w: Workflow, ids: string[]): { w: Workflow; steps: Step[]; lost: string[] } {
  const { taken } = takeSteps(w, ids);
  if (!taken.length) return { w, steps: [], lost: [] };
  const inside = new Set(flatSteps(taken).map((s) => s.id)), lost: string[] = [];
  for (const s of flatSteps(w.steps)) {
    const own = inside.has(s.id);
    for (const l of s.links) if (inside.has(l.to) !== own) lost.push(`\`${s.id}\` ${l.kind} → \`${l.to}\``);
    const a = s.attrs.against;
    if (a && inside.has(a) !== own) lost.push(`\`${s.id}\` against → \`${a}\``);
  }
  return { w: deleteSteps(w, ids), steps: selfContained(taken), lost };
}

// Puts parked steps into the file with free ids; `ids` are the new root ids. The same workflow for an illegal place.
export function unpark(w: Workflow, steps: Step[], to: Place): { w: Workflow; ids: string[]; capped: string[] } {
  const fresh = withFreshIds(w, steps), m = steps.length ? insertSteps(w, fresh, to) : w;
  if (m === w) return { w, ids: [], capped: [] };
  const r = capBackward(m);
  return { w: r.w, ids: fresh.map((s) => s.id), capped: r.capped };
}

export const stateBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

export function nextKey(lay: Layout): string {
  const used = new Set((lay.loose ?? []).map((l) => l.key));
  let n = 1;
  while (used.has(`l${n}`)) n++;
  return `l${n}`;
}

// The same layout when the cap would be crossed (keys is then empty).
export function addLoose(lay: Layout, steps: Step[], at: Pt[]): { lay: Layout; keys: string[] } {
  const loose = [...(lay.loose ?? [])];
  if (loose.length + steps.length > LOOSE_MAX) return { lay, keys: [] };
  const keys: string[] = [];
  for (const [i, step] of steps.entries()) {
    const key = nextKey({ loose });
    keys.push(key);
    loose.push({ key, at: at[i]!, step: structuredClone(step) });
  }
  return { lay: { ...lay, loose }, keys };
}

export function removeLoose(lay: Layout, keys: string[]): Layout {
  if (!lay.loose?.some((l) => keys.includes(l.key))) return lay;
  return { ...lay, loose: lay.loose.filter((l) => !keys.includes(l.key)) };
}

export function splitAtEnd(w: Workflow): { stack: Step[]; end?: Step; tail: Step[] } {
  const i = stackEnd(w);
  return { stack: w.steps.slice(0, i), end: w.steps[i], tail: w.steps.slice(i + 1) };
}

// Moving, parking or deleting the top-level end turns the free blocks behind it into stack steps that run.
export const freedBy = (w: Workflow, ids: string[]): string[] => {
  const { end, tail } = splitAtEnd(w);
  return end && ids.includes(end.id) ? tail.map((s) => s.id) : [];
};

export const ensureEnd = (w: Workflow): Workflow => (stackEnd(w) < w.steps.length ? w : addStepAt(w, 'end', { branch: 'kids', index: w.steps.length }));

// A stack step becomes a free block: behind the end (added when missing), reached only by links. Undefined for a nested, free or end step.
export function detach(w: Workflow, id: string): { w: Workflow; capped: string[] } | undefined {
  const i = w.steps.findIndex((s) => s.id === id);
  if (i === -1 || i >= stackEnd(w)) return undefined;
  const m = structuredClone(ensureEnd(w));
  m.steps.push(...m.steps.splice(i, 1));
  return capBackward(m);
}

// A free block goes back into the stack: before the end, or at the slot `hit` points to. Undefined for any other step.
export function attach(w: Workflow, id: string, hit: Hit = { top: 'end' }): { w: Workflow; capped: string[] } | undefined {
  if (!splitAtEnd(w).tail.some((s) => s.id === id)) return undefined;
  const m = dropSteps(w, [id], hit);
  return m === w ? undefined : capBackward(m);
}

// Saved places of steps that are no longer free are dropped; the same object when nothing goes.
export function pruneLayout(lay: Layout, w: Workflow): Layout {
  const free = new Set(splitAtEnd(w).tail.map((s) => s.id));
  const keep = Object.entries(lay.free ?? {}).filter(([id]) => free.has(id));
  if (keep.length === Object.keys(lay.free ?? {}).length) return lay;
  const { free: _, ...rest } = lay;
  return keep.length ? { ...rest, free: Object.fromEntries(keep) } : rest;
}

// keys: 'hat', 'l:<key>' and 's:<stepId>' (a free block with a saved place); the hat moves from its place or HOME.
export function moveItems(lay: Layout, keys: string[], d: Pt): Layout {
  const out: Layout = { ...lay };
  if (lay.free) out.free = Object.fromEntries(Object.entries(lay.free).map(([id, p]) => [id, keys.includes(`s:${id}`) ? { x: p.x + d.x, y: p.y + d.y } : p]));
  if (keys.includes('hat')) { const p = lay.script ?? HOME; out.script = { x: p.x + d.x, y: p.y + d.y }; }
  if (lay.loose) out.loose = lay.loose.map((l): Loose => (keys.includes(`l:${l.key}`) ? { ...l, at: { x: l.at.x + d.x, y: l.at.y + d.y } } : l));
  return out;
}

// Copies that stand alone: links and `against` that leave the copy are cut, positions are dropped.
export function selfContained(steps: Step[]): Step[] {
  const out = structuredClone(steps), flat = flatSteps(out), ids = new Set(flat.map((s) => s.id));
  for (const s of flat) {
    s.links = s.links.filter((l) => ids.has(l.to));
    if (s.attrs.against && !ids.has(s.attrs.against)) delete s.attrs.against;
  }
  return JSON.parse(JSON.stringify(out, (k, v) => (k === 'pos' ? undefined : v))) as Step[];
}
