import { describe, it, expect } from 'vitest';
import { FakeEngine, Run } from '../src/index.js';
import { countInterrupts, phase, workflow } from './wf3b.js';

const tool = { type: 'tool_call' as const, tool: 'Read', input: { file_path: 'a.txt' } };
const delivered = (run: Run) => run.getEvents().filter((e) => e.type === 'card_delivered');

describe('queueCard never loses a card (3b.1)', () => {
  it('spec test: stop then now in one tool call — paused on stop, n delivered exactly once mid-turn', async () => {
    const engine = new FakeEngine([{ events: [tool], text: 'x' }]);
    const interrupts = countInterrupts(engine);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { run.queueCard('s', 'stop'); run.queueCard('n', 'now'); };
    await run.step();
    expect(interrupts.count).toBe(1);
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('stop');
    expect(delivered(run).filter((e) => e.data.card === 'n')).toEqual([expect.objectContaining({ data: expect.objectContaining({ card: 'n', channel: 'mid-turn' }) })]);
  });

  it('now then stop: the now card is kept and delivered mid-turn, the run pauses on the stop', async () => {
    const engine = new FakeEngine([{ events: [tool], text: 'x' }]);
    const interrupts = countInterrupts(engine);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { run.queueCard('a', 'now'); run.queueCard('b', 'stop'); };
    await run.step();
    expect(interrupts.count).toBe(1);
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'b' });
    expect(delivered(run).map((e) => [e.data.card, e.data.channel])).toEqual([['a', 'mid-turn'], ['b', 'interrupt']]);
  });

  it('two now cards: the second is delivered mid-turn, the first interrupts and is resent', async () => {
    const engine = new FakeEngine([{ events: [tool], text: 'x' }, { text: 'REINS: done' }]);
    const interrupts = countInterrupts(engine);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { run.queueCard('first', 'now'); run.queueCard('second', 'now'); };
    await run.step();
    expect(interrupts.count).toBe(1);
    expect(delivered(run).map((e) => [e.data.card, e.data.channel])).toEqual([['second', 'mid-turn'], ['first', 'interrupt']]);
    expect(engine.receivedTexts[1]).toContain('first');
  });

  it('a second stop while one is pending is logged and ignored', async () => {
    const engine = new FakeEngine([{ events: [tool], text: 'x' }]);
    const interrupts = countInterrupts(engine);
    const run = new Run({ workflow: workflow([phase('a')]), engine });
    engine.onToolCall = () => { run.queueCard('one', 'stop'); run.queueCard('two', 'stop'); };
    await run.step();
    expect(interrupts.count).toBe(1);
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'one' });
    expect(run.getEvents().filter((e) => e.type === 'card_queued' && e.data.kind === 'stop')).toHaveLength(2);
  });
});
