import type { Step } from '../model.js';
import type { Instr, Policy } from '../compile.js';
import type { ValidateCtx } from './index.js';
import { CARDS } from '../cards/index.js';

export function checkMode(step: Step, ctx: ValidateCtx): void {
  const m = step.attrs.mode;
  if (m !== undefined && m !== 'read-only' && m !== 'write') {
    ctx.push({ severity: 'error', message: `mode must be read-only or write, not "${m}" (step "${step.id}")`, pos: ctx.pos });
  }
}

export function turnInstr(step: Step): Instr {
  const policy: Policy = { mode: step.attrs.mode === 'read-only' ? 'read-only' : 'write', guards: [], allowShell: true };
  for (const card of step.cards) CARDS.get(card.kind)?.policy?.(card, policy);
  return { op: 'TURN', step: step.id, policy, src: step };
}
