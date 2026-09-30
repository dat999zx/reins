import { CARDS, NODES, parseWorkflow, validate, type Diagnostic, type Workflow } from '@reins/core';

export interface Tag { tag: string; arg?: string }
export type Built = { ok: true; text: string } | { ok: false; error: string };
export type Tagged =
  | { ok: true; text: string; workflow: Workflow; warnings: Diagnostic[] }
  | { ok: false; error: string; text?: string; diagnostics?: Diagnostic[] };
export interface TagEntry { name: string; place: 'card' | 'attr' | 'after' | 'wrap'; arg?: string; argRequired?: boolean; enforced: boolean }

const NAME = /^[a-z][a-z-]*$/;
// Headings past ###### do not parse (parse.ts:86), and the prompt sits one level below the innermost wrap.
const MAX_WRAPS = 4;
// The one shorthand (3b.5): #read-only is #mode read-only.
const SHORTHAND = new Map([['read-only', { attr: 'mode', value: 'read-only' }]]);
// ponytail: the chat's budget is a constant until someone needs it per session
const FRONTMATTER = ['---', 'reins: 1', 'name: chat', 'always: []', 'budget: { turns: 20, minutes: 30 }', '---', ''];

const refuse = (error: string) => ({ ok: false as const, error });
const needsArg = (name: string) => refuse(`#${name} needs an argument`);

export function buildTagged(text: string, tags: Tag[]): Built {
  const attrs = NODES.get('phase')?.attrs ?? [];
  const own: string[] = [];
  const seen = new Set<string>();
  const wraps: string[][] = [];
  const afters: string[][] = [];
  for (const { tag: name, arg: raw } of tags) {
    if (!NAME.test(name)) return refuse(`bad tag name "${name}"`);
    if (raw !== undefined && /[\r\n]/.test(raw)) return refuse(`the argument of #${name} must be on one line`);
    const arg = raw?.trim() || undefined;
    const card = CARDS.get(name);
    const node = NODES.get(name)?.tag;
    if (card && !card.delivery) {
      if (arg === undefined) return needsArg(name);
      own.push(`${name}: ${arg}`);
    } else if (node) {
      if (arg !== undefined && !node.arg) return refuse(`#${name} takes no argument`);
      if (arg === undefined && node.argRequired) return needsArg(name);
      const lines = [...(arg !== undefined && node.arg ? [`${node.arg}: ${arg}`] : []), ...(node.lines ?? [])];
      (node.place === 'wrap' ? wraps : afters).push([name, ...lines]);
    } else {
      const short = SHORTHAND.get(name);
      const attr = short?.attr ?? name;
      if (!attrs.includes(attr)) return refuse(`unknown tag "${name}"`);
      if (short && arg !== undefined) return refuse(`#${name} takes no argument`);
      const value = short ? short.value : arg;
      if (value === undefined) return needsArg(name);
      if (seen.has(attr)) return refuse(`repeated tag "${attr}"`);
      seen.add(attr);
      own.push(`${attr}: ${value}`);
    }
  }
  if (wraps.length > MAX_WRAPS) return refuse(`at most ${MAX_WRAPS} wrapping tags can be nested`);

  const out = [...FRONTMATTER];
  [...wraps].reverse().forEach(([kind, ...lines], i) => out.push(`${'#'.repeat(2 + i)} ${kind}`, ...lines, ''));
  out.push(`${'#'.repeat(2 + wraps.length)} phase prompt`, ...own, ...text.split(/\r?\n/).map((l) => `> ${l}`), '');
  for (const [kind, ...lines] of afters) out.push(`## ${kind}`, ...lines, '');
  return { ok: true, text: out.join('\n') };
}

export function taggedWorkflow(text: string, tags: Tag[]): Tagged {
  const b = buildTagged(text, tags);
  if (!b.ok) return b;
  const parsed = parseWorkflow(b.text);
  const diagnostics = [...parsed.diagnostics, ...(parsed.workflow ? validate(parsed.workflow) : [])];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (!parsed.workflow || errors.length) {
    return { ok: false, error: errors.map((d) => d.message).join('; ') || 'invalid workflow', text: b.text, diagnostics };
  }
  return { ok: true, text: b.text, workflow: parsed.workflow, warnings: diagnostics.filter((d) => d.severity === 'warning') };
}

export function tagCatalogue(): TagEntry[] {
  const out: TagEntry[] = [];
  for (const n of NODES.values()) {
    if (!n.tag) continue;
    out.push({ name: n.kind, place: n.tag.place, ...(n.tag.arg ? { arg: n.tag.arg } : {}), ...(n.tag.argRequired ? { argRequired: true } : {}), enforced: true });
  }
  for (const c of CARDS.values()) {
    if (!c.delivery) out.push({ name: c.kind, place: 'card', arg: c.kind, argRequired: true, enforced: !!c.policy });
  }
  for (const a of NODES.get('phase')?.attrs ?? []) out.push({ name: a, place: 'attr', arg: a, argRequired: true, enforced: true });
  for (const name of SHORTHAND.keys()) out.push({ name, place: 'attr', argRequired: false, enforced: true });
  return out;
}
