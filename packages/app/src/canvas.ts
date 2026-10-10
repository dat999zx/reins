import type { Diagnostic, Step, Workflow } from '@reins/core';

export type WireKind = 'next' | 'on-fail';

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

export function setLink(w: Workflow, from: string, kind: WireKind, to: string): Workflow {
  if (to === from) return w;
  const order = flatSteps(w.steps).map((s) => s.id);
  const backward = order.indexOf(to) !== -1 && order.indexOf(to) < order.indexOf(from);
  return editStep(w, from, (s) => {
    s.links = s.links.filter((l) => l.kind !== kind);
    s.links.push({ kind, to, ...(backward ? { max: 3 } : {}) });
  });
}

export function removeLinks(w: Workflow, refs: Array<{ from: string; index: number }>): Workflow {
  const froms = [...new Set(refs.map((r) => r.from))];
  return froms.reduce((acc, from) => editStep(acc, from, (s) => {
    const drop = new Set(refs.filter((r) => r.from === from).map((r) => r.index));
    s.links = s.links.filter((_, i) => !drop.has(i));
  }), w);
}
