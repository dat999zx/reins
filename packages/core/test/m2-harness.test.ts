import { describe, it, expect } from 'vitest';
import { m2harness } from './m2-harness.js';

const opts = { policy: () => ({}) as any };
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
const pending = Symbol('pending');
const peek = <T>(p: Promise<T>) => Promise.race([p, new Promise<typeof pending>((r) => setTimeout(() => r(pending), 20))]);

describe('m2 harness', () => {
  it('the engine id is the neutral open string test', () => {
    expect(m2harness('E').engine.id).toBe('test');
  });

  it('session ids follow the scenario, a resumed id is kept, and every subagent open is recorded as given', async () => {
    const h = m2harness('S');
    const a = await h.engine.open(opts);
    const b = await h.engine.open(opts);
    const sub = await h.openSubagent({ step: 's3', title: 't', maxUsd: 0.5, policy: opts.policy });
    const back = await h.openSubagent({ step: 's4', title: 't', sessionId: 'old', model: 'm', policy: opts.policy });
    expect([a.sessionId, b.sessionId, sub.session.sessionId, back.session.sessionId]).toEqual(['S-main-1', 'S-main-2', 'S-sub-s3', 'old']);
    expect(back.model).toBe('m');
    expect(h.opened).toEqual(['S-main-1', 'S-main-2', 'S-sub-s3', 'old']);
    expect(h.subagentOpens.map((o) => [o.step, o.maxUsd])).toEqual([['s3', 0.5], ['s4', undefined]]);
  });

  it('two sessions answer from their own scripts, in either order', async () => {
    const run = async (first: 'main' | 'sub') => {
      const h = m2harness('O');
      h.script('O-main-1', { text: 'main one' }, { text: 'main two' });
      h.script('O-sub-x', { text: 'sub one' });
      const main = await h.engine.open(opts);
      const sub = (await h.openSubagent({ step: 'x', title: 't', policy: opts.policy })).session;
      const got: Record<string, string[]> = { main: [], sub: [] };
      const ask = async (k: 'main' | 'sub') => { got[k]!.push((await (k === 'main' ? main : sub).turn('q')).text); };
      if (first === 'sub') await ask('sub');
      await ask('main');
      if (first === 'main') await ask('sub');
      await ask('main');
      return got;
    };
    const want = { main: ['main one', 'main two'], sub: ['sub one'] };
    expect(await run('main')).toEqual(want);
    expect(await run('sub')).toEqual(want);
  });

  it('a session past its script answers like FakeEngine', async () => {
    const h = m2harness('D');
    const s = await h.engine.open(opts);
    expect((await s.turn('q')).text).toBe('REINS: done');
  });

  it('a hold on one session leaves the other free, and release lets the held turn go on to its script', async () => {
    const h = m2harness('H');
    h.script('H-main-1', { text: 'held reply', total: 2 });
    h.script('H-sub-x', { text: 'free reply' });
    const main = await h.engine.open(opts);
    const sub = (await h.openSubagent({ step: 'x', title: 't', policy: opts.policy })).session;
    const hold = h.hold('H-main-1');
    expect(await within(sub.turn('b'), 500)).toMatchObject({ text: 'free reply' });   // asked first: it must not take main's hold
    const held = main.turn('a');
    await hold.started;
    expect(await peek(held)).toBe(pending);
    hold.release();
    expect(await within(held, 500)).toMatchObject({ text: 'held reply', total: 2 });
  });

  it('a hold is used once: the next turn of that session is not held', async () => {
    const h = m2harness('U');
    const s = await h.engine.open(opts);
    const hold = h.hold('U-main-1');
    const first = s.turn('a');
    await hold.started;
    hold.release();
    await first;
    expect(await within(s.turn('b'), 500)).toMatchObject({ text: 'REINS: done' });
  });

  it('fail() rejects the held turn with the given error', async () => {
    const h = m2harness('F');
    const s = await h.engine.open(opts);
    const hold = h.hold('F-main-1');
    const held = s.turn('a');
    await hold.started;
    hold.fail(new Error('boom'));
    await expect(held).rejects.toThrow('boom');
  });

  it('interrupt() ends a held turn with empty text and no total, and the script is not used up', async () => {
    const h = m2harness('I');
    h.script('I-main-1', { text: 'real', total: 5 });
    const s = await h.engine.open(opts);
    const hold = h.hold('I-main-1');
    const held = s.turn('a');
    await hold.started;
    await s.interrupt();
    const r = await within(held, 500);
    expect(r).toEqual({ text: '' });
    expect(r).not.toHaveProperty('total');
    expect(await s.turn('b')).toMatchObject({ text: 'real', total: 5 });
  });

  it('interrupt() on another session does not end this held turn', async () => {
    const h = m2harness('J');
    const a = await h.engine.open(opts);
    const b = await h.engine.open(opts);
    const hold = h.hold('J-main-1');
    const held = a.turn('a');
    await hold.started;
    await b.interrupt();
    expect(await peek(held)).toBe(pending);
    hold.release();
    await held;
  });

  it('with pendingApproval, interrupt() ends a held turn with empty text and the total so far', async () => {
    const h = m2harness('P', { pendingApproval: true });
    h.script('P-main-1', { text: 'one', total: 3 });
    const s = await h.engine.open(opts);
    expect((await s.turn('a')).total).toBe(3);
    const hold = h.hold('P-main-1');
    const held = s.turn('b');
    await hold.started;
    await s.interrupt();
    expect(await within(held, 500)).toEqual({ text: '', total: 3 });
  });

  it('close() rejects a held turn with Error closed', async () => {
    const h = m2harness('C');
    const s = await h.engine.open(opts);
    const hold = h.hold('C-main-1');
    const held = s.turn('a');
    await hold.started;
    await s.close();
    const err = await within(held.catch((e: unknown) => e), 500);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('closed');
  });

  it('counts opens, closes, interrupts and texts per session', async () => {
    const h = m2harness('N');
    const a = await h.engine.open(opts);
    const b = await h.engine.open(opts);
    const again = await h.engine.open({ ...opts, sessionId: 'N-main-1' });
    await a.turn('one');
    await a.turn('two');
    await b.turn('three');
    await a.interrupt();
    await a.interrupt();
    await b.interrupt();
    await again.close();
    await b.close();
    expect(h.stats('N-main-1')).toEqual({ opened: 2, closed: 1, interrupts: 2, texts: ['one', 'two'] });
    expect(h.stats('N-main-2')).toEqual({ opened: 1, closed: 1, interrupts: 1, texts: ['three'] });
    expect(h.stats('never')).toEqual({ opened: 0, closed: 0, interrupts: 0, texts: [] });
  });

  it('close() and interrupt() with no held turn only count', async () => {
    const h = m2harness('K');
    h.script('K-main-1', { text: 'x' });
    const s = await h.engine.open(opts);
    await s.interrupt();
    await s.close();
    expect(await s.turn('a')).toMatchObject({ text: 'x' });
  });
});
