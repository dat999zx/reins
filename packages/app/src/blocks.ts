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

export function insertSteps(w: Workflow, steps: Step[], to: Place): Workflow {
  const m = structuredClone(w);
  const list = listIn(m, to);
  if (!list) return w;
  list.splice(Math.max(0, Math.min(to.index, list.length)), 0, ...structuredClone(steps));
  return m;
}

export function addStepAt(w: Workflow, kind: StepKind, to: Place): Workflow {
  const fresh = KINDS[kind].fresh;
  if (!fresh) return w;
  return insertSteps(w, [{ id: newId(w, kind), kind, attrs: {}, cards: [], links: [], ...fresh() }], to);
}

export function addStep(w: Workflow, kind: StepKind, after?: string): Workflow {
  const at = after === undefined ? undefined : placeOf(w, after);
  return addStepAt(w, kind, at ? { ...at, index: at.index + 1 } : { branch: 'kids', index: w.steps.length });
}

export type Hit = { block: string; edge: 'before' | 'after' | 'into' | 'else' } | { top: 'start' | 'end' } | { body: string; branch: 'kids' | 'else' };

// The first slot of a block's own body, only if its kind has that body. Reads the model; never `listIn`, which mutates.
function bodyStart(w: Workflow, id: string, branch: 'kids' | 'else'): Place | undefined {
  const s = flatSteps(w.steps).find((x) => x.id === id);
  const group = s && KINDS[s.kind].group;
  return group && (branch === 'kids' || group === 'kids+else') ? { parent: id, branch, index: 0 } : undefined;
}

// Where a drop lands: a pure function of the model and what the pointer is over.
export function dropPlace(w: Workflow, hit: Hit): Place | undefined {
  if ('top' in hit) return { branch: 'kids', index: hit.top === 'start' ? 0 : w.steps.length };
  if ('body' in hit) return bodyStart(w, hit.body, hit.branch);
  if (hit.edge === 'into' || hit.edge === 'else') return bodyStart(w, hit.block, hit.edge === 'into' ? 'kids' : 'else');
  const at = placeOf(w, hit.block);
  return at && { ...at, index: at.index + (hit.edge === 'after' ? 1 : 0) };
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

export const deleteSteps = (w: Workflow, ids: string[]): Workflow => ids.reduce((m, id) => deleteStep(m, id), w);

// Cut the steps (with their subtrees) out of a clone, in document order; a step inside another taken step goes with it. Links stay as they are.
export function takeSteps(w: Workflow, ids: string[]): { w: Workflow; taken: Step[] } {
  const want = new Set(ids), taken: Step[] = [], m = structuredClone(w);
  const strip = (list: Step[]): Step[] => list.filter((s) => {
    if (want.has(s.id)) { taken.push(s); return false; }
    if (s.kids) s.kids = strip(s.kids);
    if (s.else) s.else = strip(s.else);
    return true;
  });
  m.steps = strip(m.steps);
  return { w: m, taken };
}

// Move several steps to where a pointer hit points. The same workflow when nothing would change or the hit is on a moved step or inside one.
export function dropSteps(w: Workflow, ids: string[], hit: Hit): Workflow {
  const { w: rest, taken } = takeSteps(w, ids);
  const anchor = 'block' in hit ? hit.block : 'body' in hit ? hit.body : undefined;
  if (!taken.length || (anchor !== undefined && flatSteps(taken).some((s) => s.id === anchor))) return w;
  const place = dropPlace(rest, hit);
  const m = place && insertSteps(rest, taken, place);
  return !m || m === rest || JSON.stringify(m) === JSON.stringify(w) ? w : m;
}

// A link that points at its own step or one before it needs a max (the validator's rule, as setLink applies it).
export function capBackward(w: Workflow): { w: Workflow; capped: string[] } {
  const m = structuredClone(w), all = flatSteps(m.steps), order = all.map((s) => s.id), capped: string[] = [];
  for (const [i, s] of all.entries()) for (const l of s.links) {
    const j = order.indexOf(l.to);
    if (j !== -1 && j <= i && l.max === undefined) { l.max = 3; capped.push(`\`${s.id}\` ${l.kind} → \`${l.to}\``); }
  }
  return capped.length ? { w: m, capped } : { w, capped };
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
