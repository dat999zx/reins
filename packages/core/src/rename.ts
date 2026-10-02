import type { Step, Workflow } from './model.js';
import { slugify } from './util.js';

export type RenameResult = { workflow: Workflow } | { error: string };

// ponytail: a `use` block's inner `against:` is not prefixed on inlining, so it names the parent's id and is not rewritten here
export function renameStep(w: Workflow, from: string, to: string): RenameResult {
  const ids = new Set<string>();
  const collect = (steps: Step[]) => {
    for (const s of steps) { ids.add(s.id); collect(s.kids ?? []); collect(s.else ?? []); }
  };
  collect(w.steps);

  if (!ids.has(from)) return { error: `No step with id "${from}"` };
  if (to !== from && ids.has(to)) return { error: `A step with id "${to}" already exists` };
  if (!to || slugify(to) !== to) return { error: `"${to}" is not a valid id (lowercase letters, digits and dashes)` };

  const walk = (s: Step): Step => ({
    ...s,
    id: s.id === from ? to : s.id,
    attrs: s.attrs.against === from ? { ...s.attrs, against: to } : { ...s.attrs },
    links: s.links.map((l) => (l.to === from ? { ...l, to } : { ...l })),
    ...(s.kids ? { kids: s.kids.map(walk) } : {}),
    ...(s.else ? { else: s.else.map(walk) } : {}),
  });
  return { workflow: { ...w, steps: w.steps.map(walk) } };
}