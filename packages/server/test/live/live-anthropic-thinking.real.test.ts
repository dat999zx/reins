// Row 4 of the live checks: extended thinking with a tool call. The second request carries the signed thinking block back; a missing or wrong
// signature is a 400. Asserts the turn ends normally and the stored conversation holds a thinking block WITH a signature.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LONG, blocksOf, call, chatRequests, conversationLines, liveSuite, startWorld, tokens, toolCalls, twice, type World } from './live-harness.js';

const MODEL = 'claude-sonnet-5-5';
const BUDGET_TOKENS = 1024;

liveSuite('row 4: thinking, a tool call, and the signature (Anthropic wire)', { key: 'anthropic' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({
      provider: 'anthropic', model: MODEL, settings: { maxCallsPerTurn: 8 },
      // Test-local: an effort level that sets the thinking body.
      edit: (m) => {
        m.efforts = [{ id: 'think', label: 'Think', body: { thinking: { type: 'enabled', budget_tokens: BUDGET_TOKENS } } }];
        m.defaultEffort = 'think';
      },
    });
    await w.consent();
    fs.writeFileSync(path.join(w.proj, 'hello.txt'), 'hello from the file\n');
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('a turn that thinks, calls a tool and continues is accepted, and the stored conversation keeps the signed thinking block', async () => {
    const attempt = (strict: boolean) => async () => {
      w.script(
        { thinking: { text: 'I should read hello.txt first.', signature: 'sig-thinking-0001-abcdefghijklmnop' }, ...call('Read', { file_path: 'hello.txt' }), usage: tokens(1400, 220) },
        { text: 'The file says: hello from the file.', usage: tokens(1700, 40) },
      );
      const s = await w.session({ effort: 'think' });
      const prompt = strict
        ? 'First think it through. Then you MUST call the Read tool on hello.txt in the project folder before you answer. After the result, say in one sentence what the file says.'
        : 'Think about it, then use the Read tool to read hello.txt in the project folder, and tell me in one sentence what it says.';
      const out = await w.say(s, prompt);
      const lines = conversationLines(w.dir, w.store.getSession(s)!.engineSessionId!);
      const thinking = blocksOf(lines, 'reasoning');
      const called = toolCalls(out.rows).some((c) => c.tool === 'Read');
      return { onTask: out.ended && !out.failed && called && thinking.length > 0, out, s, lines, thinking };
    };
    const r = await twice(attempt(false), attempt(true));
    const { out, thinking, lines } = r.result;
    // Whatever the model did, a 400 is a failure of the wire: the turn must not have failed.
    expect(out.failed, 'the turn failed (a 400 on the second request is a missing or wrong signature)').toBeUndefined();
    if (!r.result.onTask) {
      w.evidence({ row: '4', pass: 'inconclusive', notes: [`the model did not think and call a tool in two tries; reply length ${out.text.length}`] });
      return;
    }
    expect(out.ended).toBe(true);
    const signed = thinking.filter((b) => typeof b.signature === 'string' && b.signature !== '');
    expect(signed.length).toBeGreaterThan(0);
    const usage = lines.filter((l) => l?.usage).length;
    expect(usage).toBeGreaterThanOrEqual(2);
    if (w.fake) {
      const [first, second] = chatRequests(w);
      expect(first!.body.thinking).toEqual({ type: 'enabled', budget_tokens: BUDGET_TOKENS });
      const back = second!.body.messages.flatMap((m: any) => (m.role === 'assistant' ? m.content : [])).filter((b: any) => b.type === 'thinking');
      expect(back).toHaveLength(1);
      expect(back[0].signature).toBe('sig-thinking-0001-abcdefghijklmnop');
    }
    w.budget.check();
    w.evidence({
      row: '4', pass: true,
      counts: { tries: r.tries, thinkingBlocks: thinking.length, thinkingBlocksWithSignature: signed.length, signatureChars: signed[0].signature.length, assistantRepliesWithUsage: usage, turnEnded: out.ended, turnFailed: false },
      notes: [`budget_tokens ${BUDGET_TOKENS} through a test-local effort level of the manifest`, 'the second request was accepted (no 400)'],
    });
    expect(w.sweepAll().hits).toEqual([]);
  }, LONG);
});
