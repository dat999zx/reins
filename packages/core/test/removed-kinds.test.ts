import { describe, it, expect } from 'vitest';
import { parseWorkflow, printWorkflow, validate, compileProgram, compileTurn } from '../src/index.js';

const FM = '---\nreins: 1\nname: t\nbudget: { turns: 20, minutes: 20 }\n---\n\n';

describe('what a file with a removed block, card, link or front-matter key does', () => {
  it('a `## handoff` heading is an unknown step kind; its lines are unknown attributes; nothing crashes', () => {
    const p = parseWorkflow(FM + '## phase a\n> a\n\n## handoff\nto: fresh session\n');
    expect(p.diagnostics.map((d) => `${d.severity}: ${d.message}`)).toEqual([
      'error: Unknown step kind "handoff"',
      'error: Unknown attribute "to"',
    ]);
    expect(() => { validate(p.workflow!); compileProgram(p.workflow!); }).not.toThrow();
  });

  it('a `nudge:` line on a step is an unknown attribute and no card', () => {
    const p = parseWorkflow(FM + '## phase a\nnudge: slow down\n> a\n');
    expect(p.diagnostics.map((d) => `${d.severity}: ${d.message}`)).toEqual(['error: Unknown attribute "nudge"']);
    expect(p.workflow!.steps[0]!.cards).toEqual([]);
  });

  it('a `nudge:` or `note:` line in a whenever block is an unknown attribute and the block holds no card', () => {
    for (const kind of ['nudge', 'note']) {
      const p = parseWorkflow(FM + `## phase a\n> a\n\n## whenever drift\n${kind}: look\n`);
      expect(p.diagnostics.map((d) => `${d.severity}: ${d.message}`)).toEqual([`error: Unknown attribute "${kind}"`]);
      expect(p.workflow!.autos).toEqual([]);
    }
  });

  it('a whenever block with no card line adds no auto card', () => {
    const p = parseWorkflow(FM + '## phase a\n> a\n\n## whenever drift\n');
    expect(p.diagnostics).toEqual([]);
    expect(p.workflow!.autos).toEqual([]);
  });

  it('a whenever block holds now: or stop:, and prints them back', () => {
    const text = FM + '## phase a\n> a\n\n## whenever drift\nnow: look\n\n## whenever attempts > 3\nstop: enough\n';
    const p = parseWorkflow(text);
    expect(p.diagnostics).toEqual([]);
    expect(p.workflow!.autos.map((a) => a.card)).toMatchObject([{ kind: 'now', text: 'look' }, { kind: 'stop', text: 'enough' }]);
    const printed = printWorkflow(p.workflow!);
    expect(printed).toContain('## whenever drift\nnow: look\n\n## whenever attempts > 3\nstop: enough\n');
    expect(printWorkflow(parseWorkflow(printed).workflow!)).toBe(printed);
  });

  it('an `on-pass:` line is an unknown attribute and no link', () => {
    const p = parseWorkflow(FM + '## phase a\non-pass: b\n> a\n\n## phase b\n> b\n');
    expect(p.diagnostics.map((d) => `${d.severity}: ${d.message}`)).toEqual(['error: Unknown attribute "on-pass"']);
    expect(p.workflow!.steps[0]!.links).toEqual([]);
  });

  it('front matter with `model:` and `engine:` still opens, with no diagnostic; they are not kept', () => {
    const text = '---\nreins: 1\nname: t\nmodel: claude-opus-5-5\nengine: claude\nbudget: { turns: 20, minutes: 20 }\n---\n\n## phase a\n> a\n';
    const p = parseWorkflow(text);
    expect(p.diagnostics).toEqual([]);
    expect(p.workflow).not.toHaveProperty('model');
    expect(p.workflow).not.toHaveProperty('engine');
    expect(printWorkflow(p.workflow!)).not.toMatch(/^(model|engine):/m);
  });

  it('texts the run hands a turn are listed after the step cards as they are, with no kind prefix', () => {
    const step = { id: 'a', kind: 'phase' as const, prompt: 'Go.', attrs: {}, cards: [{ kind: 'guard' as const, text: 'src/**' }], links: [] };
    const turn = compileTurn(step, { workflowName: 't', totalSteps: 1, extras: ['split it'] });
    expect(turn).toContain('For this step:\n- Do not touch src/**. (Enforced: edits there are blocked.)\n- split it\n');
  });
});
