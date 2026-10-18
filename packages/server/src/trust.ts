import { createHash } from 'node:crypto';
import { CONDS, compileProgram, condAtoms, opOf, printCond, type Cond, type Workflow } from '@reins/core';

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

/** The models a workflow's own steps ask for, in program order (a kind's NODE instruction with a `model` attribute). */
export function modelsOf(w: Workflow, resolveBlock: (name: string) => Workflow | undefined): Array<{ step: string; model: string }> {
  const out: Array<{ step: string; model: string }> = [];
  for (const i of compileProgram(w, resolveBlock)) {
    if (i.op === 'NODE' && i.src.attrs.model) out.push({ step: i.step, model: i.src.attrs.model });
  }
  return out;
}

export const hashCommands = (commands: string[]) => createHash('sha256').update(commands.join('\0')).digest('hex');
