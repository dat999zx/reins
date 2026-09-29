import type { Workflow, Step, Diagnostic, Pos } from './model.js';
import { isValidGlob } from './util.js';
import { CARDS } from './cards/index.js';
import { CONDS } from './conds/index.js';
import { NODES, nodeAttrs, headingOwns, type ValidateCtx } from './nodes/index.js';
import { condAtoms } from './cond.js';

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

  // Rule 3 and Rule 4 (backward link): link targets and verify against
  for (const step of allSteps) {
    const pos = step.pos || { line: 1, col: 1 };

    NODES.get(step.kind)?.validate?.links?.(step, vctx(pos));

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

  return diagnostics;
}
