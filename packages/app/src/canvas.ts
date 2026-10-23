import type { Diagnostic, Step, Workflow } from '@reins/core';
import { viewOf } from './canvasKinds.js';

export type WireKind = 'next' | 'on-fail' | 'against';

// The `index` of the `against` wire: it is an attribute, not an entry of `links`, so no link line has this position.
export const AGAINST = -1;

export const edgeId = (from: string, index: number, to: string): string => `${from}>${index}>${to}`;

export function flatSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) => [s, ...flatSteps(s.kids ?? []), ...flatSteps(s.else ?? [])]);
}

export type Mark = 'error' | 'warning';

const worse = (a?: Mark, b?: Mark) => (a === 'error' || b === 'error' ? 'error' : a ?? b);

export function marksOf(w: Workflow, diags: Diagnostic[], text: string): { steps: Map<string, Mark>; wires: Map<string, Mark>; notes: Map<string, string[]> } {
  const all = flatSteps(w.steps);
  // A diagnostic belongs to the heading it falls under; only a step's heading gets a mark.
  const headings = text.split('\n').flatMap((l, i) => (/^#{2,6}\s/.test(l) ? [i + 1] : []));
  const byLine = new Map(all.flatMap((s) => (s.pos ? [[s.pos.line, s] as const] : [])));
  const steps = new Map<string, Mark>();
  const wires = new Map<string, Mark>();
  const notes = new Map<string, string[]>(); // a step's own messages, for its tooltip
  for (const d of diags) {
    const h = headings.filter((l) => l <= d.pos.line).pop();
    const st = h === undefined ? undefined : byLine.get(h);
    if (!st) continue;
    const i = st.links.findIndex((l) => l.pos?.line === d.pos.line);
    const marks = i === -1 ? steps : wires;
    const key = i === -1 ? st.id : edgeId(st.id, i, st.links[i]!.to);
    marks.set(key, worse(marks.get(key), d.severity)!);
    if (i === -1) notes.set(st.id, [...(notes.get(st.id) ?? []), d.message]);
  }
  return { steps, wires, notes };
}

// `fn` returning false means the edit was refused: w comes back.
export function editStep(w: Workflow, id: string, fn: (s: Step) => void | boolean): Workflow {
  const out = structuredClone(w);
  const st = flatSteps(out.steps).find((s) => s.id === id);
  if (!st) return w;
  return fn(st) === false ? w : out;
}

// How a wire is written on its step. `next` and `on-fail` are links; `against` is the step's attribute, so it has no max.
const asLink = (kind: string) => (s: Step, to: string, backward: boolean) => {
  s.links = s.links.filter((l) => l.kind !== kind);
  s.links.push({ kind, to, ...(backward ? { max: 3 } : {}) } as Step['links'][number]);
};
// A block whose view takes many `next` wires (the fork) keeps every wire: a drag adds one, and a second wire to the same block changes nothing (false: refused).
const addNext = (s: Step, to: string) => {
  if (s.links.some((l) => l.kind === 'next' && l.to === to)) return false;
  s.links.push({ kind: 'next', to });
};
const WRITERS: Record<WireKind, (s: Step, to: string, backward: boolean) => void | boolean> = {
  next: (s, to, backward) => (viewOf(s.kind).manyNext ? addNext(s, to) : asLink('next')(s, to, backward)),
  'on-fail': asLink('on-fail'),
  against: (s, to) => { s.attrs.against = to; },
};

export function setLink(w: Workflow, from: string, kind: WireKind, to: string): Workflow {
  if (to === from) return w;
  const order = flatSteps(w.steps).map((s) => s.id);
  const backward = order.indexOf(to) !== -1 && order.indexOf(to) < order.indexOf(from);
  return editStep(w, from, (s) => WRITERS[kind](s, to, backward));
}

export function removeLinks(w: Workflow, refs: Array<{ from: string; index: number }>): Workflow {
  const froms = [...new Set(refs.map((r) => r.from))];
  return froms.reduce((acc, from) => editStep(acc, from, (s) => {
    const drop = new Set(refs.filter((r) => r.from === from).map((r) => r.index));
    if (drop.has(AGAINST)) delete s.attrs.against;
    s.links = s.links.filter((_, i) => !drop.has(i));
  }), w);
}
