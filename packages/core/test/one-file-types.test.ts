import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NODES, CONDS, CARDS, parseWorkflow, printWorkflow, validate, compileProgram, Run, FakeEngine } from '../src/index.js';
import type { NodeType, CondType, CardType } from '../src/index.js';
import { turnInstr } from '../src/nodes/turn.js';

declare module '../src/model.js' {
  interface NodeKinds { echo: true }
  interface CondAtoms { coin: { t: 'coin' } }
  interface CardKinds { shout: true }
}

const echo: NodeType = { kind: 'echo', attrs: [], compile(step, ctx) { ctx.push(turnInstr(step)); } };
const coin: CondType<{ t: 'coin' }> = {
  t: 'coin',
  parse(s) { if (!s.src.startsWith('coin lands heads', s.idx)) return null; s.idx += 'coin lands heads'.length; return { t: 'coin' }; },
  print() { return 'coin lands heads'; },
  judge: 'deterministic',
  evalSync() { return true; },
};
const shout: CardType = { kind: 'shout', turnLine(card) { return `SHOUT: ${card.text.toUpperCase()}`; } };

const TEXT = '---\nreins: 1\nname: onefile\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## echo\nshout: hello\n> say hi\n\n## gate\nuntil: coin lands heads\n\n## whenever coin lands heads\nshout: loud\n';

describe('a new type is one file', () => {
  beforeEach(() => { NODES.set('echo', echo); CONDS.set('coin', coin); CARDS.set('shout', shout); });
  afterEach(() => { NODES.delete('echo'); CONDS.delete('coin'); CARDS.delete('shout'); });

  it('parses, prints, validates, compiles and runs with no src edit', async () => {
    const p = parseWorkflow(TEXT);
    expect(p.diagnostics).toEqual([]);
    expect(validate(p.workflow!)).toEqual([]);
    expect(printWorkflow(p.workflow!)).toBe(TEXT);
    expect(compileProgram(p.workflow!).map((i) => i.op)).toEqual(['TURN', 'GATE', 'END']);
    const engine = new FakeEngine([{ text: 'hi\nREINS: done' }]);
    const run = new Run({ workflow: p.workflow!, engine });
    for (let i = 0; i < 10 && run.status === 'running'; i++) await run.step();
    expect(engine.receivedTexts[0]).toContain('SHOUT: HELLO');
    expect(run.status).toBe('done');
    // The new atom judged by an auto card (sync pass), delivered as the new card's default: steer.
    expect(run.getEvents().filter((e) => e.type === 'card_queued').map((e) => e.data)).toEqual([{ card: 'loud', kind: 'steer', source: 'auto' }]);
  });

  it('each registry is what makes it work', () => {
    NODES.delete('echo');
    expect(parseWorkflow(TEXT).diagnostics.map((d) => d.message)).toContain('Unknown step kind "echo"');
    NODES.set('echo', echo); CONDS.delete('coin');
    expect(parseWorkflow(TEXT).diagnostics.some((d) => d.message.startsWith('Unexpected condition token'))).toBe(true);
    CONDS.set('coin', coin); CARDS.delete('shout');
    expect(parseWorkflow(TEXT).diagnostics.map((d) => d.message)).toContain('Unknown attribute "shout"');
  });
});
