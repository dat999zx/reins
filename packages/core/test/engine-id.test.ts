// Engine ids are open strings: a run does not care what the engine is called.
import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { Run } from '../src/run.js';
import { FakeEngine, type Engine } from '../src/fake-engine.js';

describe('engine ids', () => {
  it('an engine with an id the core never heard of runs a one-step workflow to done', async () => {
    const r = parseWorkflow('---\nreins: 1\nname: p\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n## phase one\n> first\n');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const inner = new FakeEngine([{ text: 'did it\nREINS: done' }]);
    // The type is the check: before this task `id` was 'claude' | 'codex', so this object did not compile.
    const acme: Engine = { id: 'acme', probe: () => inner.probe(), open: (o) => inner.open(o) };
    expect(acme.id).toBe('acme');
    const run = new Run({ workflow: r.workflow!, engine: acme });
    for (let i = 0; i < 50 && run.status === 'running'; i++) await run.step();
    expect(run.status).toBe('done');
    expect(inner.receivedTexts).toHaveLength(1);
  });

  it('the fake engine says it is the fake one', () => {
    expect(new FakeEngine([]).id).toBe('fake');
  });
});
