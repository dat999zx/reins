import { createHash } from 'node:crypto';
import { CONDS, NODES, compileProgram, condAtoms, opOf, printCond, type Cond, type Workflow } from '@reins/core';

// What a workflow runs on its own (plan 15d 3b.6): RUN commands, the atoms a command judges, and the test command. No kind is named here.
export function commandsOf(w: Workflow, resolveBlock: (name: string) => Workflow | undefined): string[] {
  const out: string[] = [];
  const conds = (c: Cond | undefined) => {
    for (const a of condAtoms(c)) if (CONDS.get(a.t)?.judge === 'command') out.push(printCond(a));
  };
  for (const i of compileProgram(w, resolveBlock)) {
    out.push(...(opOf(i.op)?.commands?.(i) ?? []));
    const { cond, repeatCond } = i as { cond?: Cond; repeatCond?: Cond };
    conds(cond);
    conds(repeatCond);
  }
  for (const a of w.autos) conds(a.cond);
  out.push(w.test ?? 'npm test');
  return out;
}

/** A step that names a model, a reasoning level or a USD slice (a kind's NODE instruction), in program order. `switches`: its heading names the model, so the steps after it run on it. */
export interface ModelStep { step: string; switches: boolean; model?: string; reasoning?: string; usd?: string }
export function modelStepsOf(w: Workflow, resolveBlock: (name: string) => Workflow | undefined): ModelStep[] {
  const out: ModelStep[] = [];
  for (const i of compileProgram(w, resolveBlock)) {
    if (i.op !== 'NODE') continue;
    const { model, reasoning, usd } = i.src.attrs;
    if (model || reasoning || usd !== undefined) {
      out.push({ step: i.step, switches: NODES.get(i.kind)?.heading?.owns?.includes('model') === true, ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}), ...(usd !== undefined ? { usd } : {}) });
    }
  }
  return out;
}

export const hashCommands = (commands: string[]) => createHash('sha256').update(commands.join('\0')).digest('hex');
