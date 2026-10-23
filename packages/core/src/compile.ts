import type { Workflow, Step, Cond } from './model.js';
import { CARDS } from './cards/index.js';
import { CORE_OPS, NODES, opOf, type CompileCtx } from './nodes/index.js';
import { FAULT_OP, modOfOp, tame } from './guard.js';

export interface Policy {
  mode: 'read-only' | 'write';
  guards: string[];
  allowShell: boolean;
  pendingGate?: string;
}

// The instruction shapes, keyed by op. A kind adds its own by merging into this interface.
export interface Instrs {
  RECALL: { step: string; topics: string[] };
  // src: the step as compiled (block steps prefixed), so a step inlined by `use` keeps its prompt.
  TURN: { step: string; policy: Policy; src: Step };
  GATE: { step: string; cond: Cond };
  LOOP_IN: { step: string; max: number };
  RUN: {
    step: string;
    cmd: string;
    onPassJump?: number;
    onFailJump?: number;
    linkMax?: number;
    repeatCond?: Cond;
    loopExit?: number;
  };
  LOOP_BK: { step: string; target: number; cond?: Cond };
  IF: { step: string; cond: Cond; elseJump: number };
  VERIFY: { step: string; against: string; onFailJump?: number; linkMax?: number };
  STORE: { step: string; what: string };
  // A kind's own instruction (P12): run by `NodeType.exec` of `kind`, `src` the step as compiled.
  NODE: { step: string; kind: string; src: Step };
  JUMP: { target: number; step?: string; linkMax?: number };
  END: object;
}

// top: index of the top-level step this instruction belongs to (a repeat's inner steps and
// steps inlined by `use` report their parent), so "step N of M" always counts the same things.
export type Instr = { [K in keyof Instrs]: { op: K } & Instrs[K] }[keyof Instrs] & { top?: number };

export interface CompileTurnContext {
  workflowName: string;
  stepNumber?: number;
  stepIndex?: number;
  totalSteps: number;
  always?: string[];
  recallContext?: string[];
  /** Texts the run hands this turn (queued cards, a subagent's result): listed after the step's own cards, as they are. */
  extras?: string[];
}

export function compileTurn(step: Step, ctx: CompileTurnContext): string {
  const stepNum =
    ctx.stepNumber ?? (ctx.stepIndex !== undefined ? ctx.stepIndex + 1 : 1);
  const titleOrId = step.title || step.kind;

  const sections: string[] = [];

  // 1. Header line
  sections.push(
    `[Reins · workflow "${ctx.workflowName}" · step ${stepNum} of ${ctx.totalSteps}: ${titleOrId}]`
  );

  // 2. Always
  if (ctx.always && ctx.always.length > 0) {
    sections.push('Always:\n' + ctx.always.map((r) => `- ${r}`).join('\n'));
  }

  // 3. Recall
  if (ctx.recallContext && ctx.recallContext.length > 0) {
    sections.push(
      'Context from Knowl:\n' + ctx.recallContext.map((c) => `- ${c}`).join('\n')
    );
  }

  // 4. Prompt
  let promptText = step.prompt;
  if (!promptText) promptText = NODES.get(step.kind)?.defaultPrompt?.(step);
  if (promptText) {
    sections.push(promptText);
  }

  // 5. For this step
  const stepItems: string[] = [];
  for (const card of step.cards) {
    stepItems.push(CARDS.get(card.kind)?.turnLine?.(card) ?? `${card.kind}: ${card.text}`);
  }
  stepItems.push(...(ctx.extras ?? []));
  if (step.attrs.mode === 'read-only') {
    stepItems.push(
      'Step is read-only. (Enforced: no file edits or write commands are permitted.)'
    );
  }
  if (stepItems.length > 0) {
    sections.push('For this step:\n' + stepItems.map((item) => `- ${item}`).join('\n'));
  }

  // 6. Status line
  const status = NODES.get(step.kind)?.statusLine ?? 'REINS: done | blocked: <reason>';
  sections.push(`When you finish this step, end your reply with exactly one line:\n${status}`);

  return sections.join('\n\n') + '\n';
}

/** A step that starts at an instruction index: its id and the ids of the steps around it, outermost first. */
export interface StepStart { step: string; parents: string[] }

/** `starts`, when given, is filled: first instruction index -> the steps that start there, outermost first. */
export function compileProgram(
  w: Workflow,
  resolveBlock?: (name: string) => Workflow | undefined,
  starts?: Map<number, StepStart[]>
): Instr[] {
  const instrs: Instr[] = [];
  const stepToIndex = new Map<string, number>();
  // A missing target leaves a run/verify onFailJump unset (falls through) and sends a JUMP to `fallback`.
  const links: Array<{ apply(index: number): void; target: string; fallback: number }> = [];
  const ctx: CompileCtx = {
    at: () => instrs.length,
    push: (i) => { instrs.push(i); return i; },
    get: (i) => instrs[i],
    compile: (steps) => { for (const s of steps) compileStep(s); },
    linkTo: (target, apply, fallback = -1) => { links.push({ apply, target, fallback }); },
    linkLater: (instr, target) => ctx.linkTo(target, (t) => { instr.onFailJump = t; }),
    resolveBlock,
  };

  // A mod's compile reads an earlier instruction as a frozen copy: it cannot rewrite what core or another block compiled (a TURN's policy, say).
  const modCtx: CompileCtx = { ...ctx, get: (i) => { const x = instrs[i]; return x && Object.freeze(structuredClone(x)); } };

  const open: string[] = [];
  /** Where the instructions of a mod's step sit: once the links are patched they are replaced by frozen copies, so the mod keeps no handle on the program. */
  const modSpans: Array<[number, number]> = [];
  function compileStep(step: Step) {
    const from = instrs.length;
    stepToIndex.set(step.id, from);
    const parents = [...open];
    open.push(step.id);
    const node = NODES.get(step.kind);
    node?.compile(step, node.mod ? modCtx : ctx);
    if (node?.mod) modSpans.push([from, instrs.length]);
    open.pop();
    // The inner step finishes first, so the outer one is put in front of it.
    if (starts && instrs.length > from) starts.set(from, [{ step: step.id, parents }, ...(starts.get(from) ?? [])]);
    const next = NODES.get(step.kind)?.manyNext ? undefined : step.links.find((l) => l.kind === 'next');
    if (next) {
      const jump = ctx.push<Extract<Instr, { op: 'JUMP' }>>({
        op: 'JUMP',
        target: -1,
        step: step.id,
        ...(next.max !== undefined ? { linkMax: next.max } : {}),
      });
      links.push({ apply: (t) => { jump.target = t; }, target: next.to, fallback: instrs.length });
    }
  }

  w.steps.forEach((step, top) => {
    const from = instrs.length;
    compileStep(step);
    for (let i = from; i < instrs.length; i++) instrs[i]!.top = top;
  });

  instrs.push({ op: 'END' });

  // Patch jumps
  for (const l of links) {
    const t = stepToIndex.get(l.target);
    if (t !== undefined) l.apply(t);
    else if (l.fallback >= 0) l.apply(l.fallback);
  }

  for (const [a, b] of modSpans) {
    for (let i = a; i < b; i++) {
      const ins = instrs[i]!;
      try {
        instrs[i] = Object.freeze(structuredClone(ins));
      } catch {
        instrs[i] = { op: FAULT_OP, step: (ins as { step?: string }).step, why: 'its instruction holds more than plain data', ...(ins.top !== undefined ? { top: ins.top } : {}) } as unknown as Instr;
      }
    }
  }

  return instrs;
}

/** True for an instruction index a jump or a track may name: a whole number from 0 to the program's length (one past the end finishes). */
export const sound = (i: unknown, length: number): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) <= length;

/**
 * What is wrong with a compiled program, in words; undefined when nothing is. Every JUMP target, and every place a mod's op starts a track at or goes
 * on to, must be a place in the program; an instruction a failed compile left is reported with its reason. With `ops`, every instruction must also be a
 * core op or one that a loaded kind brings (a run still starts with one a kind lost: it pauses on it).
 */
export function programProblem(program: readonly Instr[], ops: boolean): string | undefined {
  for (let k = 0; k < program.length; k++) {
    const ins = program[k]! as { op: string; step?: string; target?: unknown; why?: unknown };
    const here = `instruction ${k + 1}${ins.step ? ` (step ${tame(ins.step, 60)})` : ''}`;
    if (ins.op === FAULT_OP) return `${here} could not be compiled: ${tame(String(ins.why), 200)}`;
    if (ins.op === 'JUMP') {
      if (!sound(ins.target, program.length)) return `${here} jumps to ${tame(String(ins.target), 40)}, which is not a place in the program`;
      continue;
    }
    if (CORE_OPS.includes(ins.op)) continue;
    const op = opOf(ins.op);
    if (!op) { if (ops) return `${here} needs a block that is not loaded (${tame(ins.op, 60)})`; continue; }
    if (!modOfOp(op)) continue;
    for (const to of [...(op.starts?.(ins as Instr) ?? []), ...(op.next?.(ins as Instr, k) ?? [])]) {
      if (to !== undefined && !sound(to, program.length)) return `${here} leads to ${tame(String(to), 40)}, which is not a place in the program`;
    }
  }
  return undefined;
}
