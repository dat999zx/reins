import { describe, it, expect } from 'vitest';
import { FakeEngine, Run } from '../src/index.js';
import { finish, phase, step, workflow } from './wf3b.js';

const policy = () => ({ mode: 'write' as const, guards: [], allowShell: true });

async function borrowed() {
  const engine = new FakeEngine([{ text: 'REINS: done' }]);
  const session = await engine.open({ policy });
  let opens = 0;
  let closes = 0;
  const open = engine.open.bind(engine);
  engine.open = async (o) => { opens++; return open(o); };
  const close = session.close.bind(session);
  session.close = async () => { closes++; await close(); };
  return { engine, session, count: () => ({ opens, closes }) };
}

describe('a borrowed session (3b.1)', () => {
  it('is used for every turn, never opened, and close() leaves it open', async () => {
    const b = await borrowed();
    const run = new Run({ workflow: workflow([phase('a')]), engine: b.engine, session: b.session });
    expect(await finish(run)).toBe('done');
    expect(b.engine.receivedTexts).toHaveLength(1);
    await run.close();
    expect(b.count()).toEqual({ opens: 0, closes: 0 });
    expect(run.snapshot().sessionId).toBe(b.session.sessionId);
  });

  it('Run.restore forwards it', async () => {
    const b = await borrowed();
    const first = new Run({ workflow: workflow([step('g', 'gate', { cond: { t: 'approve' } }), phase('a')]), engine: b.engine, session: b.session });
    await first.step();
    await first.close();
    const run = Run.restore(first.snapshot(), { engine: b.engine, session: b.session });
    run.approve();
    expect(await finish(run)).toBe('done');
    expect(b.engine.receivedTexts).toHaveLength(1);
    expect(b.count()).toEqual({ opens: 0, closes: 0 });
  });

  it('still reaches the borrowed session after close()', async () => {
    const b = await borrowed();
    const run = new Run({ workflow: workflow([step('g', 'gate', { cond: { t: 'approve' } })]), engine: b.engine, session: b.session });
    await run.step();
    await run.close();
    await run.requestChanges('tweak');
    expect(b.engine.receivedTexts).toHaveLength(1);
    expect(b.count().opens).toBe(0);
  });

  it('policy() and takeCards() are public, and takeCards() drains', () => {
    const run = new Run({ workflow: workflow([phase('a')]), engine: new FakeEngine() });
    expect(run.policy()).toEqual({ mode: 'write', guards: [], allowShell: true });
    run.queueCard('one');
    run.queueCard('two');
    expect(run.takeCards()).toEqual(['one', 'two']);
    expect(run.takeCards()).toEqual([]);
  });
});
