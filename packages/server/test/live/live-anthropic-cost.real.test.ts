// Row 5 of the live checks: ten short replies in one session, the cost recomputed independently from the raw usage rows of the conversation
// file and the manifest price, compared with what Reins counted. Prints both and the token sums so the human can compare with the console.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LONG, costOf, liveSuite, sameCost, startWorld, tokens, type World } from './live-harness.js';

const MODEL = 'claude-haiku-5-5';

liveSuite('row 5: ten replies, the cost to the cent (Anthropic wire)', { key: 'anthropic' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'anthropic', model: MODEL, settings: { maxCallsPerTurn: 4 } });
    await w.consent();
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('Reins\'s total of ten replies equals the recomputed cost, to the cent', async () => {
    // Scripted usage differs from reply to reply and uses the cache fields.
    w.script(...Array.from({ length: 10 }, (_, i) => ({ text: `${i + 1}`, usage: tokens(900 + i * 130, 3 + i, i % 2 ? 400 + i * 10 : 0, i === 0 ? 700 : 0) })));
    const s = await w.session();
    for (let i = 1; i <= 10; i++) {
      const out = await w.say(s, `Reply with the single digit ${i} and nothing else.`);
      expect(out.failed).toBeUndefined();
      expect(out.ended).toBe(true);
    }
    const usage = w.usage(s);
    expect(usage).toHaveLength(10);
    const price = w.priceOf(MODEL);
    const mine = usage.reduce((a, u) => a + costOf(u, price), 0);
    const turns = w.rows(s, 'turn_ended').map((r) => (r.data as { cost?: number }).cost);
    expect(turns.every((c) => typeof c === 'number')).toBe(true);
    const reins = (turns as number[]).reduce((a, c) => a + c, 0);
    const stored = w.store.getEngineTotal(w.store.getSession(s)!.engineSessionId!);
    const sums = usage.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    const line = `row 5 | Reins total $${reins.toFixed(6)} | recomputed $${mine.toFixed(6)} | stored total ${stored === undefined ? 'unknown' : `$${stored.toFixed(6)}`} | price ${JSON.stringify(price)} | tokens ${JSON.stringify(sums)}`;
    console.log(line);
    expect(sameCost(reins, mine), line).toBe(true);
    if (stored !== undefined) expect(sameCost(stored, mine), line).toBe(true);
    if (w.fake) {
      // The scripted usage is known: the sums are exactly what the fake sent.
      expect(sums.input).toBe(Array.from({ length: 10 }, (_, i) => 900 + i * 130).reduce((a, b) => a + b, 0));
      expect(sums.cacheWrite).toBe(700);
    }
    w.budget.check();
    w.evidence({
      row: '5', pass: true,
      counts: { replies: 10, reinsTotalUsd: Number(reins.toFixed(6)), recomputedUsd: Number(mine.toFixed(6)), storedTotalUsd: stored === undefined ? 'unknown' : Number(stored.toFixed(6)), input: sums.input, output: sums.output, cacheRead: sums.cacheRead, cacheWrite: sums.cacheWrite },
      notes: [`price: ${w.priceNote(MODEL)}`, 'compare the total with the provider console by hand'],
    });
    expect(w.sweepAll().hits).toEqual([]);
  }, LONG);
});
