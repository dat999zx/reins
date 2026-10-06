import type { Step, Workflow } from '@reins/core';
import { capBackward, deleteSteps, insertSteps, takeSteps, withFreshIds, type Place } from './blocks.js';
import { flatSteps } from './canvas.js';
import type { Layout, Loose, Pt } from './editorState.js';

export const HOME: Pt = { x: 40, y: 40 };
export const LOOSE_MAX = 100;
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

export const stateBytes =(v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

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

// keys: 'hat' and 'l:<key>'; the hat moves from its place or HOME.
export function moveItems(lay: Layout, keys: string[], d: Pt): Layout {
  const out: Layout = { ...lay };
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
