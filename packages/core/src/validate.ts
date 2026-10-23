import type { Workflow, Step, Diagnostic, Pos } from './model.js';
import { isValidGlob } from './util.js';
import { CARDS } from './cards/index.js';
import { CONDS } from './conds/index.js';
import { NODES, opOf, nodeAttrs, headingOwns, unknownKind, type ValidateCtx, type ProgramCtx } from './nodes/index.js';
import { condAtoms } from './cond.js';
import { compileProgram, programProblem, type Instr, type StepStart } from './compile.js';
import { usdText } from './format/print.js';

/** The instructions reached from `from`. END stops, JUMP goes to its target, an op with `next` goes where it says, else on one. With `skipStarts`, the places an op starts tracks at are left out (one each: a wire to the next instruction does not hide it). */
function walk(program: readonly Instr[], from: number, skipStarts: boolean): Set<number> {
  const seen = new Set<number>();
  const todo = [from];
  while (todo.length) {
    const i = todo.pop()!;
    const ins = program[i];
    if (!ins || seen.has(i)) continue;
    seen.add(i);
    if (ins.op === 'END') continue;
    if (ins.op === 'JUMP') { todo.push(ins.target); continue; }
    const op = opOf(ins.op);
    if (!op?.next) { todo.push(i + 1); continue; }
    const out = op.next(ins, i).map((x) => x ?? -1);
    if (skipStarts) for (const s of op.starts?.(ins) ?? []) { const k = out.indexOf(s); if (k >= 0) out.splice(k, 1); }
    todo.push(...out);
  }
  return seen;
}

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
  // What the parser said about a block file (set by the host that read it) comes first, then what validate says about it on its own.
  const checkBlock = (b: Workflow) => [...(b.problems ?? []), ...validate({ ...b, block: b.block || 'block' }, resolveBlock)];
  const vctx = (pos: Pos): ValidateCtx => ({ push: (d) => diagnostics.push(d), pos, resolveBlock, allIds, checkBlock });

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
        message: unknownKind(step.kind),
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

    // U+0001 first is reserved: a track's USD counter is keyed with it (run.ts `trackSpendKey`), so no step id may equal such a key.
    if (step.id.startsWith('\u0001')) {
      diagnostics.push({ severity: 'error', message: `The id of step "${step.id.slice(1)}" starts with a reserved character`, pos });
    }

    // A name every object already has (`__proto__`, `constructor`, `toString`, ...) breaks the tables that are keyed by step id.
    if (step.id in Object.prototype || step.id === 'prototype') {
      diagnostics.push({ severity: 'error', message: `"${step.id}" cannot be a step id: it is a name every object already has. Pick another id`, pos });
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

  // D5: block budgets (`usd:` on a kind that owns it) are carved out of the workflow's USD budget; with none set, they are caps of their own.
  // ponytail: a block file's slices (a playbook's file) are not counted here: the run enforces them anyway; count through resolveBlock if it bites.
  const owns = (s: Step) => NODES.get(s.kind)?.attrs.includes('usd') === true;
  const validUsd = (s: Step) => /^\d+(\.\d{1,2})?$/.test(s.attrs.usd!.trim()) && Number(s.attrs.usd) > 0;   // the app's parseBudget rule (panelEdit.ts:60)
  for (const s of allSteps) {
    if (s.attrs.usd === undefined) continue;
    const pos = s.pos || { line: 1, col: 1 };
    if (!owns(s)) diagnostics.push({ severity: 'warning', message: `\`usd:\` does nothing on a ${s.kind} step`, pos });
    else if (!validUsd(s)) {
      diagnostics.push({ severity: 'error', message: `Budget (USD) of \`${s.id}\` must be an amount above 0, like 0.50.`, pos });
    }
  }
  // A `model:` or `reasoning:` line is parsed on any kind (a subagent owns both), so the kinds that do not own it say so here.
  const ownsKey = (s: Step, k: string) => { const n = NODES.get(s.kind); return !!n && (n.attrs.includes(k) || !!n.heading?.owns?.includes(k)); };
  for (const s of allSteps) {
    for (const k of ['model', 'reasoning']) {
      if (s.attrs[k] !== undefined && !ownsKey(s, k)) diagnostics.push({ severity: 'warning', message: `\`${k}:\` does nothing on a ${s.kind} step`, pos: s.pos || { line: 1, col: 1 } });
    }
  }
  // Only valid slices are summed: a malformed one already has its own error.
  const sliced = allSteps.filter((s) => s.attrs.usd !== undefined && owns(s) && validUsd(s));
  if (!w.block && sliced.length) {
    const pos = sliced[0]!.pos || { line: 1, col: 1 };
    const sum = sliced.reduce((a, s) => a + (Number(s.attrs.usd) || 0), 0);
    if (w.budget.usd !== undefined && sum > w.budget.usd + 1e-9) diagnostics.push({ severity: 'error', message: `The blocks' budgets add up to $${usdText(Math.round(sum * 100) / 100)}, over the workflow's $${usdText(w.budget.usd)}.`, pos });
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

  // Rule 3 and Rule 4 (backward link): link targets and verify against
  for (const step of allSteps) {
    const pos = step.pos || { line: 1, col: 1 };

    NODES.get(step.kind)?.validate?.links?.(step, vctx(pos));

    for (const kind of ['next', 'on-fail'] as const) {
      if (kind === 'next' && NODES.get(step.kind)?.manyNext) continue;
      const dup = step.links.filter((l) => l.kind === kind)[1];
      if (dup) {
        diagnostics.push({ severity: 'error', message: `a step can have only one \`${kind}\` link`, pos: dup.pos || pos });
      }
    }
    if (step.links.some((l) => l.kind === 'on-fail') && !NODES.get(step.kind)?.fails) {
      diagnostics.push({ severity: 'warning', message: `on-fail only applies to ${failKinds.join(', ')}`, pos });
    }
    for (const link of step.links) {
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
    const starts = new Map<number, StepStart[]>();
    const program = compileProgram(w, resolveBlock, starts);
    const broken = programProblem(program, true);
    if (broken) diagnostics.push({ severity: 'error', message: broken, pos: { line: 1, col: 1 } });
    // A step id that starts at two places in the program: a block that puts steps in (a playbook) made an id the file already has. Every id is checked, and none is named here.
    const startsAt = new Map<string, number>();
    const twice = new Set<string>();
    for (const [index, here] of starts) {
      for (const { step } of here) {
        if (startsAt.has(step) && startsAt.get(step) !== index) twice.add(step);
        else startsAt.set(step, index);
      }
    }
    for (const id of twice) {
      diagnostics.push({ severity: 'error', message: `\`${id}\` would appear twice once the playbooks are put in; give one of the steps another id`, pos: allSteps.find((s) => s.id === id)?.pos || { line: 1, col: 1 } });
    }
    const seen = walk(program, 0, false);
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

    // Tracks: every instruction an op starts one at is the first of a region (what it reaches without starting more).
    // Only steps count in a region (an `end` block compiles to a bare END), and only outside the main line for R2.
    const stepAt = (i: number) => { const ins = program[i]; return ins && 'step' in ins ? (ins.step as string | undefined) : undefined; };
    const posOf = (id: string | undefined) => allSteps.find((s) => s.id === id)?.pos || { line: 1, col: 1 };
    const main = walk(program, 0, true);
    const regions: Array<{ by: string; at: number; start: string; cells: number[] }> = [];
    program.forEach((ins, i) => {
      for (const at of new Set(opOf(ins.op)?.starts?.(ins) ?? [])) {
        const start = stepAt(at);
        if (start === undefined) continue;
        const cells = [...walk(program, at, true)].filter((c) => stepAt(c) !== undefined).sort((a, b) => a - b);
        regions.push({ by: stepAt(i) ?? ins.op, at, start, cells });
      }
    });
    const leaked = new Set<(typeof regions)[number]>();
    for (const r of regions) {
      if (main.has(r.at)) {
        leaked.add(r);
        diagnostics.push({ severity: 'error', message: `\`${r.start}\` starts a branch of \`${r.by}\`, so only \`${r.by}\` may start it: put it behind the end, and let nothing else lead into it`, pos: posOf(r.by) });
        continue;
      }
      const back = r.cells.find((c) => main.has(c));
      if (back !== undefined) diagnostics.push({ severity: 'error', message: `branch \`${r.start}\` of \`${r.by}\` leads back into the stack at \`${stepAt(back)}\`; end the branch instead`, pos: posOf(r.by) });
    }
    const apart = regions.filter((r) => !leaked.has(r));
    apart.forEach((a, k) => {
      for (const b of apart.slice(k + 1)) {
        const shared = a.cells.find((c) => !main.has(c) && b.cells.includes(c));
        if (shared !== undefined) diagnostics.push({ severity: 'error', message: `\`${stepAt(shared)}\` is in branch \`${a.start}\` and branch \`${b.start}\`; put an end under each branch`, pos: posOf(a.by) });
      }
    });

    if (!diagnostics.some((d) => d.severity === 'error')) {
      const regionOf = (start: string) => regions.find((r) => r.start === start);
      const members = (start: string, nested?: boolean): string[] => {
        const cells = new Set<number>();
        const todo = [start];
        const done = new Set<string>();
        while (todo.length) {
          const s = todo.pop()!;
          if (done.has(s)) continue;
          done.add(s);
          const r = regionOf(s);
          if (!r) continue;
          for (const c of r.cells) {
            cells.add(c);
            const ins = program[c]!;
            if (nested) for (const at of opOf(ins.op)?.starts?.(ins) ?? []) { const t = stepAt(at); if (t !== undefined) todo.push(t); }
          }
        }
        return [...new Set([...cells].sort((a, b) => a - b).map((c) => stepAt(c)!))];
      };
      const trackOf = (id: string) => regions.find((r) => members(r.start).includes(id))?.start;
      const pctx = (pos: Pos): ProgramCtx => ({ ...vctx(pos), program, trackOf, members });
      for (const step of allSteps) NODES.get(step.kind)?.validate?.program?.(step, pctx(step.pos || { line: 1, col: 1 }));
    }
  }
  return diagnostics;
}
