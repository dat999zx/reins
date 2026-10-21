// Row 13 of the live checks: a tool-call turn on the openai-chat wire at the Gemini address, the turn continuing after the tool result (no 400), whether
// the stored assistant message kept the provider's extra fields (thought signatures), three more short replies, and the cost against the manifest price.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LONG, allowAll, asText, blocksOf, chatRequests, chatTokens, conversationLines, costOf, liveSuite, sameCost, startWorld, toolCalls, twice, type World } from './live-harness.js';

const MODEL = process.env.REINS_LIVE_GEMINI_MODEL ?? 'gemini-3.1-flash-lite';
const SIGNATURE_FIELD = { extra_content: { google: { thought_signature: 'sig-gemini-0001-abcdefghijkl' } } };

liveSuite('row 13: Gemini through the openai-chat wire', { key: 'gemini' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'gemini', model: MODEL, settings: { maxCallsPerTurn: 6 } });
    await w.consent();
    fs.writeFileSync(path.join(w.proj, 'hello.txt'), 'hello from the file\n');
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('a tool-call turn continues after the tool result, extras are kept or not (reported), three more replies, the cost', async () => {
    const s = await w.session({ model: w.manifest.defaultModel });
    const typed = await w.api('POST', `/api/sessions/${s}/settings`, { model: `gemini:${MODEL}` });
    expect(typed.status, w.scrub(typed.text)).toBe(200);

    const attempt = (strict: boolean) => async () => {
      w.script(
        { toolCalls: [{ id: 'call_g1', name: 'Read', args: JSON.stringify({ file_path: 'hello.txt' }), extra: SIGNATURE_FIELD }], usage: chatTokens(420, 25) },
        { text: 'The file says: hello from the file.', usage: chatTokens(520, 14) },
      );
      const out = await w.say(s, `${strict ? 'You must call the Read tool before you answer. ' : ''}Use the Read tool to read hello.txt in the project folder, and tell me in one sentence what it says.`, allowAll);
      return { onTask: out.ended && !out.failed && toolCalls(out.rows).some((c) => c.tool === 'Read'), out };
    };
    const t = await twice(attempt(false), attempt(true));
    // The turn must not have failed whatever the model did: a 400 after the tool result is the thing this row looks for.
    expect(w.scrub(t.result.out.failed ?? ''), 'the turn failed (a 400 after the tool result?)').toBe('');
    if (!t.result.onTask) {
      w.evidence({ row: '13', model: MODEL, pass: 'inconclusive', notes: [`the model did not call the tool in two tries; reply length ${t.result.out.text.length}`] });
      return;
    }
    expect(t.result.out.ended).toBe(true);

    // What the stored assistant message kept of the provider's own fields.
    const lines = conversationLines(w.dir, w.store.getSession(s)!.engineSessionId!);
    const calls = blocksOf(lines, 'tool_call');
    const withExtra = calls.filter((b) => b.extra && Object.keys(b.extra).length);
    const extraKeys = [...new Set(withExtra.flatMap((b) => Object.keys(b.extra)))];
    const msgExtra = lines.filter((l) => l?.t === 'msg' && l.role === 'assistant' && l.extra && Object.keys(l.extra).length).length;
    if (w.fake) {
      expect(extraKeys).toContain('extra_content');
      // Extras go back only to the provider that wrote them: the second request carries the field on the tool call.
      const second = chatRequests(w)[1]!.body.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
      expect(second.tool_calls[0].extra_content).toEqual(SIGNATURE_FIELD.extra_content);
    }

    w.script(...[1, 2, 3].map((n) => ({ text: `${n}`, usage: chatTokens(560 + n * 10, 3) })));
    for (let n = 1; n <= 3; n++) {
      const out = await w.say(s, `Reply with the single digit ${n} and nothing else.`);
      expect(w.scrub(out.failed ?? '')).toBe('');
      expect(out.ended).toBe(true);
    }

    const usage = w.usage(s);
    const sums = usage.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const turns = w.rows(s, 'turn_ended').map((r) => r.data as { cost?: number });
    const known = turns.filter((x) => typeof x.cost === 'number');
    const reins = known.reduce((a, x) => a + x.cost!, 0);
    const listed = (w.manifest.models as Array<{ id: string; price?: any }>).find((m) => m.id === MODEL);
    const priced = listed?.price?.output !== undefined;
    const mine = priced ? usage.reduce((a, u) => a + costOf(u, listed!.price), 0) : undefined;
    if (mine !== undefined) expect(sameCost(reins, mine), `Reins $${reins} against the manifest price $${mine}`).toBe(true);
    else expect(known.length, 'a model with no price in the manifest must not get an invented cost').toBe(0);

    expect((asText(w.rows(s)) + (await w.api('GET', `/api/sessions/${s}/log`)).text).includes(w.key)).toBe(false);
    expect(w.sweepAll().hits).toEqual([]);
    w.budget.check();
    w.evidence({
      row: '13', model: MODEL, pass: true,
      counts: { tries: t.tries, continuedAfterToolResult: true, toolCallBlocks: calls.length, toolCallBlocksWithProviderExtras: withExtra.length, assistantMessagesWithExtras: msgExtra, usageRows: usage.length, input: sums.input, output: sums.output, repliesWithCost: known.length, reinsCostUsd: known.length ? Number(reins.toFixed(6)) : 'unknown', manifestPriceCostUsd: mine === undefined ? 'no price' : Number(mine.toFixed(6)) },
      notes: [
        `provider extras kept on the stored tool call: ${withExtra.length ? `yes, fields ${extraKeys.join(', ')}` : 'none seen (the provider sent none, or Reins did not keep them)'}`,
        `price: ${w.priceNote(MODEL)}`,
        priced ? 'the model is priced in the manifest: Reins counted a cost and it equals the recomputed one'
          : 'the model is not in the catalog manifest: Reins has no price for it and counted every reply as UNKNOWN cost, not zero',
        w.mode === 'real' ? `address: ${w.manifest.baseUrl}` : 'dry run: the address is the fake provider',
      ],
    });
  }, LONG);
});
