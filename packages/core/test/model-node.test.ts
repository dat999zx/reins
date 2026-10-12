import { describe, it, expect, vi } from 'vitest';
import { parseWorkflow, printWorkflow, validate, compileProgram, NODES } from '../src/index.js';
import type { ExecCtx, Step, SwitchOutcome } from '../src/index.js';

const head = (usd = '') => `---\nreins: 1\nname: models\nbudget: { turns: 10, minutes: 5${usd} }\nalways: []\n---\n\n`;
const wf = (body: string, usd = ', usd: 2.00') => head(usd) + body;
const ok = (text: string) => {
  const p = parseWorkflow(text);
  expect(p.diagnostics).toEqual([]);
  return p.workflow!;
};
const errors = (text: string) => validate(ok(text)).filter((d) => d.severity === 'error').map((d) => d.message);
const warnings = (text: string) => validate(ok(text)).filter((d) => d.severity === 'warning').map((d) => d.message);

describe('model step: parse and print', () => {
  it('reads the id from the heading and the slice from usd:, prints the same bytes', () => {
    const text = wf('## model claude-opus-5-5\nusd: 0.50\n');
    const w = ok(text);
    expect(w.steps[0]).toMatchObject({ kind: 'model', id: 'model-1', attrs: { model: 'claude-opus-5-5', usd: '0.50' } });
    expect(printWorkflow(w)).toBe(text);
    expect(validate(w)).toEqual([]);
  });

  it('a heading with no id has empty attrs and prints "## model"', () => {
    const text = wf('## model\n');
    const w = ok(text);
    expect(w.steps[0]!.attrs).toEqual({});
    expect(printWorkflow(w)).toBe(text);
  });

  it('budget: in a model block is a card (the reason the slice is usd:)', () => {
    const w = ok(wf('## model m\nbudget: 0.50\n'));
    expect(w.steps[0]!.cards).toMatchObject([{ kind: 'budget', text: '0.50' }]);
    expect(warnings(wf('## model m\nbudget: 0.50\n'))).toContain('a model step sends no turn; its cards and prompt do nothing');
  });

  it('the heading takes no condition: until: is parsed as a condition, as on any kind', () => {
    const p = parseWorkflow(wf('## model m\nuntil: tests pass\n'));
    expect(p.diagnostics).toEqual([]);
    expect(p.workflow!.steps[0]!.cond).toEqual({ t: 'tests' });
    expect(p.workflow!.steps[0]!.attrs.until).toBeUndefined();
  });

  it('model: as a line is an unknown attribute: the id lives in the heading only', () => {
    const p = parseWorkflow(wf('## model m\nmodel: x\n'));
    expect(p.diagnostics.map((d) => d.message)).toContain('Unknown attribute "model"');
  });
});

describe('model step: validate', () => {
  const two = (a: string, b: string) => wf(`## model m1\nusd: ${a}\n\n## phase a\n> Go.\n\n## model m2\nusd: ${b}\n`);

  it('slices that fit the workflow USD pass', () => {
    expect(errors(two('1.10', '0.90'))).toEqual([]);
  });

  it('slices over the workflow USD are one error with the sum', () => {
    expect(errors(two('1.10', '1.90'))).toEqual(["The blocks' budgets add up to $3.00, over the workflow's $2.00."]);
  });

  it('float noise does not fail an exact fit: 0.10 + 0.20 under 0.30 passes', () => {
    expect(errors(wf('## model m1\nusd: 0.10\n\n## model m2\nusd: 0.20\n', ', usd: 0.30'))).toEqual([]);
  });

  it('the sum in the message is rounded to cents: 0.10 + 0.20 over 0.25 says $0.30', () => {
    expect(errors(wf('## model m1\nusd: 0.10\n\n## model m2\nusd: 0.20\n', ', usd: 0.25'))).toEqual(["The blocks' budgets add up to $0.30, over the workflow's $0.25."]);
  });

  it("no workflow USD asks for it, once, at the first slice's line", () => {
    const text = wf('## model m1\nusd: 0.50\n\n## model m2\nusd: 0.25\n', '');
    const d = validate(ok(text)).filter((x) => x.severity === 'error');
    expect(d.map((x) => x.message)).toEqual(["Set the workflow's USD budget first: block budgets are carved out of it."]);
    expect(d[0]!.pos.line).toBe(ok(text).steps[0]!.pos!.line);
  });

  for (const bad of ['abc', '0', '-1', '1.234', '1e3']) {
    it(`usd: ${bad} is refused`, () => {
      expect(errors(wf(`## model m\nusd: ${bad}\n`))).toEqual(['Budget (USD) of `model-1` must be an amount above 0, like 0.50.']);
    });
  }

  it('usd: on a phase warns and is not counted in the sum', () => {
    const text = wf('## phase a\nusd: 5.00\n> Go.\n\n## model m\nusd: 1.00\n');
    expect(errors(text)).toEqual([]);
    expect(warnings(text)).toContain('`usd:` does nothing on a phase step');
  });

  it('a block file with a slice has no carve error', () => {
    const text = '---\nreins: 1\nblock: b\n---\n\n## model m\nusd: 0.50\n';
    expect(errors(text)).toEqual([]);
  });

  it('a model step with no id warns by case', () => {
    expect(warnings(wf('## model\n'))).toContain('`model-1` names no model and has no USD budget: it does nothing.');
    expect(warnings(wf('## model\nusd: 0.50\n'))).toContain('`model-1` names no model, so it only opens its USD budget.');
  });
});

describe('model step: compile', () => {
  it('compiles to one NODE op carrying the step', () => {
    const w = ok(wf('## model m\nusd: 0.50\n\n## phase a\n> Go.\n'));
    const prog = compileProgram(w);
    expect(prog.map((i) => i.op)).toEqual(['NODE', 'TURN', 'END']);
    expect(prog[0]).toMatchObject({ op: 'NODE', step: 'model-1', kind: 'model', src: w.steps[0] });
  });

  it('a model step inside use keeps the prefixed id in src', () => {
    const block = parseWorkflow('---\nreins: 1\nblock: b\n---\n\n## model m\n').workflow!;
    const w = ok(wf('## use b\n'));
    const prog = compileProgram(w, (n) => (n === 'b' ? block : undefined));
    expect(prog[0]).toMatchObject({ op: 'NODE', step: 'b/model-1', src: { id: 'b/model-1' } });
  });
});

describe('model step: exec', () => {
  const step = (attrs: Record<string, string>): Step => ({ id: 'model-1', kind: 'model', attrs, cards: [], links: [] });
  const exec = (s: Step, c: ExecCtx) => NODES.get('model')!.exec!(s, c);
  const stub = (out?: SwitchOutcome) => {
    const ctx = {
      slice: vi.fn(), log: vi.fn(), pause: vi.fn(), stop: vi.fn(async () => {}),
      ...(out ? { switchModel: vi.fn(async () => out) } : {}),
    };
    return ctx as typeof ctx & ExecCtx;
  };

  it('switched: logs how and label, opens the slice, moves on', async () => {
    const ctx = stub({ to: 'switched', label: 'L' });
    expect(await exec(step({ model: 'm', usd: '0.50' }), ctx)).toBe('next');
    expect(ctx.switchModel).toHaveBeenCalledWith('m', 'model-1');
    expect(ctx.log).toHaveBeenCalledWith('model_switched', { step: 'model-1', model: 'm', how: 'switched', label: 'L' });
    expect(ctx.slice).toHaveBeenCalledWith('model-1', 0.5);
  });

  it('stop: stops the run, opens no slice, stays', async () => {
    const ctx = stub({ to: 'stop' });
    expect(await exec(step({ model: 'm', usd: '0.50' }), ctx)).toBe('stay');
    expect(ctx.stop).toHaveBeenCalledTimes(1);
    expect(ctx.slice).not.toHaveBeenCalled();
    expect(ctx.log).not.toHaveBeenCalled();
  });

  it('closed: pauses with the words, stays', async () => {
    const ctx = stub({ to: 'closed' });
    expect(await exec(step({ model: 'm', usd: '0.50' }), ctx)).toBe('stay');
    expect(ctx.pause).toHaveBeenCalledWith('the switch question was closed before it was answered; Resume asks it again');
    expect(ctx.slice).not.toHaveBeenCalled();
  });

  it('a host with no switchModel logs unsupported, still opens the slice', async () => {
    const ctx = stub();
    expect(await exec(step({ model: 'm', usd: '0.50' }), ctx)).toBe('next');
    expect(ctx.log).toHaveBeenCalledWith('model_switched', { step: 'model-1', model: 'm', how: 'unsupported' });
    expect(ctx.slice).toHaveBeenCalledWith('model-1', 0.5);
  });

  it('no model id: no switch, no log, the slice opens; no usd closes it', async () => {
    const ctx = stub({ to: 'switched', label: 'L' });
    expect(await exec(step({ usd: '0.25' }), ctx)).toBe('next');
    expect(ctx.switchModel).not.toHaveBeenCalled();
    expect(ctx.log).not.toHaveBeenCalled();
    expect(ctx.slice).toHaveBeenCalledWith('model-1', 0.25);
    const ctx2 = stub();
    await exec(step({ model: 'm' }), ctx2);
    expect(ctx2.slice).toHaveBeenCalledWith('model-1', undefined);
  });
});
