import type { Workflow, Step, Cond } from '../../src/model.js';

export function generateTrees(n: number): Workflow[] {
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

  const out: Workflow[] = [];
  for (let i = 0; i < n; i++) {
    stepCounter = 0;
    const numSteps = randInt(1, 4);
    const steps: Step[] = [];
    for (let s = 0; s < numSteps; s++) steps.push(generateRandomStep(0));
    out.push({ version: 1, name: `test-wf-${i}`, task: `task description ${i}`,
      budget: { turns: randInt(10, 100), minutes: randInt(5, 60) }, always: [`Always rule ${i}`], steps, autos: [] });
  }
  return out;
}
