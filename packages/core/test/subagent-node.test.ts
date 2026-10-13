import { describe, it, expect, vi } from 'vitest';
import { parseWorkflow, printWorkflow, validate, compileProgram, NODES } from '../src/index.js';
import type { ExecCtx, Step } from '../src/index.js';
import { policyOf, turnInstr } from '../src/nodes/turn.js';

const head = (usd = '') => `---\nreins: 1\nname: subs\nbudget: { turns: 10, minutes: 5${usd} }\nalways: []\n---\n\n`;
const wf = (body: string, usd = ', usd: 2.00') => head(usd) + body;
const ok = (text: string) => {
  const p = parseWorkflow(text);
  expect(p.diagnostics).toEqual([]);
  return p.workflow!;
};
const errors = (text: string) => validate(ok(text)).filter((d) => d.severity === 'error').map((d) => d.message);
const warnings = (text: string) => validate(ok(text)).filter((d) => d.severity === 'warning').map((d) => d.message);

describe('subagent step: parse and print', () => {
  it('reads title, model, usd and prompt, and prints the same bytes (the model: line survives print)', () => {
    const text = wf('## subagent research\nmodel: claude-haiku-5-5\nusd: 0.50\n> Look.\n');
    const w = ok(text);
    expect(w.steps[0]).toMatchObject({ kind: 'subagent', id: 'subagent-1', title: 'research', attrs: { model: 'claude-haiku-5-5', usd: '0.50' }, prompt: 'Look.' });
    expect(validate(w)).toEqual([]);
    expect(printWorkflow(w)).toBe(text);
  });

  it('mode: read-only and a guard card round-trip, in print order', () => {
    const text = wf('## subagent research\nmode: read-only\nguard: src/**\nmodel: m\nusd: 0.50\n> Look.\n');
    const w = ok(text);
    expect(w.steps[0]!.attrs.mode).toBe('read-only');
    expect(w.steps[0]!.cards).toMatchObject([{ kind: 'guard', text: 'src/**' }]);
    expect(printWorkflow(w)).toBe(text);
  });

  it('a bare heading prints "## subagent"', () => {
    const text = wf('## subagent\n> Look.\n');
    expect(printWorkflow(ok(text))).toBe(text);
  });
});

describe('subagent step: validate', () => {
  it('no prompt warns', () => {
    expect(warnings(wf('## subagent research\n'))).toContain('Subagent step "subagent-1" has no prompt');
  });

  it('a prompt of only whitespace warns like no prompt', () => {
    const w = parseWorkflow(wf('## subagent research\n> \n')).workflow!;
    w.steps[0]!.prompt = '   ';
    expect(validate(w).filter((d) => d.severity === 'warning').map((d) => d.message)).toContain('Subagent step "subagent-1" has no prompt');
  });

  it('a run step still prints its command in the heading only (no cmd: line), a stray cmd: on a phase still does not print', () => {
    const text = wf('## run `echo hi`\n\n## subagent research\nmodel: claude-haiku-5-5\n> Look.\n');
    expect(printWorkflow(ok(text))).toBe(text);
    expect(printWorkflow(ok(text))).not.toContain('cmd:');
  });

  it('mode: x is checkMode\'s error', () => {
    expect(errors(wf('## subagent r\nmode: x\n> Go.\n'))).toEqual(['mode must be read-only or write, not "x" (step "subagent-1")']);
  });

  it('slices of a model block and a subagent are summed against the workflow USD', () => {
    expect(errors(wf('## model m\nusd: 1.10\n\n## subagent r\nusd: 1.90\n> Go.\n'))).toEqual(["The blocks' budgets add up to $3.00, over the workflow's $2.00."]);
    expect(errors(wf('## model m\nusd: 1.10\n\n## subagent r\nusd: 0.90\n> Go.\n'))).toEqual([]);
  });

  it('a slice with no workflow USD asks for it', () => {
    expect(errors(wf('## subagent r\nusd: 0.50\n> Go.\n', ''))).toEqual(["Set the workflow's USD budget first: block budgets are carved out of it."]);
  });

  it('a malformed slice is refused in words', () => {
    expect(errors(wf('## subagent r\nusd: 1.234\n> Go.\n'))).toEqual(['Budget (USD) of `subagent-1` must be an amount above 0, like 0.50.']);
  });

  it('model: on a phase warns (it used to be a parse error)', () => {
    const text = wf('## phase a\nmodel: x\n> Go.\n');
    expect(parseWorkflow(text).diagnostics).toEqual([]);
    expect(warnings(text)).toContain('`model:` does nothing on a phase step');
  });

  it('model: on a model block with no heading id and on a subagent do not warn', () => {
    expect(warnings(wf('## model\nmodel: x\n'))).not.toContain('`model:` does nothing on a model step');
    expect(warnings(wf('## subagent r\nmodel: x\n> Go.\n'))).toEqual([]);
  });
});

describe('subagent step: compile', () => {
  it('compiles to one NODE op, then the next step', () => {
    const w = ok(wf('## subagent r\n> Look.\n\n## phase use\n> Use it.\n'));
    const prog = compileProgram(w);
    expect(prog.map((i) => i.op)).toEqual(['NODE', 'TURN', 'END']);
    expect(prog[0]).toMatchObject({ op: 'NODE', step: 'subagent-1', kind: 'subagent', src: w.steps[0] });
  });

  it('inside use the id is prefixed', () => {
    const block = parseWorkflow('---\nreins: 1\nblock: b\n---\n\n## subagent r\n> Look.\n').workflow!;
    const w = ok(wf('## use b\n'));
    const prog = compileProgram(w, (n) => (n === 'b' ? block : undefined));
    expect(prog[0]).toMatchObject({ op: 'NODE', step: 'b/subagent-1', kind: 'subagent', src: { id: 'b/subagent-1' } });
  });
});

describe('subagent step: exec', () => {
  const step = (attrs: Record<string, string>): Step => ({ id: 'subagent-1', kind: 'subagent', attrs, cards: [], links: [] });
  const stub = (out: boolean) => ({ subagent: vi.fn(async () => out) }) as unknown as ExecCtx & { subagent: ReturnType<typeof vi.fn> };
  const exec = (s: Step, c: ExecCtx) => NODES.get('subagent')!.exec!(s, c);

  it('true: next, called with the step and the slice as a number', async () => {
    const ctx = stub(true);
    const s = step({ usd: '0.50' });
    expect(await exec(s, ctx)).toBe('next');
    expect(ctx.subagent).toHaveBeenCalledWith(s, 0.5);
  });

  it('false: stay', async () => {
    expect(await exec(step({ usd: '0.50' }), stub(false))).toBe('stay');
  });

  it('no usd: undefined', async () => {
    const ctx = stub(true);
    await exec(step({}), ctx);
    expect(ctx.subagent.mock.calls[0]![1]).toBeUndefined();
  });
});

describe('policyOf', () => {
  it('is the policy turnInstr carries (a read-only phase with a guard)', () => {
    const w = ok(wf('## phase a\nmode: read-only\nguard: src/**\n> Go.\n'));
    const s = w.steps[0]!;
    const p = policyOf(s);
    expect(p.mode).toBe('read-only');
    expect(p.guards.length).toBe(1);
    expect(turnInstr(s)).toMatchObject({ op: 'TURN', step: s.id, policy: p });
  });
});
