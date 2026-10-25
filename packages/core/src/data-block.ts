// M2 Task 19: a block mod with no code (a data block). Its manifest's `turn` is the prompt: `{attr}` and `{a|b}` are filled from the step's own
// attributes, and the step compiles to one TURN through `turnInstr`, so its policy is `policyOf(step)`. The manifest never sets a policy.
import type { NodeType } from './nodes/index.js';
import { tame } from './guard.js';
import { checkMode, turnInstr } from './nodes/turn.js';

/** A placeholder: the text between braces. Its alternatives (`a|b`) are attributes; the first one with a value fills it. */
const HOLE = /\{([^{}]*)\}/g;
const MAX_FILL = 1000;
const MAX_PROMPT = 16 * 1024;

/** Every attribute name a template's placeholders name (each alternative of `{a|b}`). The manifest check requires each to be listed. */
export function turnNames(turn: string): string[] {
  return [...turn.matchAll(HOLE)].flatMap((m) => m[1]!.split('|'));
}

/**
 * The prompt for a step. A value is read only when it is the step's own string property (so `constructor` or `__proto__` fill empty), and it is
 * shown as one visible line of at most 1000 characters; the whole prompt is cut to 16 KB. The template's own text is kept as it is.
 */
export function fillTurn(turn: string, attrs: Readonly<Record<string, unknown>>): string {
  const out = turn.replace(HOLE, (_, names: string) => {
    for (const name of names.split('|')) {
      const v = Object.hasOwn(attrs, name) ? attrs[name] : undefined;
      if (typeof v === 'string' && v !== '') return tame(v, MAX_FILL)!;
    }
    return '';
  });
  return out.length > MAX_PROMPT ? `${out.slice(0, MAX_PROMPT)}...` : out;
}

export interface DataBlock {
  kind: string;
  attrs: string[];
  turn: string;
  statusLine?: string;
}

/** The node of a data block: no ops and no exec; one TURN, its prompt the filled template, its policy the step's (`turnInstr`). */
export function dataBlock(d: DataBlock): NodeType {
  return {
    kind: d.kind,
    attrs: [...d.attrs],
    statusLine: d.statusLine,
    validate: { early: checkMode },
    compile(step, ctx) { ctx.push(turnInstr({ ...step, prompt: fillTurn(d.turn, step.attrs) })); },
  };
}
