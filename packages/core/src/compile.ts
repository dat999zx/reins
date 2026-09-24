import type { Workflow, Step, Cond } from './model.js';

export interface Policy {
  mode: 'read-only' | 'write';
  guards: string[];
  allowShell: boolean;
  pendingGate?: string;
}

export type Instr =
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
      repeatCond?: Cond;
      loopExit?: number;
    }
  | { op: 'LOOP_BK'; step: string; target: number; cond?: Cond }
  | { op: 'IF'; step: string; cond: Cond; elseJump: number }
  | { op: 'VERIFY'; step: string; against: string; onFailJump?: number; linkMax?: number }
  | { op: 'STORE'; step: string; what: string }
  | { op: 'HANDOFF'; step: string; to: string; focus?: string }
  | { op: 'JUMP'; target: number }
  | { op: 'END' };

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
  if (!promptText && step.kind === 'verify') {
    const target = step.attrs.against || 'plan';
    promptText = `Compare what you built against step "${target}".\nList anything missing or extra.`;
  }
  if (promptText) {
    sections.push(promptText);
  }

  // 5. For this step
  const stepItems: string[] = [];
  for (const card of step.cards) {
    if (card.kind === 'guard') {
      stepItems.push(`Do not touch ${card.text}. (Enforced: edits there are blocked.)`);
    } else if (card.kind === 'note') {
      stepItems.push(card.text);
    } else {
      stepItems.push(`${card.kind}: ${card.text}`);
    }
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
  if (step.kind === 'verify') {
    sections.push(
      'When you finish this step, end your reply with exactly one line:\nREINS: pass | fail: <what is missing>'
    );
  } else {
    sections.push(
      'When you finish this step, end your reply with exactly one line:\nREINS: done | blocked: <reason>'
    );
  }

  return sections.join('\n\n') + '\n';
}

export function compileProgram(
  w: Workflow,
  resolveBlock?: (name: string) => Workflow | undefined
): Instr[] {
  const instrs: Instr[] = [];
  const stepToIndex = new Map<string, number>();
  const linkPatches: Array<{
    instrIdx: number;
    targetStepId: string;
    patchType: 'onFail' | 'onPass';
  }> = [];

  function prefixStep(step: Step, prefix: string): Step {
    const copy: Step = {
      ...step,
      id: `${prefix}/${step.id}`,
      links: step.links.map((l) => ({
        ...l,
        to: `${prefix}/${l.to}`,
      })),
    };
    if (step.kids) {
      copy.kids = step.kids.map((k) => prefixStep(k, prefix));
    }
    if (step.else) {
      copy.else = step.else.map((k) => prefixStep(k, prefix));
    }
    return copy;
  }

  function compileStep(step: Step) {
    const idx = instrs.length;
    stepToIndex.set(step.id, idx);

    if (step.kind === 'recall') {
      const knowl = step.attrs.knowl || '';
      const topics = knowl
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      instrs.push({
        op: 'RECALL',
        step: step.id,
        topics,
      });
    } else if (step.kind === 'phase' || step.kind === 'say') {
      const guards = step.cards
        .filter((c) => c.kind === 'guard')
        .map((c) => c.text);
      const mode: 'read-only' | 'write' =
        step.attrs.mode === 'read-only' ? 'read-only' : 'write';
      instrs.push({
        op: 'TURN',
        step: step.id,
        policy: {
          mode,
          guards,
          allowShell: true,
        },
        src: step,
      });
    } else if (step.kind === 'gate') {
      instrs.push({
        op: 'GATE',
        step: step.id,
        cond: step.cond || { t: 'approve' },
      });
    } else if (step.kind === 'run') {
      instrs.push({
        op: 'RUN',
        step: step.id,
        cmd: step.attrs.cmd || '',
      });
    } else if (step.kind === 'repeat') {
      const max = parseInt(step.attrs.max || '1', 10);
      instrs.push({
        op: 'LOOP_IN',
        step: step.id,
        max,
      });

      const bodyStart = instrs.length;
      if (step.kids) {
        for (const kid of step.kids) {
          compileStep(kid);
        }
      }

      const loopExit = instrs.length + 1;
      let hasRunInstr = false;

      if (step.cond) {
        for (let i = bodyStart; i < instrs.length; i++) {
          const inst = instrs[i];
          if (inst && inst.op === 'RUN') {
            inst.repeatCond = step.cond;
            inst.loopExit = loopExit;
            hasRunInstr = true;
          }
        }
      }

      const firstKid = step.kids?.[0];
      const isRunMatch =
        firstKid?.kind === 'run' &&
        step.cond !== undefined &&
        ((step.cond.t === 'cmd' && step.cond.cmd === (firstKid.attrs.cmd || '')) ||
          (step.cond.t === 'tests' &&
            (firstKid.attrs.cmd === 'npm test' || !firstKid.attrs.cmd)));

      if (isRunMatch) {
        const runInstr = instrs[bodyStart];
        if (runInstr && runInstr.op === 'RUN') {
          runInstr.onPassJump = loopExit;
        }
      }

      instrs.push({
        op: 'LOOP_BK',
        step: step.id,
        target: bodyStart,
        cond: hasRunInstr ? undefined : step.cond,
      });
    } else if (step.kind === 'if') {
      const ifInstr: Instr = {
        op: 'IF',
        step: step.id,
        cond: step.cond || { t: 'done' },
        elseJump: 0,
      };
      instrs.push(ifInstr);

      if (step.kids) {
        for (const kid of step.kids) {
          compileStep(kid);
        }
      }

      if (step.else && step.else.length > 0) {
        const jumpEndIdx = instrs.length;
        instrs.push({ op: 'JUMP', target: 0 });
        const elseStart = instrs.length;
        ifInstr.elseJump = elseStart;
        for (const elseKid of step.else) {
          compileStep(elseKid);
        }
        const endIfIdx = instrs.length;
        (instrs[jumpEndIdx] as { op: 'JUMP'; target: number }).target = endIfIdx;
      } else {
        const endIfIdx = instrs.length;
        ifInstr.elseJump = endIfIdx;
      }
    } else if (step.kind === 'verify') {
      const onFail = step.links.find((l) => l.kind === 'on-fail');
      const verifyIdx = instrs.length;
      instrs.push({
        op: 'VERIFY',
        step: step.id,
        against: step.attrs.against || '',
        linkMax: onFail?.max,
      });

      if (onFail) {
        linkPatches.push({
          instrIdx: verifyIdx,
          targetStepId: onFail.to,
          patchType: 'onFail',
        });
      }
    } else if (step.kind === 'use') {
      const blockName = step.title || step.attrs.use || step.id;
      const block = resolveBlock ? resolveBlock(blockName) : undefined;
      if (block) {
        for (const bStep of block.steps) {
          const prefixed = prefixStep(bStep, blockName);
          compileStep(prefixed);
        }
      }
    } else if (step.kind === 'store') {
      instrs.push({
        op: 'STORE',
        step: step.id,
        what: step.attrs.knowl || 'decisions',
      });
    } else if (step.kind === 'handoff') {
      instrs.push({
        op: 'HANDOFF',
        step: step.id,
        to: step.attrs.to || 'fresh session',
        ...(step.attrs.focus ? { focus: step.attrs.focus } : {}),
      });
    }
  }

  for (const step of w.steps) {
    compileStep(step);
  }

  instrs.push({ op: 'END' });

  // Patch jumps
  for (const patch of linkPatches) {
    const targetIdx = stepToIndex.get(patch.targetStepId);
    if (targetIdx !== undefined) {
      const instr = instrs[patch.instrIdx];
      if (instr && instr.op === 'VERIFY' && patch.patchType === 'onFail') {
        instr.onFailJump = targetIdx;
      }
    }
  }

  return instrs;
}
