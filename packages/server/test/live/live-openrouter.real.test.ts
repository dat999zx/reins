// Row 12 of the live checks: a model typed as `openrouter:<id>` through the picker route, ten short replies, a tool-call turn if the model takes tools.
// Reports the usage figures, the cost Reins counted, and that nothing shows the key.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LONG, allowAll, asText, call, chatRequests, chatTokens, costOf, keySent, liveSuite, sameCost, startWorld, toolCalls, twice, type World } from './live-harness.js';

const MODEL = process.env.REINS_LIVE_OPENROUTER_MODEL ?? 'minimax/minimax-m3.1-flash:free';

liveSuite('row 12: OpenRouter, a typed model id', { key: 'openrouter' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'openrouter', model: MODEL, settings: { maxCallsPerTurn: 6 } });
    await w.consent();
    fs.writeFileSync(path.join(w.proj, 'hello.txt'), 'hello from the file\n');
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('ten short replies and a tool-call turn on a typed model; the usage, the cost Reins counted, no key shown', async () => {
    // The session starts on the provider's default model; the typed id goes through the picker route.
    const s = await w.session({ model: w.manifest.defaultModel });
    const typed = await w.api('POST', `/api/sessions/${s}/settings`, { model: `openrouter:${MODEL}` });
    expect(typed.status, w.scrub(typed.text)).toBe(200);
    const state = (await w.api('GET', '/api/state')).json.sessions.find((x: any) => x.id === s);
    expect(state.composite).toBe(`openrouter:${MODEL}`);

    w.script(...Array.from({ length: 10 }, (_, i) => ({ text: `${i + 1}`, usage: chatTokens(300 + i * 20, 2 + i, i ? 100 : 0) })));
    let ended = 0;
    let failed: string | undefined;
    for (let i = 1; i <= 10 && !failed; i++) {
      const out = await w.say(s, `Reply with the single digit ${i} and nothing else.`);
      if (out.ended) ended++;
      failed = out.failed;
    }
    expect(w.scrub(failed ?? ''), 'a short reply failed').toBe('');
    expect(ended).toBe(10);

    // The tool-call turn, when the model takes tools.
    const attempt = (strict: boolean) => async () => {
      w.script({ ...call('Read', { file_path: 'hello.txt' }), usage: chatTokens(400, 20) }, { text: 'The file says: hello from the file.', usage: chatTokens(480, 12) });
      const out = await w.say(s, `${strict ? 'You must call the Read tool before you answer. ' : ''}Use the Read tool to read hello.txt in the project folder, and tell me in one sentence what it says.`, allowAll);
      return { onTask: !out.failed && out.ended && toolCalls(out.rows).some((c) => c.tool === 'Read'), out };
    };
    const t = await twice(attempt(false), attempt(true));
    const toolsNote = t.result.onTask ? 'the model took the tool call and continued after the result'
      : t.result.out.failed ? `the tool-call turn failed (the model or its route may not support tools): ${w.scrub(t.result.out.failed).slice(0, 240)}`
        : `the model answered without calling the tool in two tries (reply length ${t.result.out.text.length})`;

    const usage = w.usage(s);
    const sums = usage.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const turns = w.rows(s, 'turn_ended').map((r) => r.data as { cost?: number; unknown?: boolean });
    const known = turns.filter((x) => typeof x.cost === 'number');
    const reins = known.reduce((a, x) => a + x.cost!, 0);
    const listed = (w.manifest.models as Array<{ id: string; price?: any }>).find((m) => m.id === MODEL);
    const priced = listed?.price !== undefined && listed.price.output !== undefined;
    if (priced) expect(sameCost(reins, usage.reduce((a, u) => a + costOf(u, listed!.price), 0))).toBe(true);
    else expect(known.length, 'a model with no price in the manifest must not get an invented cost').toBe(0);

    // The receipt of a plain chat is its log: no row, and no reply the API gave, holds the key.
    const logText = asText(w.rows(s)) + (await w.api('GET', `/api/sessions/${s}/log`)).text;
    expect(logText.includes(w.key)).toBe(false);
    expect(logText.includes(w.key.slice(-8))).toBe(false);
    if (w.fake) {
      expect(keySent(w)).toBe(chatRequests(w).length);
      expect(chatRequests(w)[0]!.body.model).toBe(MODEL);
      expect(t.result.onTask).toBe(true);
    }
    expect(w.sweepAll().hits).toEqual([]);
    w.budget.check();
    w.evidence({
      row: '12', model: MODEL, pass: true,
      counts: { shortRepliesEnded: ended, toolTurnOnTask: t.result.onTask, usageRows: usage.length, input: sums.input, output: sums.output, cacheRead: sums.cacheRead, cacheWrite: sums.cacheWrite, repliesWithCost: known.length, repliesWithUnknownCost: turns.length - known.length, reinsCostUsd: known.length ? Number(reins.toFixed(6)) : 'unknown' },
      notes: [
        `price: ${w.priceNote(MODEL)}`,
        priced ? 'the manifest prices this model, so Reins counted a cost and it equals the recomputed one'
          : 'the manifest has no price for this id (the typed id is not listed): Reins counted the cost as UNKNOWN, not zero, for every reply; a free model is a known 0 only if the manifest says so',
        toolsNote,
        'the log of the session and the API replies hold no key; the temp home, the SSE stream and the server output were swept',
      ],
    });
  }, LONG);
});
