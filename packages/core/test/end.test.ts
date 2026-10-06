import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorkflow, printWorkflow, validate, compileProgram, Run, FakeEngine } from '../src/index.js';

const head = '---\nreins: 1\nname: ends\nbudget: { turns: 10, minutes: 5 }\nalways: []\n---\n\n';
const wf = (body: string) => head + body;
const ok = (text: string) => {
  const p = parseWorkflow(text);
  expect(p.diagnostics).toEqual([]);
  return p.workflow!;
};
const never = (text: string) => validate(ok(text)).filter((d) => d.message.includes('never reached'));
const PLAN_END_FIX = wf('## phase plan\n> Plan it.\n\n## end\n\n## phase fix\n> Fix it.\n');

describe('end step', () => {
  it('parses with the default id, prints back byte-equal, keeps an explicit id', () => {
    const text = wf('## phase plan\n> Plan it.\n\n## end\n');
    const w = ok(text);
    expect(w.steps[1]).toMatchObject({ kind: 'end', id: 'end-1' });
    expect(printWorkflow(w)).toBe(text);
    const named = wf('## end\nid: stop\n');
    expect(ok(named).steps[0]!.id).toBe('stop');
    expect(printWorkflow(ok(named))).toBe(named);
  });

  it('compiles to END and the first END closes the step at top 1', () => {
    const ins = compileProgram(ok(PLAN_END_FIX));
    expect(ins.map((i) => i.op)).toEqual(['TURN', 'END', 'TURN', 'END']);
    expect(ins[1]!.top).toBe(1);
  });

  it('a run is done after plan: fix gets no turn', async () => {
    const engine = new FakeEngine([{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: ok(PLAN_END_FIX), engine });
    for (let i = 0; i < 10 && run.status === 'running'; i++) await run.step();
    expect(run.status).toBe('done');
    expect(engine.receivedTexts).toHaveLength(1);
  });

  it('an end inside a repeat body ends the run after the first turn there', async () => {
    const w = ok(wf('## repeat\nuntil: you approve\nmax: 3\n\n### phase work\n> Work.\n\n### end\n'));
    const engine = new FakeEngine([{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: w, engine });
    for (let i = 0; i < 10 && run.status === 'running'; i++) await run.step();
    expect(run.status).toBe('done');
    expect(engine.receivedTexts).toHaveLength(1);
  });

  it('a step after the end with no link is never reached; a link to it fixes that', () => {
    expect(never(PLAN_END_FIX)).toHaveLength(1);
    expect(never(PLAN_END_FIX)[0]).toMatchObject({ severity: 'warning', message: 'step `fix` is never reached' });
    expect(never(wf('## phase plan\nnext: fix\n> Plan it.\n\n## end\n\n## phase fix\n> Fix it.\n'))).toEqual([]);
  });

  it('warns when an end has links, cards or a prompt', () => {
    const d = validate(ok(wf('## phase plan\n> Plan it.\n\n## end\nnext: plan (max 2)\n')));
    expect(d.map((x) => x.message)).toContain('an end step stops the workflow; its links, cards and prompt do nothing');
  });

  it('a file without end is unchanged: bug-fix compiles and validates as before the node existed', () => {
    const p = parseWorkflow(readFileSync(new URL('../../../examples/bug-fix.reins.md', import.meta.url), 'utf8'));
    expect(p.diagnostics).toEqual([]);
    expect(compileProgram(p.workflow!).map((i) => i.op)).toEqual(['TURN', 'GATE', 'LOOP_IN', 'TURN', 'RUN', 'LOOP_BK', 'IF', 'GATE', 'JUMP', 'TURN', 'HANDOFF', 'END']);
    const fallback = 'Condition "tests pass" with no test command set in frontmatter falls back to "npm test"';
    expect(validate(p.workflow!).map((d) => `${d.severity}:${d.message}`)).toEqual([`warning:${fallback}`, `warning:${fallback}`]);
  });
});