import type { Workflow, Step, Diagnostic, Pos } from './model.js';
import { isValidGlob } from './util.js';
import { CARDS } from './cards/index.js';
import { CONDS } from './conds/index.js';
import { NODES, nodeAttrs, headingOwns, type ValidateCtx } from './nodes/index.js';
import { condAtoms } from './cond.js';
import { compileProgram } from './compile.js';

export function validate(
  w: Workflow,
  resolveBlock?: (name: string) => Workflow | undefined
): Diagnostic[] {
  // Read the registries once per call, never at import: a test may add a type before calling.
  const accepted = new Set(['id', 'until', ...nodeAttrs(), ...headingOwns()]);
  const diagnostics: Diagnostic[] = [];

  // Rule 9: missing budget in frontmatter (for non-block workflow)
  if (!w.block) {
    if (!w.budget || (!w.budget.turns && !w.budget.minutes)) {
      diagnostics.push({
        severity: 'error',
        message: 'Workflow requires budget with turns and minutes',
        pos: { line: 1, col: 1 },
      });
    }
  }

  // Flatten all steps in document order
  const allSteps: Step[] = [];
  function collectSteps(steps: Step[]) {
    for (const step of steps) {
      allSteps.push(step);
      if (step.kids) collectSteps(step.kids);
      if (step.else) collectSteps(step.else);
    }
  }
  collectSteps(w.steps);

  const allIds = new Set<string>();
  const orderMap = new Map<string, number>();
  const vctx = (pos: Pos): ValidateCtx => ({ push: (d) => diagnostics.push(d), pos, resolveBlock, allIds });

  // Check step kinds, attributes, duplicate IDs, and build order
  for (let i = 0; i < allSteps.length; i++) {
    const step = allSteps[i]!;
    const pos = step.pos || { line: 1, col: 1 };

    // Rule 6: else outside an if
    if ((step.kind as string) === 'else') {
      diagnostics.push({
        severity: 'error',
        message: 'An else cannot appear outside an if',
        pos,
      });
    }

    // Rule 1: unknown step kind
    if (!NODES.has(step.kind)) {
      diagnostics.push({
        severity: 'error',
        message: `Unknown step kind "${step.kind}"`,
        pos,
      });
    }

    // Rule 1: unknown attribute keys
    for (const key of Object.keys(step.attrs)) {
      if (!accepted.has(key)) {
        diagnostics.push({
          severity: 'error',
          message: `Unknown attribute "${key}" on step "${step.id}"`,
          pos,
        });
      }
    }

    // Rule 2: duplicate step id
    if (allIds.has(step.id)) {
      diagnostics.push({
        severity: 'error',
        message: `Duplicate id "${step.id}"`,
        pos,
      });
    } else {
      allIds.add(step.id);
      orderMap.set(step.id, i);
    }

    // The node's own early rules
    NODES.get(step.kind)?.validate?.early?.(step, vctx(pos));

    for (const card of step.cards) {
      if (CARDS.get(card.kind)?.delivery) {
        diagnostics.push({
          severity: 'error',
          message: `"${card.kind}:" is only allowed in a whenever block`,
          pos: card.pos || pos,
        });
      }
    }

    // Rule 8: glob that won't compile
    for (const card of step.cards) {
      CARDS.get(card.kind)?.validate?.(card, { push: (d) => diagnostics.push(d), pos });
    }

    for (const a of condAtoms(step.cond)) {
      for (const glob of CONDS.get(a.t)?.globs?.(a) ?? []) {
        if (!isValidGlob(glob)) {
          diagnostics.push({
            severity: 'error',
            message: `Invalid glob "${glob}" in touches condition`,
            pos,
          });
        }
      }
    }

    // Warning 1: llm / reviewer model call warning
    const modelAtom = condAtoms(step.cond).map((a) => CONDS.get(a.t)?.modelCall).find(Boolean);
    if (modelAtom) {
      diagnostics.push({
        severity: 'warning',
        message: `Condition uses "${modelAtom}" which costs extra model calls`,
        pos,
      });
    }

    // Warning 2: tests pass without test in frontmatter
    if (condAtoms(step.cond).some((a) => CONDS.get(a.t)?.needsTestCmd) && !w.test) {
      diagnostics.push({
        severity: 'warning',
        message:
          'Condition "tests pass" with no test command set in frontmatter falls back to "npm test"',
        pos,
      });
    }

    // The node's own late rules
    NODES.get(step.kind)?.validate?.late?.(step, vctx(pos));
  }

  // Ids inside each container's body (all depths), for the jump-into-a-loop rule.
  const bodies = new Map<Step, Set<string>>();
  const collectBody = (s: Step, into: Set<string>) => {
    for (const k of [...(s.kids ?? []), ...(s.else ?? [])]) { into.add(k.id); collectBody(k, into); }
  };
  for (const s of allSteps) {
    if (NODES.get(s.kind)?.container === 'kids') { const b = new Set<string>(); collectBody(s, b); bodies.set(s, b); }
  }
  const failKinds = [...NODES.values()].filter((n) => n.fails).map((n) => n.kind);
  const DEPRECATED: Record<string, string> = {
    'on-pass': '`on-pass` has no effect; use `next`',
    retry: '`retry` has no effect; use a backward `next` with `max`',
    'verify-against': '`verify-against` has no effect; use `against:`',
    'hand-off': '`hand-off` has no effect; use a handoff step',
  };

  // Rule 3 and Rule 4 (backward link): link targets and verify against
  for (const step of allSteps) {
    const pos = step.pos || { line: 1, col: 1 };

    NODES.get(step.kind)?.validate?.links?.(step, vctx(pos));

    for (const kind of ['next', 'on-fail'] as const) {
      const dup = step.links.filter((l) => l.kind === kind)[1];
      if (dup) {
        diagnostics.push({ severity: 'error', message: `a step can have only one \`${kind}\` link`, pos: dup.pos || pos });
      }
    }
    if (step.links.some((l) => l.kind === 'on-fail') && !NODES.get(step.kind)?.fails) {
      diagnostics.push({ severity: 'warning', message: `on-fail only applies to ${failKinds.join(', ')}`, pos });
    }
    for (const link of step.links) {
      const msg = DEPRECATED[link.kind];
      if (msg) diagnostics.push({ severity: 'warning', message: msg, pos: link.pos || pos });
      for (const [loop, body] of bodies) {
        if (body.has(link.to) && !body.has(step.id)) {
          diagnostics.push({
            severity: 'error',
            message: `wire jumps into the body of \`${loop.id}\`; point at the loop instead`,
            pos: link.pos || pos,
          });
        }
      }
    }

    // links
    for (const link of step.links) {
      const linkPos = link.pos || pos;
      if (!allIds.has(link.to)) {
        diagnostics.push({
          severity: 'error',
          message: `Link target "${link.to}" not found`,
          pos: linkPos,
        });
      } else {
        const sourceOrder = orderMap.get(step.id);
        const targetOrder = orderMap.get(link.to);
        if (
          sourceOrder !== undefined &&
          targetOrder !== undefined &&
          targetOrder <= sourceOrder
        ) {
          // Backward link: needs max
          if (link.max === undefined || link.max <= 0) {
            diagnostics.push({
              severity: 'error',
              message: `Backward link to "${link.to}" requires max`,
              pos: linkPos,
            });
          }
        }
      }
    }
  }

  // Auto cards checks
  for (const auto of w.autos) {
    const modelAtom = condAtoms(auto.cond).map((a) => CONDS.get(a.t)?.modelCall).find(Boolean);
    if (modelAtom) {
      diagnostics.push({
        severity: 'warning',
        message: `Condition uses "${modelAtom}" which costs extra model calls`,
        pos: { line: 1, col: 1 },
      });
    }

    for (const a of condAtoms(auto.cond)) {
      for (const glob of CONDS.get(a.t)?.globs?.(a) ?? []) {
        if (!isValidGlob(glob)) {
          diagnostics.push({
            severity: 'error',
            message: `Invalid glob "${glob}" in touches condition`,
            pos: { line: 1, col: 1 },
          });
        }
      }
    }
  }

  // Unknown kinds and missing targets compile to nothing or fall through, so only judge a clean workflow.
  if (!diagnostics.some((d) => d.severity === 'error')) {
    const program = compileProgram(w, resolveBlock);
    const seen = new Set<number>();
    const todo = [0];
    while (todo.length) {
      const i = todo.pop()!;
      const ins = program[i];
      if (!ins || seen.has(i)) continue;
      seen.add(i);
      if (ins.op === 'END') continue;
      if (ins.op === 'JUMP') { todo.push(ins.target); continue; }
      todo.push(i + 1);
      if (ins.op === 'RUN') todo.push(ins.onFailJump ?? -1, ins.onPassJump ?? -1, ins.loopExit ?? -1);
      else if (ins.op === 'VERIFY') todo.push(ins.onFailJump ?? -1);
      else if (ins.op === 'IF') todo.push(ins.elseJump);
      else if (ins.op === 'LOOP_BK') todo.push(ins.target);
    }
    for (const step of allSteps) {
      const entry = program.findIndex((i) => 'step' in i && i.step === step.id);
      if (entry >= 0 && !seen.has(entry)) {
        diagnostics.push({
          severity: 'warning',
          message: `step \`${step.id}\` is never reached`,
          pos: step.pos || { line: 1, col: 1 },
        });
      }
    }
  }
  return diagnostics;
}
