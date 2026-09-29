import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import type { Workflow, Step, Cond } from '../src/model.js';

describe('Task 1.4: Parser and Printer', () => {
  const examplesDir = path.resolve(__dirname, '../../../examples');
  const exampleFiles = [
    'upload-retry.reins.md',
    'bug-fix.reins.md',
    'tdd-loop.reins.md',
    'safe-refactor.reins.md',
    'blocks/review-pass.reins.md',
  ];

  it('parses each example with 0 diagnostics and round-trips byte-for-byte', () => {
    for (const relPath of exampleFiles) {
      const fullPath = path.join(examplesDir, relPath);
      const content = fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');
      const { workflow, diagnostics } = parseWorkflow(content);

      expect(diagnostics, `Diagnostics in ${relPath}: ${JSON.stringify(diagnostics)}`).toEqual([]);
      expect(workflow).toBeDefined();

      const printed = printWorkflow(workflow!);
      expect(printed, `Mismatch in ${relPath}`).toBe(content);
    }
  });

  it('handles \\r\\n input and prints with \\n', () => {
    const fullPath = path.join(examplesDir, 'upload-retry.reins.md');
    const content = fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');
    const crlfContent = content.replace(/\n/g, '\r\n');

    const { workflow, diagnostics } = parseWorkflow(crlfContent);
    expect(diagnostics).toEqual([]);
    expect(workflow).toBeDefined();

    const printed = printWorkflow(workflow!);
    expect(printed).toBe(content);
    expect(printed.includes('\r')).toBe(false);
  });

  it('parses nesting three levels deep', () => {
    const text = `---
reins: 1
name: nesting-test
budget: { turns: 10, minutes: 10 }
always: []
---

## repeat
until: tests pass
max: 3

### if diff > 100 lines

#### phase inner
> Inner step text.
`;
    const { workflow, diagnostics } = parseWorkflow(text);
    expect(diagnostics).toEqual([]);
    expect(workflow?.steps.length).toBe(1);
    const repeatStep = workflow!.steps[0]!;
    expect(repeatStep.kids?.length).toBe(1);
    const ifStep = repeatStep.kids![0]!;
    expect(ifStep.kids?.length).toBe(1);
    const innerStep = ifStep.kids![0]!;
    expect(innerStep.kind).toBe('phase');
    expect(innerStep.title).toBe('inner');
    expect(innerStep.prompt).toBe('Inner step text.');
  });

  it('correctly splits kids and else branches', () => {
    const text = `---
reins: 1
name: else-test
budget: { turns: 10, minutes: 10 }
always: []
---

## if tests pass

### phase then-step
> Do then.

### else

### phase else-step
> Do else.
`;
    const { workflow, diagnostics } = parseWorkflow(text);
    expect(diagnostics).toEqual([]);
    const ifStep = workflow!.steps[0]!;
    expect(ifStep.kids?.length).toBe(1);
    expect(ifStep.kids![0]!.title).toBe('then-step');
    expect(ifStep.else?.length).toBe(1);
    expect(ifStep.else![0]!.title).toBe('else-step');
  });

  it('returns diagnostic for unknown key at its line', () => {
    const text = `---
reins: 1
name: typo-test
budget: { turns: 10, minutes: 10 }
always: []
---

## phase plan
gaurd: src/**
> Plan.
`;
    const { diagnostics } = parseWorkflow(text);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.message).toContain('gaurd');
    expect(diagnostics[0]!.pos.line).toBe(9);
  });

  it('property test: 200 random trees satisfy parse(print(t)) deep equals t', () => {
    // Seeded pseudo-random number generator (mulberry32)
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const rand = mulberry32(42);
    function randInt(min: number, max: number) {
      return Math.floor(rand() * (max - min + 1)) + min;
    }
    function pick<T>(arr: readonly T[]): T {
      return arr[randInt(0, arr.length - 1)]!;
    }

    function generateRandomCond(depth = 0): Cond {
      if (depth > 1 || rand() < 0.7) {
        const atomTypes = [
          () => ({ t: 'approve' as const }),
          () => ({ t: 'tests' as const }),
          () => ({ t: 'cmd' as const, cmd: `npm test ${randInt(1, 10)}` }),
          () => ({ t: 'diff' as const, n: randInt(10, 500) }),
          () => ({ t: 'touches' as const, glob: `src/mod${randInt(1, 5)}/**` }),
          () => ({ t: 'attempts' as const, n: randInt(1, 5) }),
          () => ({ t: 'same' as const }),
          () => ({ t: 'drift' as const }),
          () => ({ t: 'done' as const }),
        ];
        return pick(atomTypes)();
      }
      if (rand() < 0.5) {
        return { t: 'not', a: generateRandomCond(depth + 1) };
      }
      return {
        t: rand() < 0.5 ? 'and' : 'or',
        a: generateRandomCond(depth + 1),
        b: generateRandomCond(depth + 1),
      };
    }

    let stepCounter = 0;
    function generateRandomStep(depth = 0): Step {
      const id = `s${++stepCounter}`;
      const kinds = ['phase', 'say', 'run', 'gate'] as const;
      const kind = depth < 2 && rand() < 0.3 ? (rand() < 0.5 ? 'repeat' : 'if') : pick(kinds);

      const step: Step = {
        id,
        kind,
        attrs: {},
        cards: [],
        links: [],
      };

      if (kind === 'phase') {
        step.title = `step-${id}`;
        step.prompt = `Prompt for ${id}`;
        if (rand() < 0.3) {
          step.cards.push({ kind: 'note', text: `Note for ${id}` });
        }
        if (rand() < 0.3) {
          step.cards.push({ kind: 'guard', text: `src/guard${randInt(1, 3)}/**` });
        }
      } else if (kind === 'say') {
        step.prompt = `Say something for ${id}`;
      } else if (kind === 'run') {
        step.attrs.cmd = `npm test ${randInt(1, 5)}`;
      } else if (kind === 'gate') {
        step.cond = generateRandomCond();
      } else if (kind === 'repeat') {
        step.cond = generateRandomCond();
        step.attrs.max = `${randInt(1, 5)}`;
        const numKids = randInt(1, 2);
        step.kids = [];
        for (let i = 0; i < numKids; i++) {
          step.kids.push(generateRandomStep(depth + 1));
        }
      } else if (kind === 'if') {
        step.cond = generateRandomCond();
        const numKids = randInt(1, 2);
        step.kids = [];
        for (let i = 0; i < numKids; i++) {
          step.kids.push(generateRandomStep(depth + 1));
        }
        if (rand() < 0.5) {
          step.else = [generateRandomStep(depth + 1)];
        }
      }

      return step;
    }

    for (let i = 0; i < 200; i++) {
      stepCounter = 0;
      const numSteps = randInt(1, 4);
      const steps: Step[] = [];
      for (let s = 0; s < numSteps; s++) {
        steps.push(generateRandomStep(0));
      }

      const original: Workflow = {
        version: 1,
        name: `test-wf-${i}`,
        task: `task description ${i}`,
        budget: { turns: randInt(10, 100), minutes: randInt(5, 60) },
        always: [`Always rule ${i}`],
        steps,
        autos: [],
      };

      const printed = printWorkflow(original);
      const parsed = parseWorkflow(printed);

      expect(parsed.diagnostics, `Errors at iteration ${i}`).toEqual([]);
      expect(parsed.workflow).toBeDefined();

      // Normalize any optional pos fields before comparison
      function cleanPos(obj: any): any {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(cleanPos);
        const copy: any = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'pos') continue;
          copy[k] = cleanPos(v);
        }
        return copy;
      }

      expect(cleanPos(parsed.workflow)).toEqual(cleanPos(original));
    }
  });
});
