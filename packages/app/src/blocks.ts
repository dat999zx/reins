import type { Cond, Step, StepKind, Workflow } from '@reins/core';
import { flatSteps } from './canvas.js';
import { KINDS } from './canvasKinds.js';

export type Place = { parent?: string; branch: 'kids' | 'else'; index: number };

// The list a place points into, on a clone. Undefined for a non-container parent, or else on a kids-only container.
function listIn(w: Workflow, p: { parent?: string; branch: 'kids' | 'else' }): Step[] | undefined {
  if (p.parent === undefined) return p.branch === 'kids' ? w.steps : undefined;
  const s = flatSteps(w.steps).find((x) => x.id === p.parent);
  const g = s && KINDS[s.kind].group;
  if (!s || !g || (p.branch === 'else' && g !== 'kids+else')) return undefined;
  return (s[p.branch] ??= []);
}

// ponytail: a step with a duplicate id (already a validator error) is found first
export function placeOf(w: Workflow, id: string): Place | undefined {
  const look = (list: Step[], parent?: string, branch: 'kids' | 'else' = 'kids'): Place | undefined => {
    for (const [index, s] of list.entries()) {
      if (s.id === id) return parent === undefined ? { branch, index } : { parent, branch, index };
      const hit = look(s.kids ?? [], s.id, 'kids') ?? look(s.else ?? [], s.id, 'else');
      if (hit) return hit;
    }
    return undefined;
  };
  return look(w.steps);
}

export function newId(w: Workflow, kind: StepKind): string {
  const all = flatSteps(w.steps);
  const taken = new Set([...all.map((s) => s.id), ...all.flatMap((s) => s.links.map((l) => l.to)), ...all.flatMap((s) => (s.attrs.against ? [s.attrs.against] : []))]);
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

export function addStep(w: Workflow, kind: StepKind, after?: string): Workflow {
  const fresh = KINDS[kind].fresh;
  if (!fresh) return w;
  const step: Step = { id: newId(w, kind), kind, attrs: {}, cards: [], links: [], ...fresh() };
  const at = after === undefined ? undefined : placeOf(w, after);
  const m = structuredClone(w);
  const list = at ? listIn(m, at) : m.steps;
  if (!list) return w;
  list.splice(at ? at.index + 1 : list.length, 0, step);
  return m;
}

export function moveStep(w: Workflow, id: string, to: Place): Workflow {
  const from = placeOf(w, id);
  const moving = flatSteps(w.steps).find((s) => s.id === id);
  if (!from || !moving) return w;
  if (to.parent !== undefined && flatSteps([moving]).some((s) => s.id === to.parent)) return w;
  const same = from.parent === to.parent && from.branch === to.branch;
  if (same && (to.index === from.index || to.index === from.index + 1)) return w;
  const m = structuredClone(w);
  const dst = listIn(m, to);
  const src = listIn(m, from);
  // ponytail: a duplicate parent id (a validator error) can make `from` point at another list; do nothing then
  if (!dst || src?.[from.index]?.id !== id) return w;
  const [step] = src.splice(from.index, 1);
  dst.splice(Math.max(0, Math.min(same && to.index > from.index ? to.index - 1 : to.index, dst.length)), 0, step!);
  return m;
}

// Where Alt+Right (in) or Alt+Left (out) sends a step: the end of the container before it, or the slot just after its parent.
export function nestPlace(w: Workflow, id: string, dir: 'in' | 'out'): Place | undefined {
  const at = placeOf(w, id);
  if (!at) return undefined;
  if (dir === 'out') {
    const p = at.parent === undefined ? undefined : placeOf(w, at.parent);
    return p && { ...p, index: p.index + 1 };
  }
  const list = at.parent === undefined ? w.steps : flatSteps(w.steps).find((s) => s.id === at.parent)?.[at.branch];
  const prev = list?.[at.index - 1];
  return prev && KINDS[prev.kind].group ? { parent: prev.id, branch: 'kids', index: prev.kids?.length ?? 0 } : undefined;
}

export function deleteStep(w: Workflow, id: string): Workflow {
  const at = placeOf(w, id);
  const target = flatSteps(w.steps).find((s) => s.id === id);
  if (!at || !target) return w;
  const gone = new Set(flatSteps([target]).map((s) => s.id));
  const m = structuredClone(w);
  const list = listIn(m, at);
  if (list?.[at.index]?.id !== id) return w;
  list.splice(at.index, 1);
  for (const s of flatSteps(m.steps)) {
    s.links = s.links.filter((l) => !gone.has(l.to));
    if (gone.has(s.attrs.against ?? '')) delete s.attrs.against;
  }
  return m;
}

export type CondPath = Array<'a' | 'b'>;

// Replace the condition node at `path` of a step that has a condition slot; the same `w` when there is no such node.
export function setCond(w: Workflow, id: string, path: CondPath, cond: Cond): Workflow {
  const m = structuredClone(w);
  const step = flatSteps(m.steps).find((s) => s.id === id);
  if (!step || !KINDS[step.kind].line.includes('cond')) return w;
  let holder = step as unknown as Record<string, Cond | undefined>;
  let key = 'cond';
  for (const hop of path) {
    const c = holder[key];
    if (!c || !(hop in c)) return w;
    holder = c as unknown as Record<string, Cond | undefined>;
    key = hop;
  }
  holder[key] = cond;
  return m;
}

export function setAlways(w: Workflow, text: string): Workflow {
  return { ...w, always: text.split('\n').map((l) => l.trim()).filter(Boolean) };
}
