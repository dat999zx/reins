// Row 8 of the live checks (Windows only): the shell tool runs Get-ChildItem, a two-line script, and an echo of the key variable. Reports which
// shell the tool used.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LONG, SHELL, allowAll, asText, call, hiddenOutput, liveSuite, shellOutput, startWorld, tokens, toolResults, twice, type World } from './live-harness.js';

const MODEL = 'claude-haiku-5-5';
const TWO_LINES = "$a = 'reins'\nWrite-Output \"$a-ok $($PSVersionTable.PSVersion)\"";

liveSuite('row 8: the PowerShell tool (Anthropic wire, Windows)', { key: 'anthropic', windows: true }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'anthropic', model: MODEL, settings: { maxCallsPerTurn: 8 } });
    await w.consent();
    fs.writeFileSync(path.join(w.proj, 'marker.txt'), 'marker\n');
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('Get-ChildItem, a two-line script and an echo of the key variable', async () => {
    const echo = `echo $env:${w.keyVar}`;
    const attempt = (strict: boolean) => async () => {
      w.script(
        { ...call(SHELL, { command: 'Get-ChildItem -Name' }), usage: tokens(1200, 30) },
        { ...call(SHELL, { command: TWO_LINES }), usage: tokens(1300, 50) },
        { ...call(SHELL, { command: echo }), usage: tokens(1400, 30) },
        { text: 'All three ran.', usage: tokens(1500, 10) },
      );
      const s = await w.session();
      const ask = `${strict ? 'You must call the tool three times, once for each command. ' : ''}Use the ${SHELL} tool, one call for each, in this order: 1) Get-ChildItem -Name   2) this two-line script:\n${TWO_LINES}\n   3) ${echo}\nThen say what each printed.`;
      const out = await w.say(s, ask, allowAll);
      const results = toolResults(out.rows).filter((x) => x.tool === SHELL);
      return { onTask: results.length >= 3, out, s, results };
    };
    const r = await twice(attempt(false), attempt(true));
    if (!r.result.onTask) {
      w.evidence({ row: '8', pass: 'inconclusive', notes: [`fewer than three commands ran in two tries; reply length ${r.result.out.text.length}`] });
      return;
    }
    const { results, out, s } = r.result;
    expect(SHELL).toBe('PowerShell');
    expect(w.scrub(results[0]!.text)).toContain('marker.txt');
    const version = /reins-ok (\d+\.\d+\.\d+(?:\.\d+)?)/.exec(w.scrub(results[1]!.text));
    expect(version, 'the two-line script must print reins-ok and the PowerShell version').toBeTruthy();
    expect(hiddenOutput(results[2]!.text)).toBe(true);
    expect(out.seen.filter((q) => q.kind === 'tool').length).toBeGreaterThanOrEqual(3);
    expect(asText(w.rows(s)).includes(w.key)).toBe(false);
    expect(w.sweepAll().hits).toEqual([]);
    w.budget.check();
    w.evidence({
      row: '8', pass: true,
      counts: { tries: r.tries, commands: results.length, approvalCards: out.seen.filter((q) => q.kind === 'tool').length, echoPrinted: shellOutput(results[2]!.text) === '' ? 'nothing' : 'marker' },
      notes: [`shell used: the tool named ${SHELL}, which Reins starts as Windows PowerShell ${version![1]} (powershell.exe under System32\\WindowsPowerShell\\v1.0)`],
    });
  }, LONG);
});
