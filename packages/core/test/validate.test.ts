import { describe, it, expect } from 'vitest';
import { validate } from '../src/validate.js';
import { parseWorkflow } from '../src/format/parse.js';
import type { Workflow } from '../src/model.js';

describe('Task 1.5: The Validator', () => {
  const baseWorkflow = (): Workflow => ({
    version: 1,
    name: 'test-wf',
    budget: { turns: 10, minutes: 10 },
    always: [],
    steps: [],
    autos: [],
  });

  it('Rule 1: reports unknown kind or attribute key', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'step1',
      kind: 'unknown-kind' as any,
      attrs: { foo: 'bar' },
      cards: [],
      links: [],
      pos: { line: 10, col: 1 },
    });
    const diags = validate(wf);
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('unknown') && e.pos.line === 10)).toBe(true);
  });

  it('Rule 2: reports duplicate step id', () => {
    const wf = baseWorkflow();
    wf.steps.push(
      {
        id: 'dup',
        kind: 'phase',
        title: 'one',
        prompt: 'First',
        attrs: {},
        cards: [],
        links: [],
        pos: { line: 5, col: 1 },
      },
      {
        id: 'dup',
        kind: 'phase',
        title: 'two',
        prompt: 'Second',
        attrs: {},
        cards: [],
        links: [],
        pos: { line: 12, col: 1 },
      }
    );
    const diags = validate(wf);
    const err = diags.find((d) => d.message.includes('Duplicate id "dup"'));
    expect(err).toBeDefined();
    expect(err?.pos.line).toBe(12);
  });

  it('Rule 3: reports link or verify against non-existent id', () => {
    const wf = baseWorkflow();
    wf.steps.push(
      {
        id: 'step1',
        kind: 'verify',
        attrs: { against: 'non-existent' },
        cards: [],
        links: [{ kind: 'on-fail', to: 'missing-id', pos: { line: 7, col: 10 } }],
        pos: { line: 6, col: 1 },
      }
    );
    const diags = validate(wf);
    expect(diags.some((d) => d.message.includes('non-existent'))).toBe(true);
    expect(diags.some((d) => d.message.includes('missing-id'))).toBe(true);
  });

  it('Rule 4: repeat without max is an error', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'loop1',
      kind: 'repeat',
      cond: { t: 'tests' },
      attrs: {}, // missing max
      cards: [],
      links: [],
      pos: { line: 8, col: 1 },
    });
    const diags = validate(wf);
    const err = diags.find((d) => d.message.includes('repeat') && d.message.includes('max'));
    expect(err).toBeDefined();
    expect(err?.pos.line).toBe(8);
  });

  it('Rule 4: backward link without max is an error, and forward link without max is fine', () => {
    const wf = baseWorkflow();
    wf.steps.push(
      {
        id: 'step-a',
        kind: 'phase',
        title: 'a',
        prompt: 'Step A',
        attrs: {},
        cards: [],
        links: [
          // Forward link to step-b without max: should be fine
          { kind: 'next', to: 'step-b', pos: { line: 6, col: 1 } },
        ],
        pos: { line: 5, col: 1 },
      },
      {
        id: 'step-b',
        kind: 'phase',
        title: 'b',
        prompt: 'Step B',
        attrs: {},
        cards: [],
        links: [
          // Backward link to step-a without max: MUST be error
          { kind: 'on-fail', to: 'step-a', pos: { line: 12, col: 1 } },
        ],
        pos: { line: 10, col: 1 },
      }
    );

    const diags = validate(wf);
    const backwardErr = diags.find(
      (d) => d.message.includes('Backward link') && d.message.includes('step-a')
    );
    expect(backwardErr).toBeDefined();
    expect(backwardErr?.pos.line).toBe(12);

    // Ensure no error for forward link to step-b
    const forwardErr = diags.find((d) => d.message.includes('step-b'));
    expect(forwardErr).toBeUndefined();
  });

  it('Rule 5: gate without until is an error', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'gate1',
      kind: 'gate',
      attrs: {},
      cards: [],
      links: [],
      pos: { line: 9, col: 1 },
    });
    const diags = validate(wf);
    const err = diags.find((d) => d.message.includes('gate') && d.message.includes('until'));
    expect(err).toBeDefined();
    expect(err?.pos.line).toBe(9);
  });

  it('Rule 6: else outside an if is an error', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'else1',
      kind: 'else' as any,
      attrs: {},
      cards: [],
      links: [],
      pos: { line: 15, col: 1 },
    });
    const diags = validate(wf);
    const err = diags.find((d) => d.message.includes('else') && d.message.includes('outside'));
    expect(err).toBeDefined();
  });

  it('Rule 7: use naming a block that cannot be found', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'use1',
      kind: 'use',
      title: 'missing-block',
      attrs: {},
      cards: [],
      links: [],
      pos: { line: 20, col: 1 },
    });
    const diags = validate(wf, (_name) => undefined);
    const err = diags.find((d) => d.message.includes('missing-block'));
    expect(err).toBeDefined();
    expect(err?.pos.line).toBe(20);
  });

  it('Rule 8: glob that will not compile', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'step1',
      kind: 'phase',
      title: 'plan',
      prompt: 'Plan',
      attrs: {},
      cards: [{ kind: 'guard', text: 'invalid[glob', pos: { line: 14, col: 8 } }],
      links: [],
      pos: { line: 13, col: 1 },
    });
    const diags = validate(wf);
    const err = diags.find((d) => d.message.includes('glob'));
    expect(err).toBeDefined();
  });

  it('Rule 9: missing budget in frontmatter is an error', () => {
    const wf = baseWorkflow();
    wf.budget = { turns: 0, minutes: 0 };
    const diags = validate(wf);
    const err = diags.find((d) => d.message.includes('budget'));
    expect(err).toBeDefined();
    expect(err?.pos.line).toBe(1);
  });

  it('Rule 10: condition that will not parse names the column', () => {
    const text = `---
reins: 1
name: cond-err
budget: { turns: 10, minutes: 10 }
always: []
---

## gate
until: diff > x lines
`;
    const { workflow, diagnostics } = parseWorkflow(text);
    const allDiags = [...diagnostics, ...(workflow ? validate(workflow) : [])];
    const err = allDiags.find((d) => d.message.includes('diff >'));
    expect(err).toBeDefined();
    expect(err?.pos.col).toBe(8);
  });

  it('Warning 1: llm says / reviewer approves cost extra model calls', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'gate1',
      kind: 'gate',
      cond: { t: 'llm', q: 'is it good?' },
      attrs: {},
      cards: [],
      links: [],
      pos: { line: 11, col: 1 },
    });
    const diags = validate(wf);
    const warn = diags.find((d) => d.severity === 'warning' && d.message.includes('model call'));
    expect(warn).toBeDefined();
  });

  it('Warning 2: tests pass without test in frontmatter warns about npm test fallback', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'gate1',
      kind: 'gate',
      cond: { t: 'tests' },
      attrs: {},
      cards: [],
      links: [],
      pos: { line: 11, col: 1 },
    });
    const diags = validate(wf);
    const warn = diags.find(
      (d) => d.severity === 'warning' && d.message.includes('npm test')
    );
    expect(warn).toBeDefined();
  });

  it('Warning 3: phase step with no prompt warns', () => {
    const wf = baseWorkflow();
    wf.steps.push({
      id: 'phase1',
      kind: 'phase',
      title: 'empty',
      attrs: {},
      cards: [],
      links: [],
      pos: { line: 15, col: 1 },
    });
    const diags = validate(wf);
    const warn = diags.find((d) => d.severity === 'warning' && d.message.includes('no prompt'));
    expect(warn).toBeDefined();
  });
});
