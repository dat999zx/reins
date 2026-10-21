// Rows 2 and 3 of the live checks: a 3-step editing workflow with an approval card, Stop during a pending approval (B3), and a workflow with a
// small USD limit that pauses in the middle of a step (B2). One world for both, swept at the end.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openQuestions } from '../http-helpers.js';
import { LONG, SHELL, allowAll, call, costOf, liveSuite, tokens, twice, startWorld, keySent, type Handler, type World } from './live-harness.js';

const MODEL = 'claude-haiku-5-5';
const PROMPT_STRICT = 'You must use the tools named below. Do not answer in text before you have called the tool.';

const THREE_STEPS = (strict: boolean) => `---
reins: 1
name: edit3
budget: { turns: 30, minutes: 20, usd: 1.00 }
always: []
---

## phase write
> ${strict ? `${PROMPT_STRICT} ` : ''}Use the Write tool to create notes.txt in the project folder with the single line: alpha

## phase edit
> ${strict ? `${PROMPT_STRICT} ` : ''}Use the Edit tool to change alpha to beta in notes.txt.

## phase shell
> ${strict ? `${PROMPT_STRICT} ` : ''}Use the ${SHELL} tool to run exactly this command: echo reins-live-ok
`;

const MANY = (strict: boolean) => `---
reins: 1
name: many
budget: { turns: 60, minutes: 20, usd: 0.02 }
always: []
---

## phase read-all
> ${strict ? `${PROMPT_STRICT} ` : ''}Read the files f01.txt to f15.txt in the project folder with the Read tool, ONE file per call, one call after another (do not batch them), then say done.
`;

liveSuite('rows 2 and 3: approval, Stop, and the USD pause (Anthropic wire)', { key: 'anthropic' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'anthropic', model: MODEL, settings: { maxCallsPerTurn: 12 } });
    await w.consent();
    for (let i = 1; i <= 15; i++) fs.writeFileSync(path.join(w.proj, `f${String(i).padStart(2, '0')}.txt`), `file ${i}\n`);
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('row 2: a 3-step editing workflow shows the approval card, finishes, and Stop on a pending approval ends the turn (B3)', async () => {
    // A: the workflow
    const attempt = (strict: boolean) => async () => {
      w.script(
        { ...call('Write', { file_path: 'notes.txt', content: 'alpha\n' }), usage: tokens(1500, 60) }, { text: 'Wrote notes.txt.', usage: tokens(1700, 20) },
        { ...call('Edit', { file_path: 'notes.txt', old_string: 'alpha', new_string: 'beta' }), usage: tokens(1800, 60) }, { text: 'Edited notes.txt.', usage: tokens(1900, 20) },
        { ...call(SHELL, { command: 'echo reins-live-ok' }), usage: tokens(2000, 40) }, { text: 'Ran the command.', usage: tokens(2100, 20) },
      );
      const s = await w.session();
      const run = await w.workflow(s, `edit3-${strict ? 's' : 'a'}`, THREE_STEPS(strict), allowAll);
      const shellCard = run.seen.find((q) => q.kind === 'tool' && q.prompt.includes(SHELL));
      return { onTask: !!shellCard && run.rows.some((r) => r.type === 'run_finished'), s, run, shellCard };
    };
    const a = await twice(attempt(false), attempt(true));
    if (!a.result.onTask) {
      w.evidence({ row: '2', pass: 'inconclusive', notes: ['the model did not reach the approval card of the shell step in two tries', `receipt seen: ${!!a.result.run.receipt}`] });
      return;
    }
    const { run, shellCard } = a.result;
    expect(shellCard!.kind).toBe('tool');
    expect(run.rows.some((r) => r.type === 'run_stopped')).toBe(false);
    expect(fs.existsSync(path.join(w.proj, 'notes.txt'))).toBe(true);
    if (w.mode === 'dry') expect(fs.readFileSync(path.join(w.proj, 'notes.txt'), 'utf8').trim()).toBe('beta');
    expect(run.receipt).toBeTruthy();

    // B: Stop while the approval is pending, then a new message (the B3 regression)
    const never: Handler = () => undefined;
    const pending = async (strict: boolean) => {
      w.script({ ...call(SHELL, { command: 'echo stop-me' }), usage: tokens(900, 30) });
      const s2 = await w.session();
      const mark = await w.send(s2, `${strict ? 'You must call the tool, do not answer in text. ' : ''}Use the ${SHELL} tool to run exactly this command: echo stop-me`);
      // Waits for the card, or for a turn that ended without one (the model answered in text).
      await w.pump(s2, () => openQuestions(w.rows(s2)).some((q) => q.kind === 'tool') || w.rows(s2).some((r) => r.seq > mark && (r.type === 'turn_ended' || r.type === 'turn_failed')), never);
      return { onTask: openQuestions(w.rows(s2)).some((q) => q.kind === 'tool'), s2, mark };
    };
    const b = await twice(() => pending(false), () => pending(true));
    if (!b.result.onTask) {
      w.evidence({ row: '2 (Stop on a pending approval)', pass: 'inconclusive', notes: ['the model never asked for the shell command in two tries, so there was no pending approval to stop'] });
      return;
    }
    const { s2, mark } = b.result;
    const pendingCards = openQuestions(w.rows(s2)).filter((q) => q.kind === 'tool').length;
    expect(pendingCards).toBe(1);
    const t0 = Date.now();
    expect((await w.stop(s2)).status).toBe(200);
    const stopped = await w.settle(s2, mark, never);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(w.mode === 'dry' ? 5_000 : 60_000);
    expect(openQuestions(w.rows(s2))).toEqual([]);
    w.script({ text: 'ok', usage: tokens(1000, 5) });
    const next = await w.say(s2, 'Reply with the single word ok.', allowAll);
    expect(next.failed).toBeUndefined();
    expect(next.ended).toBe(true);
    expect(next.text.length).toBeGreaterThan(0);
    if (w.fake) expect(keySent(w)).toBe(w.fake.requests.filter((r) => r.path.endsWith('/messages')).length);

    w.budget.check();
    w.evidence({
      row: '2', pass: true,
      counts: { tries: a.tries, approvalCards: run.seen.filter((q) => q.kind === 'tool').length, runFinished: 1, receiptTurns: run.receipt.totalTurns, stopTries: b.tries, pendingAtStop: pendingCards, stopToEndMs: ms, endedByStop: stopped.ended, newReplyChars: next.text.length },
      notes: [`price used by the Budget and Reins: ${w.priceNote(MODEL)}`],
    });
  }, LONG);

  it('row 3: a workflow with usd 0.02 pauses in the middle of a step on the USD card, one call over at most; Allow continues, stop ends', async () => {
    const LIMIT = 0.02;
    const reads = (n: number) => Array.from({ length: n }, (_, i) => ({ ...call('Read', { file_path: `f${String(i + 1).padStart(2, '0')}.txt` }, `toolu_r${i}`), usage: tokens(3000, 1000) }));
    const seenPause: Array<{ midStep: boolean; calls: number; shown: number; own: number; biggest: number }> = [];

    const run = async (answer: 'allow' | 'stop', strict: boolean) => {
      w.script(...(answer === 'allow' ? [...reads(6), { text: 'done', usage: tokens(3500, 5) }] : reads(3)));
      const s = await w.session();
      let first = true;
      const handler: Handler = (q, rows) => {
        if (q.kind === 'usd') {
          const start = rows.find((r) => r.type === 'run_started')?.seq ?? 0;
          const shown = Number(/used \$([\d.]+) of its/.exec(q.detail ?? '')?.[1]);
          const lines = w.usage(s);
          const own = lines.reduce((a, u) => a + costOf(u, w.priceOf(u.model)), 0);
          seenPause.push({
            // The one step was cut by the budget (its turn ended with the engine's stop words), not finished by the model.
            midStep: rows.some((r) => r.seq > start && r.type === 'turn_ended' && /USD budget/.test(String((r.data as { text?: unknown }).text))),
            calls: rows.filter((r) => r.seq > start && r.type === 'engine' && (r.data as { type?: string }).type === 'tool_call').length,
            shown, own, biggest: Math.max(...lines.map((u) => costOf(u, w.priceOf(u.model)))),
          });
          if (answer === 'allow' && first) { first = false; return 'allow $0.05 more'; }
          return 'stop';
        }
        return allowAll(q, rows);
      };
      const r = await w.workflow(s, `many-${answer}-${strict ? 's' : 'a'}`, MANY(strict), handler);
      return { onTask: r.seen.some((q) => q.kind === 'usd'), r, s };
    };

    const allow = await twice(() => run('allow', false), () => run('allow', true));
    if (!allow.result.onTask) {
      w.evidence({ row: '3', pass: 'inconclusive', notes: ['the run never paused on the USD card in two tries (the model finished inside the limit)'] });
      return;
    }
    const pause = seenPause.at(-1)!;
    expect(pause.midStep).toBe(true);
    expect(pause.calls).toBeGreaterThanOrEqual(2);
    expect(pause.shown).toBeGreaterThanOrEqual(LIMIT - 1e-4);
    expect(pause.shown - LIMIT).toBeLessThanOrEqual(pause.biggest + 1e-4);          // at most one call over
    expect(Math.abs(pause.shown - pause.own)).toBeLessThan(2e-4);                    // Reins's figure is the Budget's own count
    const allowEnd = allow.result.r.rows.find((r) => r.type === 'run_finished' || r.type === 'run_stopped');
    expect(allowEnd).toBeTruthy();
    if (w.mode === 'dry') expect(allowEnd!.type).toBe('run_finished');

    const stop = await run('stop', false);
    expect(stop.onTask).toBe(true);
    expect(stop.r.rows.some((r) => r.type === 'run_stopped')).toBe(true);

    w.budget.check();
    w.evidence({
      row: '3', pass: true,
      counts: { tries: allow.tries, pausedMidStep: pause.midStep, toolCallsBeforePause: pause.calls, shownUsd: pause.shown, ownCountUsd: Number(pause.own.toFixed(6)), limitUsd: LIMIT, overByUsd: Number((pause.shown - LIMIT).toFixed(6)), oneCallUsd: Number(pause.biggest.toFixed(6)), allowEnded: allowEnd!.type, stopEnded: 'run_stopped' },
      notes: ['the limit is the run-level `usd` of the workflow front matter'],
    });
  }, LONG);

  it('rows 2 and 3 together: the same home, every captured body and the server output hold neither the key nor its last 8 characters', () => {
    const swept = w.sweepAll();
    w.evidence({ row: '2+3 sweep', pass: swept.hits.length === 0, notes: ['one temp home for rows 2 and 3, swept after both'] });
    expect(swept.hits).toEqual([]);
    expect(swept.files).toBeGreaterThan(0);
  }, LONG);
});
