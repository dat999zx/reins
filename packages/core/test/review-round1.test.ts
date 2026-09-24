// Review round 1: acceptance tests written by the reviewer. Every test states a behaviour the
// plan requires (section numbers cited) that the first implementation got wrong. Do not weaken them.
import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { Run } from '../src/run.js';
import { FakeEngine } from '../src/fake-engine.js';

const wf = (body: string) => {
  const r = parseWorkflow(`---\nreins: 1\nname: p\nbudget: { turns: 40, minutes: 60 }\n---\n\n${body}`);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};
async function drive(run: Run, max = 50) {
  for (let i = 0; i < max && run.status === 'running'; i++) await run.step();
  return run.status;
}

describe('review round 1: judges never pass by default (plan 7, 7.3)', () => {
  it('A: an llm-judged gate pauses when no judge is injected', async () => {
    const run = new Run({ workflow: wf('## gate\nuntil: llm says "plan is complete"\n\n## phase after\n> go'), engine: new FakeEngine() });
    expect(await drive(run)).toBe('paused');
  });

  it('A2: an llm-judged gate passes only when the injected judge says yes', async () => {
    const asked: string[] = [];
    const run = new Run({
      workflow: wf('## gate\nuntil: llm says "plan is complete"\n\n## phase after\n> go'),
      engine: new FakeEngine(),
      judge: async (c) => { asked.push(c.t); return true; },
    });
    expect(await drive(run)).toBe('done');
    expect(asked).toEqual(['llm']);
  });

  it('B: agent says done is false before the agent has said REINS: done', async () => {
    const run = new Run({ workflow: wf('## gate\nuntil: agent says done\n\n## phase after\n> go'), engine: new FakeEngine() });
    expect(await drive(run)).toBe('paused');
  });
});

describe('review round 1: cards are delivered exactly once (plan 6.5)', () => {
  it('C: a card queued after the last tool event reaches the next turn text', async () => {
    const eng = new FakeEngine([{ text: 'REINS: done' }, { text: 'REINS: done' }]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second'), engine: eng });
    await run.step();
    run.queueCard('PINEAPPLE');
    await drive(run);
    expect(eng.receivedTexts[1]).toContain('PINEAPPLE');
    expect(eng.receivedTexts.filter((t) => t.includes('PINEAPPLE')).length).toBe(1);
  });

  it('D: a card queued before a turn is sent once, not in the text AND again mid-turn', async () => {
    const eng = new FakeEngine([{ events: [{ type: 'tool_call', tool: 'Read', input: { path: 'a' } }], text: 'REINS: done' }]);
    const run = new Run({ workflow: wf('## phase one\n> first'), engine: eng });
    run.queueCard('PINEAPPLE');
    await drive(run);
    const inText = eng.receivedTexts.filter((t) => t.includes('PINEAPPLE')).length;
    const midTurn = run.getEvents().filter((e) => e.type === 'card_delivered' && e.data.channel === 'mid-turn').length;
    // It went out in the turn text, so it must not ALSO be pushed mid-turn.
    expect(inText).toBe(1);
    expect(midTurn).toBe(0);
  });
});

describe('review round 1: budgets', () => {
  it('E: allowMore on a used-up link budget lets the run jump back again', async () => {
    const eng = new FakeEngine(Array.from({ length: 10 }, () => ({ text: 'REINS: fail: missing' })));
    const run = new Run({ workflow: wf('## phase plan\n> p\n\n## phase implement\n> i\n\n## verify\nagainst: plan\non-fail: implement (max 1)\n\n## phase after\n> a'), engine: eng });
    expect(await drive(run)).toBe('paused');
    const before = eng.receivedTexts.length;
    run.allowMore(1);
    await drive(run, 20);
    expect(eng.receivedTexts.length).toBeGreaterThan(before);
  });
});

describe('review round 1: Knowl and I/O go through injected functions (plan 4, 10)', () => {
  it('F: recall never invents context; without an injected recall nothing is added', async () => {
    const eng = new FakeEngine();
    const run = new Run({ workflow: wf('## recall\nknowl: upload\n\n## phase one\n> first'), engine: eng });
    await drive(run);
    expect(eng.receivedTexts[0]).not.toContain('Context from Knowl');
  });

  it('F2: injected recall results go into the NEXT turn only, not every turn after', async () => {
    const eng = new FakeEngine();
    const topicsSeen: string[][] = [];
    const run = new Run({
      workflow: wf('## recall\nknowl: upload, retry\n\n## phase one\n> first\n\n## phase two\n> second'),
      engine: eng,
      recall: async (topics) => { topicsSeen.push(topics); return ['Uploads use S3 multipart.']; },
    });
    await drive(run);
    expect(topicsSeen).toEqual([['upload', 'retry']]);
    expect(eng.receivedTexts[0]).toContain('Uploads use S3 multipart.');
    expect(eng.receivedTexts[1]).not.toContain('Uploads use S3 multipart.');
  });

  it('K: store asks the agent for a decision summary and passes it to the injected store', async () => {
    const eng = new FakeEngine([{ text: 'REINS: done' }, { text: 'Decided: max 5 retries.\nREINS: done' }]);
    const stored: Array<[string, string]> = [];
    const run = new Run({
      workflow: wf('## phase one\n> first\n\n## store\nknowl: decisions'),
      engine: eng,
      store: async (what, summary) => { stored.push([what, summary]); },
    });
    await drive(run);
    expect(eng.receivedTexts.length).toBe(2);
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toBe('decisions');
    expect(stored[0]![1]).toContain('max 5 retries');
  });

  it('G: whenever diff > N fires using the injected diffLines', async () => {
    const eng = new FakeEngine([{ text: 'REINS: done' }, { text: 'REINS: done' }]);
    const run = new Run({
      workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever diff > 100 lines\nnudge: split'),
      engine: eng,
      diffLines: async () => 250,
    });
    await drive(run);
    expect(eng.receivedTexts[1]).toContain('split');
  });

  it('G2: whenever touches <glob> fires from this run\'s tool events', async () => {
    const eng = new FakeEngine([
      { events: [{ type: 'tool_call', tool: 'Edit', input: { file_path: 'src/core/a.ts' } }], text: 'REINS: done' },
      { text: 'REINS: done' },
    ]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever touches src/core/**\ncheckpoint: core touched'), engine: eng });
    await drive(run);
    expect(eng.receivedTexts[1]).toContain('core touched');
  });
});

describe('review round 1: conditions judge what they name (plan 5.4, 7)', () => {
  it('H: until `a` passes and `b` passes runs BOTH commands', async () => {
    const ran: string[] = [];
    const run = new Run({
      workflow: wf('## repeat\nuntil: `npm test` passes and `npm run typecheck` passes\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> f'),
      engine: new FakeEngine(),
      commandRunner: async (c) => { ran.push(c); return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    await drive(run);
    expect(ran).toContain('npm run typecheck');
  });

  it('H2: until `b` passes is judged by `b`, not by whatever command ran last', async () => {
    const run = new Run({
      workflow: wf('## repeat\nuntil: `npm run typecheck` passes\nmax: 2\n\n### run `npm test`\n\n### phase fix\n> f'),
      engine: new FakeEngine(),
      commandRunner: async (c) => ({ exitCode: c === 'npm run typecheck' ? 1 : 0, stdout: '', stderr: 'err' }),
    });
    expect(await drive(run)).toBe('paused');
    expect(run.pauseReason?.type).toBe('budget-used');
  });
});

describe('review round 1: engine contract (plan 8.1)', () => {
  it('I: events a real engine returns from turn() reach the run log', async () => {
    const engine: any = {
      id: 'claude', probe: async () => ({}),
      open: async () => ({
        sessionId: 's', interrupt: async () => {}, close: async () => {}, events: (async function* () {})(),
        turn: async () => ({ text: 'REINS: done', events: [{ type: 'refusal', reason: 'guarded' }] }),
      }),
    };
    const run = new Run({ workflow: wf('## phase one\n> first'), engine });
    await drive(run);
    expect(run.getEvents().some((e) => e.type === 'refusal')).toBe(true);
  });

  it('J: handoff sends the agent a turn asking for a summary (plan 6.2)', async () => {
    const eng = new FakeEngine();
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## handoff\nto: fresh session\nfocus: what broke'), engine: eng });
    await drive(run);
    expect(eng.receivedTexts.length).toBe(2);
    expect(eng.receivedTexts[1]!.toLowerCase()).toContain('summar');
    expect(eng.receivedTexts[1]).toContain('what broke');
  });
});

describe('review round 2: no judge means no in repeat and if too (plan 7.3)', () => {
  it('L: repeat until llm says, no judge -> must NOT exit the loop as passed', async () => {
    const eng = new FakeEngine();
    const run = new Run({ workflow: wf('## repeat\nuntil: llm says "done well"\nmax: 3\n\n### phase work\n> w\n\n## phase after\n> a'), engine: eng });
    const s = await drive(run);
    expect(s).toBe('paused');
    expect(eng.receivedTexts.some((t) => t.includes('step') && t.includes('after'))).toBe(false);
  });

  it('M: if llm says, no judge -> takes the else branch', async () => {
    const eng = new FakeEngine();
    const run = new Run({ workflow: wf('## if llm says "big change"\n\n### phase yes\n> Y-BRANCH\n\n### else\n\n### phase no\n> N-BRANCH'), engine: eng });
    await drive(run);
    const all = eng.receivedTexts.join('\n');
    expect(all).not.toContain('Y-BRANCH');
    expect(all).toContain('N-BRANCH');
  });

  it('N: a passing earlier test run does NOT let a later tests gate skip re-running', async () => {
    let n = 0;
    const run = new Run({
      workflow: wf('## run `npm test`\n\n## phase break\n> b\n\n## gate\nuntil: tests pass\n\n## phase after\n> a'),
      engine: new FakeEngine(),
      commandRunner: async () => { n++; return { exitCode: n === 1 ? 0 : 1, stdout: '', stderr: 'boom' }; },
    });
    expect(await drive(run)).toBe('paused');
    expect(n).toBe(2);
  });
});

describe('review round 2: auto cards and the status line', () => {
  it('O: whenever agent says done fires only after a turn that really ended with REINS: done', async () => {
    const eng = new FakeEngine([{ text: 'still working\nREINS: blocked: need input' }]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever agent says done\ncheckpoint: DONE-SEEN'), engine: eng });
    await drive(run);
    expect(run.pauseReason?.type).toBe('agent-blocked');
    expect(run.getEvents().some((e) => e.type === 'card_queued' && String(e.data.card).includes('DONE-SEEN'))).toBe(false);
  });

  it('O2: ...and does fire after a real REINS: done', async () => {
    const eng = new FakeEngine([{ text: 'ok\nREINS: done' }, { text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever agent says done\ncheckpoint: DONE-SEEN'), engine: eng });
    await drive(run);
    expect(eng.receivedTexts[1]).toContain('DONE-SEEN');
  });
});
