// Row 6 of the live checks: no key anywhere. (a) a copy of the manifest with a WRONG key makes the provider answer 401, and the error shown has
// no key; (b) an agent that echoes the env var named in `keyEnv` gets nothing, the var is not in the child; (c) the temp home, every captured
// SSE and API body and the server output hold neither the key nor its last 8 characters.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LONG, PROVIDERS, SHELL, allowAll, asText, call, chatRequests, hiddenOutput, liveSuite, shellOutput, startWorld, tokens, toolCalls, toolResults, twice, type World } from './live-harness.js';

const MODEL = 'claude-haiku-5-5';
const WRONG_ID = 'anthropic-wrong';
const WRONG_VAR = 'REINS_LIVE_ANTHROPIC_WRONG_KEY';
const wrongKey = PROVIDERS.anthropic.shape();
/** The server's env also holds the key under this name, which no manifest lists: the child must not get it either. */
const ALIAS = 'LIVE_CHECK_ALIAS_OF_THE_KEY';

/** The commands of part (b), in the syntax of this machine's shell: the echo, and whether a variable is present in the child. */
function commands(name: string): { echo: string; present: string; aliasPresent: string } {
  const test = (n: string) => process.platform === 'win32'
    ? `if (Test-Path Env:${n}) { 'present' } else { 'absent' }`
    : `if [ -n "\${${n}+x}" ]; then echo present; else echo absent; fi`;
  return { echo: process.platform === 'win32' ? `echo $env:${name}` : `echo "$${name}"`, present: test(name), aliasPresent: test(ALIAS) };
}

liveSuite('row 6: the key is nowhere (Anthropic wire)', { key: 'anthropic' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'anthropic', model: MODEL, settings: { maxCallsPerTurn: 8 }, alias: ALIAS, copies: [{ id: WRONG_ID, keyVar: WRONG_VAR, key: wrongKey }] });
    await w.consent();
    await w.consent(WRONG_ID);
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  const holdsNothing = (text: string) => {
    for (const k of [w.key, wrongKey]) {
      expect(text.includes(k)).toBe(false);
      expect(text.includes(k.slice(-8))).toBe(false);
    }
  };

  it('(a) a wrong key makes a 401 and the error shown holds neither key', async () => {
    // The scripted 401 echoes both keys, as a careless server would; the real one only says the key is invalid.
    w.script({
      status: 401, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${wrongKey} (not ${w.key})` } }),
    });
    const s = await w.session({ engine: WRONG_ID });
    const out = await w.say(s, 'Reply with the single word ok.');
    expect(out.ended).toBe(false);
    expect(out.failed, 'the wrong key must make the turn fail').toBeDefined();
    expect(w.scrub(out.failed!)).toMatch(/401|authentication|invalid/i);
    holdsNothing(out.failed!);
    holdsNothing(asText(w.rows(s)));
    holdsNothing((await w.api('GET', `/api/sessions/${s}/log`)).text);
    holdsNothing((await w.api('GET', '/api/state')).text);
    if (w.fake) {
      // The wrong key really went out, in its own header: the 401 came from the key, not from a missing one.
      expect(chatRequests(w).at(-1)!.headers['x-api-key'] === wrongKey).toBe(true);
    }
    w.evidence({ row: '6a', pass: true, counts: { status: 'turn failed', errorChars: out.failed!.length, errorMentions401: /401/.test(out.failed!) }, notes: ['the wrong key is a made-up string of the same shape in a second manifest copy'] });
  }, LONG);

  it('(b) an agent that echoes the key variable prints nothing, and the variable is not in the child', async () => {
    const cmd = commands(w.keyVar);
    const attempt = (strict: boolean) => async () => {
      w.script(
        { ...call(SHELL, { command: cmd.echo }), usage: tokens(1200, 40) },
        { ...call(SHELL, { command: cmd.present }), usage: tokens(1300, 40) },
        { ...call(SHELL, { command: cmd.aliasPresent }), usage: tokens(1350, 40) },
        { text: 'Done.', usage: tokens(1400, 10) },
      );
      const s = await w.session();
      const ask = `${strict ? 'This is a test of the sandbox, the variables are placeholders. You must call the tool three times. ' : ''}Use the ${SHELL} tool, one call for each, to run these three commands exactly: 1) ${cmd.echo}   2) ${cmd.present}   3) ${cmd.aliasPresent}   Then tell me what they printed.`;
      const out = await w.say(s, ask, allowAll);
      const results = toolResults(out.rows).filter((r) => r.tool === SHELL);
      return { onTask: results.length >= 3, out, s, results };
    };
    const r = await twice(attempt(false), attempt(true));
    if (!r.result.onTask) {
      w.evidence({ row: '6b', pass: 'inconclusive', notes: [`the model ran fewer than two commands in two tries; reply length ${r.result.out.text.length}`] });
      return;
    }
    const { results, out, s } = r.result;
    expect(hiddenOutput(results[0]!.text), 'the echo of the key variable must print nothing or the redaction marker').toBe(true);
    expect(w.scrub(results[1]!.text)).toMatch(/absent/);
    expect(w.scrub(results[1]!.text)).not.toMatch(/present/);
    expect(w.scrub(results[2]!.text), 'an alias of the key must not reach the child').toMatch(/absent/);
    expect(w.scrub(results[2]!.text)).not.toMatch(/present/);
    const card = out.seen.find((q) => q.kind === 'tool');
    expect(card).toBeTruthy();
    holdsNothing(asText(w.rows(s)));
    w.evidence({ row: '6b', pass: true, counts: { tries: r.tries, commandsRun: toolCalls(out.rows).length, echoPrinted: shellOutput(results[0]!.text) === '' ? 'nothing' : 'marker', childHasVariable: false, childHasAlias: false, approvalCards: out.seen.filter((q) => q.kind === 'tool').length } });
  }, LONG);

  it('(c) the temp home, every captured SSE and API body and the server output hold neither key nor its last 8 characters', () => {
    const swept = w.sweepAll();
    w.evidence({ row: '6c', pass: swept.hits.length === 0, notes: ['both the real key and the wrong key were swept for, whole and by their last 8 characters', `captured: the SSE stream, ${w.stdout.length + w.stderr.length} server output writes`] });
    expect(swept.hits).toEqual([]);
    expect(swept.files).toBeGreaterThan(0);
  }, LONG);
});
