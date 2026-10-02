import type { Workflow, Step, Cond } from './model.js';
import { CARDS } from './cards/index.js';
import { NODES, type CompileCtx } from './nodes/index.js';

export interface Policy {
  mode: 'read-only' | 'write';
  guards: string[];
  allowShell: boolean;
  pendingGate?: string;
}

// top: index of the top-level step this instruction belongs to (a repeat's inner steps and
// steps inlined by `use` report their parent), so "step N of M" always counts the same things.
export type Instr = (
  | { op: 'RECALL'; step: string; topics: string[] }
  // src: the step as compiled (block steps prefixed), so a step inlined by `use` keeps its prompt.
  | { op: 'TURN'; step: string; policy: Policy; src?: Step }
  | { op: 'GATE'; step: string; cond: Cond }
  | { op: 'LOOP_IN'; step: string; max: number }
  | {
      op: 'RUN';
      step: string;
      cmd: string;
      onPassJump?: number;
      onFailJump?: number;
      linkMax?: number;
      repeatCond?: Cond;
      loopExit?: number;
    }
  | { op: 'LOOP_BK'; step: string; target: number; cond?: Cond }
  | { op: 'IF'; step: string; cond: Cond; elseJump: number }
  | { op: 'VERIFY'; step: string; against: string; onFailJump?: number; linkMax?: number }
  | { op: 'STORE'; step: string; what: string }
  | { op: 'HANDOFF'; step: string; to: string; focus?: string }
  | { op: 'JUMP'; target: number; step?: string; linkMax?: number }
  | { op: 'END' }) & { top?: number };

export interface CompileTurnContext {
  workflowName: string;
  stepNumber?: number;
  stepIndex?: number;
  totalSteps: number;
  always?: string[];
  recallContext?: string[];
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

export function compileProgram(
  w: Workflow,
  resolveBlock?: (name: string) => Workflow | undefined
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
    linkLater: (instr, target) =>
      links.push({ apply: (t) => { instr.onFailJump = t; }, target, fallback: -1 }),
    resolveBlock,
  };

  function compileStep(step: Step) {
    stepToIndex.set(step.id, instrs.length);
    NODES.get(step.kind)?.compile(step, ctx);
    const next = step.links.find((l) => l.kind === 'next');
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

  return instrs;
}
