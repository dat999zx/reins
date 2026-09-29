import type { Step } from '../model.js';
import type { Instr, Policy } from '../compile.js';
import { CARDS } from '../cards/index.js';

export function turnInstr(step: Step): Instr {
  const policy: Policy = { mode: step.attrs.mode === 'read-only' ? 'read-only' : 'write', guards: [], allowShell: true };
  for (const card of step.cards) CARDS.get(card.kind)?.policy?.(card, policy);
  return { op: 'TURN', step: step.id, policy, src: step };
}
