import { describe, it, expect } from 'vitest';
import { harness } from './m1-harness.js';

const opts = { policy: () => ({}) as any };

describe('m1 harness', () => {
  it('session ids depend on the scenario and the open count only, in either order', async () => {
    const ids = async (name: string) => {
      const h = harness(name);
      const a = await h.engine.open(opts);
      const b = await h.engine.open(opts);
      const sub = await h.openSubagent({ step: 's3', title: 't', policy: opts.policy });
      return [a.sessionId, b.sessionId, sub.session.sessionId];
    };
    const ab = [await ids('A'), await ids('B')];
    const ba = [await ids('B'), await ids('A')];
    expect(ab[0]).toEqual(['A-main-1', 'A-main-2', 'A-sub-s3']);
    expect(ab[1]).toEqual(['B-main-1', 'B-main-2', 'B-sub-s3']);
    expect(ba).toEqual([ab[1], ab[0]]);
  });

  it('a resumed session keeps its id', async () => {
    const h = harness('R');
    expect((await h.engine.open({ ...opts, sessionId: 'old' })).sessionId).toBe('old');
    expect((await h.openSubagent({ step: 's', title: 't', sessionId: 'old-sub', policy: opts.policy })).session.sessionId).toBe('old-sub');
    expect((await h.engine.open(opts)).sessionId).toBe('R-main-1');
  });

  it('a held open resolves only on release', async () => {
    const h = harness('H');
    const hold = h.hold('open');
    let done = false;
    const p = h.engine.open(opts).then((s) => { done = true; return s; });
    await hold.started;
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    hold.release();
    expect((await p).sessionId).toBe('H-main-1');
  });

  it('a held judge answers with the released value, and fail rejects', async () => {
    const h = harness('J');
    const hold = h.hold('judge');
    const p = h.judge({ t: 'llm', q: 'x' }, { lastText: '' });
    await hold.started;
    hold.release(false);
    expect(await p).toBe(false);
    const bad = h.hold('judge');
    const q = h.judge({ t: 'llm', q: 'x' }, { lastText: '' });
    bad.fail(new Error('boom'));
    await expect(q).rejects.toThrow('boom');
    expect(await h.judge({ t: 'llm', q: 'x' }, { lastText: '' })).toBe(true);
  });

  it('the clock steps 1000 per call from zero, per harness', () => {
    const h = harness('C');
    expect([h.now(), h.now()]).toEqual([1000, 2000]);
    expect(harness('D').now()).toBe(1000);
  });
});
