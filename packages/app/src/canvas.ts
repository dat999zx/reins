import type { Diagnostic, LinkKind, Step, Workflow } from '@reins/core';
import type { Edge, Node } from '@xyflow/react';
import { KINDS } from './canvasKinds.js';
import type { Box } from './layout.js';

export type WireKind = 'next' | 'on-fail';
export type BoxData = { step: Step; cond?: string; mark?: Mark; elseX?: number };
export type WireData = { kind: LinkKind | 'order'; index?: number; mark?: Mark };

export const edgeId = (from: string, index: number | 'order', to: string): string => `${from}>${index}>${to}`;

export function flatSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) => [s, ...flatSteps(s.kids ?? []), ...flatSteps(s.else ?? [])]);
}

export type Mark = 'error' | 'warning';

const worse = (a?: Mark, b?: Mark) => (a === 'error' || b === 'error' ? 'error' : a ?? b);

export function marksOf(w: Workflow, diags: Diagnostic[], text: string): { steps: Map<string, Mark>; wires: Map<string, Mark> } {
  const all = flatSteps(w.steps);
  // A diagnostic belongs to the heading it falls under; only a step's heading gets a mark.
  const headings = text.split('\n').flatMap((l, i) => (/^#{2,6}\s/.test(l) ? [i + 1] : []));
  const byLine = new Map(all.flatMap((s) => (s.pos ? [[s.pos.line, s] as const] : [])));
  const steps = new Map<string, Mark>();
  const wires = new Map<string, Mark>();
  for (const d of diags) {
    const h = headings.filter((l) => l <= d.pos.line).pop();
    const st = h === undefined ? undefined : byLine.get(h);
    if (!st) continue;
    const i = st.links.findIndex((l) => l.pos?.line === d.pos.line);
    const marks = i === -1 ? steps : wires;
    const key = i === -1 ? st.id : edgeId(st.id, i, st.links[i]!.to);
    marks.set(key, worse(marks.get(key), d.severity)!);
  }
  return { steps, wires };
}

export function toGraph(w: Workflow, boxes: Record<string, Box>, o: {
  conds: Record<string, string>; diags: Diagnostic[]; text: string; selected?: string;
}): { nodes: Node<BoxData>[]; edges: Edge<WireData>[] } {
  const ids = new Set(flatSteps(w.steps).map((s) => s.id));
  const { steps: nodeMark, wires: wireMark } = marksOf(w, o.diags, o.text);

  const nodes: Node<BoxData>[] = [];
  const edges: Edge<WireData>[] = [];
  const walk = (list: Step[], parentId?: string) => {
    list.forEach((st, n) => {
      const b = boxes[st.id]!;
      nodes.push({
        id: st.id,
        type: KINDS[st.kind].group ? 'group' : 'step',
        position: { x: b.x, y: b.y },
        width: b.w,
        height: b.h,
        data: { step: st, cond: o.conds[st.id], mark: nodeMark.get(st.id), elseX: b.elseX },
        deletable: false,
        selected: st.id === o.selected,
        ...(parentId ? { parentId, extent: 'parent' as const, expandParent: true } : {}),
      });
      st.links.forEach((l, index) => {
        if (!ids.has(l.to)) return;
        const id = edgeId(st.id, index, l.to);
        edges.push({
          id, source: st.id, target: l.to,
          sourceHandle: l.kind === 'on-fail' ? 'on-fail' : 'next', targetHandle: 'in',
          data: { kind: l.kind, index, mark: wireMark.get(id) }, deletable: true,
        });
      });
      const next = list[n + 1];
      if (next && !st.links.some((l) => l.kind === 'next')) {
        edges.push({
          id: edgeId(st.id, 'order', next.id), source: st.id, target: next.id,
          sourceHandle: 'next', targetHandle: 'in', data: { kind: 'order' },
          selectable: false, deletable: false, focusable: false,
        });
      }
      walk(st.kids ?? [], st.id);
      walk(st.else ?? [], st.id);
    });
  };
  walk(w.steps);
  return { nodes, edges };
}

export function editStep(w: Workflow, id: string, fn: (s: Step) => void): Workflow {
  const out = structuredClone(w);
  const st = flatSteps(out.steps).find((s) => s.id === id);
  if (!st) return w;
  fn(st);
  return out;
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
