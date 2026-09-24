// The whole `reins run` path against fake-claude (plan 15b 2.6, 2.8). Runs in CI on every OS:
// no real claude, no cost. Each assertion is on the event log, not on the agent's words.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { receipt, type RunEventRecord } from '@reins/core';
import { startRunCli, type RunCliOptions } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { claudeEngine } from '../src/claude/engine.js';
import { FAKE_CLAUDE, fakeSetup, alive, until } from './helpers.js';

const EXAMPLE = path.resolve(__dirname, '../../../examples/upload-retry.reins.md');

function drive(o: Omit<RunCliOptions, 'input' | 'output' | 'makeEngine'>, react?: (chunk: string, type: (l: string) => void) => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => {
    text += d;
    react?.(d, (l) => input.write(l + '\n'));
  });
  const h = startRunCli({ ...o, input, output, makeEngine: ({ onApprove, onLive }) => claudeEngine({ bin: FAKE_CLAUDE, onApprove, onLive }) });
  let pos = 0;
  return {
    h,
    input,
    text: () => text,
    /** Wait for the next match after the previous one. */
    async waitFor(re: RegExp) {
      await until(() => {
        const m = re.exec(text.slice(pos));
        if (m) pos += m.index + m[0].length;
        return !!m;
      }, 30_000).catch(() => { throw new Error(`never saw ${re} in output:\n${text.slice(pos - 500)}`); });
    },
    type: (line: string) => input.write(line + '\n'),
  };
}

const of = (evs: RunEventRecord[], type: RunEventRecord['type']) => evs.filter((e) => e.type === type);
const stepOf = (evs: RunEventRecord[], i: number) => {
  for (let j = i; j >= 0; j--) if (evs[j]!.type === 'turn_started') return evs[j]!.data.step;
  return undefined;
};

describe('reins run against fake-claude', () => {
  it('runs upload-retry through every Phase 2 control', async () => {
    const f = fakeSetup([
      { fixture: 'claude-2.1.281-hook-deny.jsonl', delayMs: 150 },          // plan: Read (steer card lands), Edit (read-only deny)
      { fixture: 'claude-2.1.281-turns.jsonl', turn: 1 },                  // "changes" at the gate
      { fixture: 'claude-2.1.281-approval-allow-hold.jsonl', delayMs: 200 }, // implement: interrupted by a now card
      { fixture: 'claude-2.1.281-hook-deny.jsonl' },                       // the now card's turn: Edit migrations (guard deny)
      { fixture: 'claude-2.1.281-approval-allow-hold.jsonl', approve: true }, // fix 1: approval, allowed
      { fixture: 'claude-2.1.281-approval-deny.jsonl', approve: true },    // fix 2: approval, denied
      { fixture: 'claude-2.1.281-card-marker-hook.jsonl', delayMs: 200 },  // fix 3: stopped by a stop card
    ]);
    fs.writeFileSync(path.join(f.dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node fail.mjs' } }));
    fs.writeFileSync(path.join(f.dir, 'fail.mjs'), 'console.log("FAIL upload should retry: 503"); process.exit(1);');
    const store = openStore(':memory:');
    const d = drive({ file: EXAMPLE, cwd: f.dir, store });

    // recall degrades to a no-op with a clear line
    await d.waitFor(/recall.*Knowl/);
    // plan: a typed line is a steer card, delivered mid-turn
    await d.waitFor(/── plan/);
    await d.waitFor(/→ Read/);
    d.type('PINEAPPLE card: end your plan with PINEAPPLE.');
    await d.waitFor(/⛔ .*read-only/);
    // gate: waits for the terminal; "changes" sends a turn, then it asks again
    await d.waitFor(/approve \/ changes <note> \/ stop/);
    await new Promise((r) => setTimeout(r, 300));
    d.type('changes Add a step that runs the tests.');
    await d.waitFor(/approve \/ changes <note> \/ stop/);
    d.type('approve');
    // implement: a now card interrupts, then its turn hits the guard
    await d.waitFor(/── implement/);
    await d.waitFor(/→ Read/);
    d.type('/now Add a retries column to migrations/0001.sql.');
    await d.waitFor(/⛔ .*guarded/);
    // the test loop: approvals asked in the terminal
    await d.waitFor(/\$ npm test/);
    await d.waitFor(/\? Allow Edit/);
    d.type('y');
    await d.waitFor(/\? Allow Edit/);
    d.type('n not now');
    // fix 3: a stop card halts the run until we say resume
    await d.waitFor(/→ Read/);
    d.type('/stop');
    await d.waitFor(/resume \[note\] \/ stop/);
    d.type('resume');
    // the loop stops at max and asks
    await d.waitFor(/allow <n> more \/ stop/);
    d.type('allow 1 more');
    await d.waitFor(/allow <n> more \/ stop/);
    // Ctrl-C twice kills the run
    d.h.sigint();
    d.h.sigint();
    const res = await d.h.done;
    expect(res.status).toBe('stopped');
    expect(d.text()).toMatch(/Receipt/);
    expect(d.text()).toContain(res.runId);

    const evs = store.loadRun(res.runId)!.snapshot.events;
    // read-only plan step blocked an edit
    const roIdx = evs.findIndex((e) => e.type === 'refusal' && /read-only/.test(e.data.reason));
    expect(stepOf(evs, roIdx)).toBe('plan');
    // steer card delivered mid-turn in plan, inside this session's nonce marker
    const steer = evs.findIndex((e) => e.type === 'card_delivered' && e.data.channel === 'mid-turn' && /PINEAPPLE/.test(e.data.card));
    expect(stepOf(evs, steer)).toBe('plan');
    const nonce = /\[REINS CARD ([0-9a-f]{32}) /.exec(f.log().find((l) => l.kind === 'args').note)![1];
    expect(f.log().some((l) => l.kind === 'hook' && String(l.response.hookSpecificOutput?.additionalContext).includes(`[REINS CARD ${nonce} `))).toBe(true);
    // the gate held: no turn between gate_paused and the changes request, and none of implement before approval
    const gp = evs.findIndex((e) => e.type === 'gate_paused');
    const ga = evs.findIndex((e) => e.type === 'gate_approved');
    expect(gp).toBeGreaterThan(0);
    expect(ga).toBeGreaterThan(gp);
    expect(evs.slice(gp, ga).filter((e) => e.type === 'turn_started').map((e) => e.data.step)).toEqual(['gate-1']);
    expect(evs[ga + 1]).toMatchObject({ type: 'turn_started', data: { step: 'implement' } });
    // the now card interrupted implement and was followed as the next turn; the guard held
    const nowIdx = evs.findIndex((e) => e.type === 'card_delivered' && e.data.channel === 'interrupt' && e.data.kind === 'now');
    expect(stepOf(evs, nowIdx)).toBe('implement');
    expect(f.log().filter((l) => l.kind === 'interrupt').length).toBeGreaterThanOrEqual(2);
    const guard = evs.findIndex((e, i) => i > nowIdx && e.type === 'refusal' && /guarded/.test(e.data.reason));
    expect(guard).toBeGreaterThan(nowIdx);
    // approvals, both answers
    expect(of(evs, 'hook').filter((e) => e.data.event === 'approve').map((e) => e.data.decision)).toEqual(['allow', 'deny']);
    // the stop card paused the run; resume went on
    const stopIdx = evs.findIndex((e) => e.type === 'card_delivered' && e.data.kind === 'stop');
    expect(evs[stopIdx + 1]).toMatchObject({ type: 'run_paused', data: { reason: 'stop' } });
    expect(of(evs, 'run_resumed').length).toBeGreaterThanOrEqual(1);
    // the loop stopped at max (5), then again after one more
    expect(of(evs, 'loop_budget_exceeded').map((e) => e.data.attempts)).toEqual([5, 6]);
    expect(of(evs, 'run_stopped')).toHaveLength(1);
    // receipt counts match the log
    const r = receipt(evs);
    expect(r.status).toBe('stopped');
    expect(r.gatesHeld).toBe(of(evs, 'gate_paused').length);
    expect(r.totalRefusals).toBe(of(evs, 'refusal').length);
    expect(r.guardRefusals).toBe(evs.filter((e) => e.type === 'refusal' && /guard/.test(e.data.reason)).length);
    expect(r.readOnlyRefusals).toBe(1);
    expect(r.loopAttempts).toBe(6);
    expect(r.totalTurns).toBe(of(evs, 'turn_ended').length);
    expect(r.autoCardsFired).toBe(evs.filter((e) => e.type === 'card_queued' && e.data.source === 'auto').length);
    // no claude process left behind
    const pids = f.log().filter((l) => l.kind === 'args').map((l) => l.pid);
    await until(() => pids.every((p) => !alive(p)));
    store.close();
  }, 120_000);

  it('--yes approves gates by itself', async () => {
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: y\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## phase one\n> a\n\n## gate\nuntil: you approve\n\n## phase two\n> b\n');
    const store = openStore(':memory:');
    const d = drive({ file, cwd: f.dir, store, yes: true });
    const res = await d.h.done;
    expect(res.status).toBe('done');
    expect(res.exitCode).toBe(0);
    expect(of(store.loadRun(res.runId)!.snapshot.events, 'gate_approved')).toHaveLength(1);
    store.close();
  }, 60_000);

  it('an answer typed the instant a question prints still answers it (piped input)', async () => {
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: q\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## phase one\n> a\n\n## gate\nuntil: you approve\n\n## phase two\n> b\n');
    const store = openStore(':memory:');
    // Answer synchronously, inside the very write that prints the prompt.
    const d = drive({ file, cwd: f.dir, store }, (chunk, type) => { if (/approve \/ changes/.test(chunk)) type('approve'); });
    const res = await Promise.race([d.h.done, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the gate never got its answer')), 15_000))]);
    expect(res.status).toBe('done');
    expect(of(store.loadRun(res.runId)!.snapshot.events, 'card_queued')).toEqual([]);
    store.close();
  }, 30_000);

  it('check errors stop the run before claude starts', async () => {
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'bad.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: b\nbudget: { turns: 9, minutes: 9 }\n---\n\n## repeat\n\n### phase x\n> y\n');
    const store = openStore(':memory:');
    const d = drive({ file, cwd: f.dir, store });
    const res = await d.h.done;
    expect(res.exitCode).toBe(1);
    expect(d.text()).toMatch(/bad\.reins\.md:\d+:\d+: error: repeat step .* requires max/);
    expect(f.log()).toEqual([]);
    store.close();
  });

  it('--resume picks the run up from the store and resumes the claude session', async () => {
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: r\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## phase one\n> a\n\n## gate\nuntil: you approve\n\n## phase two\n> b\n');
    const dbFile = path.join(f.dir, 'reins.db');
    const store1 = openStore(dbFile);
    const d1 = drive({ file, cwd: f.dir, store: store1 });
    await d1.waitFor(/approve \/ changes/);
    d1.input.end(); // the terminal went away while the gate waits
    const first = await d1.h.done;
    expect(first.status).toBe('paused');
    expect(d1.text()).toContain(`--resume ${first.runId}`);
    store1.close();

    const store2 = openStore(dbFile);
    const d2 = drive({ resumeId: first.runId, cwd: f.dir, store: store2 });
    await d2.waitFor(/approve \/ changes/);
    d2.type('approve');
    const second = await d2.h.done;
    expect(second.status).toBe('done');
    const spawns = f.log().filter((l) => l.kind === 'args');
    expect(spawns).toHaveLength(2);
    const sid = spawns[0].args[spawns[0].args.indexOf('--session-id') + 1];
    expect(spawns[1].args[spawns[1].args.indexOf('--resume') + 1]).toBe(sid);
    expect(of(store2.loadRun(first.runId)!.snapshot.events, 'run_finished')).toHaveLength(1);
    store2.close();
  }, 60_000);
});
