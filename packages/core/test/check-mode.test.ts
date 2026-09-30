import { describe, it, expect } from 'vitest';
import { parseWorkflow, validate } from '../src/index.js';

const wf = (kind: string, mode?: string) => [
  '---', 'reins: 1', 'name: t', 'budget: { turns: 5, minutes: 5 }', 'always: []', '---', '',
  `## ${kind}`, ...(mode ? [`mode: ${mode}`] : []), '> hello', '',
].join('\n');

const errors = (text: string) => {
  const p = parseWorkflow(text);
  return [...p.diagnostics, ...(p.workflow ? validate(p.workflow) : [])].filter((d) => d.severity === 'error');
};

describe('checkMode (3b.5)', () => {
  it('phase: mode readonly is an error, not a silent write', () => {
    expect(errors(wf('phase go', 'readonly')).map((d) => d.message)).toEqual([expect.stringMatching(/mode/)]);
  });
  it('say: mode readonly is an error too', () => {
    expect(errors(wf('say', 'readonly')).map((d) => d.message)).toEqual([expect.stringMatching(/mode/)]);
  });
  it('read-only and write are fine, and no mode is fine', () => {
    expect(errors(wf('phase go', 'read-only'))).toEqual([]);
    expect(errors(wf('phase go', 'write'))).toEqual([]);
    expect(errors(wf('phase go'))).toEqual([]);
  });
});
