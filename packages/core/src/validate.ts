import picomatch from 'picomatch';
import type { Workflow, Step, Diagnostic, Cond, StepKind } from './model.js';

const KNOWN_KINDS: Set<StepKind> = new Set([
  'phase',
  'say',
  'run',
  'gate',
  'repeat',
  'if',
  'verify',
  'use',
  'recall',
  'store',
  'handoff',
]);

const KNOWN_ATTRS: Set<string> = new Set([
  'id',
  'mode',
  'until',
  'max',
  'against',
  'knowl',
  'to',
  'focus',
  'cmd',
  'use',
]);

function isValidGlob(glob: string): boolean {
  if (!glob || typeof glob !== 'string') return false;
  let inBracket = false;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '\\') {
      i++;
      continue;
    }
    if (glob[i] === '[') {
      if (inBracket) return false;
      inBracket = true;
    } else if (glob[i] === ']') {
      if (!inBracket) return false;
      inBracket = false;
    }
  }
  if (inBracket) return false;
  try {
    const re = picomatch.makeRe(glob, { strictSlashes: true });
    return re instanceof RegExp;
  } catch {
    return false;
  }
}

function hasModelCond(cond?: Cond): string | null {
  if (!cond) return null;
  if (cond.t === 'llm') return 'llm says';
  if (cond.t === 'review') return 'reviewer approves';
  if (cond.t === 'and' || cond.t === 'or') {
    return hasModelCond(cond.a) || hasModelCond(cond.b);
  }
  if (cond.t === 'not') {
    return hasModelCond(cond.a);
  }
  return null;
}

function hasTestsCond(cond?: Cond): boolean {
  if (!cond) return false;
  if (cond.t === 'tests') return true;
  if (cond.t === 'and' || cond.t === 'or') {
    return hasTestsCond(cond.a) || hasTestsCond(cond.b);
  }
  if (cond.t === 'not') {
    return hasTestsCond(cond.a);
  }
  return false;
}

function forEachGlobInCond(cond: Cond | undefined, fn: (glob: string) => void): void {
  if (!cond) return;
  if (cond.t === 'touches') {
    fn(cond.glob);
  } else if (cond.t === 'and' || cond.t === 'or') {
    forEachGlobInCond(cond.a, fn);
    forEachGlobInCond(cond.b, fn);
  } else if (cond.t === 'not') {
    forEachGlobInCond(cond.a, fn);
  }
}

export function validate(
  w: Workflow,
  resolveBlock?: (name: string) => Workflow | undefined
): Diagnostic[] {
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
    if (!KNOWN_KINDS.has(step.kind)) {
      diagnostics.push({
        severity: 'error',
        message: `Unknown step kind "${step.kind}"`,
        pos,
      });
    }

    // Rule 1: unknown attribute keys
    for (const key of Object.keys(step.attrs)) {
      if (!KNOWN_ATTRS.has(key)) {
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

    // Rule 4: repeat without max
    if (step.kind === 'repeat') {
      if (!step.attrs.max || parseInt(step.attrs.max, 10) <= 0) {
        diagnostics.push({
          severity: 'error',
          message: `repeat step "${step.id}" requires max`,
          pos,
        });
      }
    }

    // Rule 5: gate without until
    if (step.kind === 'gate') {
      if (!step.cond) {
        diagnostics.push({
          severity: 'error',
          message: `gate step "${step.id}" requires until: condition`,
          pos,
        });
      }
    }

    // Rule 7: use naming a block that can't be found
    if (step.kind === 'use') {
      const blockName = step.title || step.attrs.use || step.id;
      if (resolveBlock) {
        const resolved = resolveBlock(blockName);
        if (!resolved) {
          diagnostics.push({
            severity: 'error',
            message: `Block "${blockName}" not found`,
            pos,
          });
        }
      }
    }

    // Rule 8: glob that won't compile
    for (const card of step.cards) {
      if (card.kind === 'guard') {
        if (!isValidGlob(card.text)) {
          diagnostics.push({
            severity: 'error',
            message: `Invalid glob "${card.text}" in guard`,
            pos: card.pos || pos,
          });
        }
      }
    }

    forEachGlobInCond(step.cond, (glob) => {
      if (!isValidGlob(glob)) {
        diagnostics.push({
          severity: 'error',
          message: `Invalid glob "${glob}" in touches condition`,
          pos,
        });
      }
    });

    // Warning 1: llm / reviewer model call warning
    const modelAtom = hasModelCond(step.cond);
    if (modelAtom) {
      diagnostics.push({
        severity: 'warning',
        message: `Condition uses "${modelAtom}" which costs extra model calls`,
        pos,
      });
    }

    // Warning 2: tests pass without test in frontmatter
    if (hasTestsCond(step.cond) && !w.test) {
      diagnostics.push({
        severity: 'warning',
        message:
          'Condition "tests pass" with no test command set in frontmatter falls back to "npm test"',
        pos,
      });
    }

    // Warning 3: phase step with no prompt
    if (step.kind === 'phase') {
      if (!step.prompt || step.prompt.trim() === '') {
        diagnostics.push({
          severity: 'warning',
          message: `Phase step "${step.id}" has no prompt`,
          pos,
        });
      }
    }
  }

  // Rule 3 and Rule 4 (backward link): link targets and verify against
  for (const step of allSteps) {
    const pos = step.pos || { line: 1, col: 1 };

    // verify against
    if (step.kind === 'verify' && step.attrs.against) {
      if (!allIds.has(step.attrs.against)) {
        diagnostics.push({
          severity: 'error',
          message: `verify against target "${step.attrs.against}" not found`,
          pos,
        });
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
    const modelAtom = hasModelCond(auto.cond);
    if (modelAtom) {
      diagnostics.push({
        severity: 'warning',
        message: `Condition uses "${modelAtom}" which costs extra model calls`,
        pos: { line: 1, col: 1 },
      });
    }

    forEachGlobInCond(auto.cond, (glob) => {
      if (!isValidGlob(glob)) {
        diagnostics.push({
          severity: 'error',
          message: `Invalid glob "${glob}" in touches condition`,
          pos: { line: 1, col: 1 },
        });
      }
    });
  }

  return diagnostics;
}
