// Phase 2 core changes (plan §15b 2.1): card kinds, now:/stop: auto cards, guard paths on
// Windows, Bash == PowerShell, plus the hooks the terminal runner needs from Run.
import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import { validate } from '../src/validate.js';
import { Run } from '../src/run.js';
import { FakeEngine } from '../src/fake-engine.js';
import { checkTool } from '../src/policy.js';
import { receipt } from '../src/receipt.js';
import type { Policy } from '../src/compile.js';

const src = (body: string) => `---\nreins: 1\nname: p\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`;
const wf = (body: string) => {
  const r = parseWorkflow(src(body));
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};
async function drive(run: Run, max = 50) {
  for (let i = 0; i < max && run.status === 'running'; i++) await run.step();
  return run.status;
}

describe('card kinds (plan 6.5)', () => {
  it('a now card queued mid-turn interrupts, is sent as the next turn, and the step goes on', async () => {
    const eng = new FakeEngine([
      { events: [{ type: 'tool_call', tool: 'Read', input: { file_path: 'a' } }], text: '' },
      { text: 'did the card\nREINS: done' },
      { text: 'REINS: done' },
    ]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second'), engine: eng });
    eng.onToolCall = () => { eng.onToolCall = undefined; run.queueCard('USE-TABS', 'now'); };
    expect(await drive(run)).toBe('done');
    expect(eng.interrupted).toBe(true);
    expect(eng.receivedTexts).toHaveLength(3);
    expect(eng.receivedTexts[1]).toContain('USE-TABS');
    expect(eng.receivedTexts[1]).toContain('REINS: done | blocked');
    expect(eng.receivedTexts[2]).toContain('second');
    const delivered = run.getEvents().filter((e) => e.type === 'card_delivered');
    expect(delivered.map((e) => e.data.channel)).toEqual(['interrupt']);
  });

  it('a stop card mid-turn interrupts and pauses; nothing runs until resume()', async () => {
    const eng = new FakeEngine([
      { events: [{ type: 'tool_call', tool: 'Read', input: { file_path: 'a' } }], text: '' },
      { text: 'REINS: done' },
      { text: 'REINS: done' },
    ]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second'), engine: eng });
    eng.onToolCall = () => { eng.onToolCall = undefined; run.queueCard('halt', 'stop'); };
    expect(await drive(run)).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'halt' });
    expect(eng.interrupted).toBe(true);
    expect(eng.receivedTexts).toHaveLength(1);
    run.resume();
    expect(await drive(run)).toBe('done');
    // The interrupted step runs again, then the next one.
    expect(eng.receivedTexts[1]).toContain('first');
    expect(eng.receivedTexts[2]).toContain('second');
  });

  it('a stop card while no turn runs pauses before the next step', async () => {
    const eng = new FakeEngine();
    const run = new Run({ workflow: wf('## phase one\n> first'), engine: eng });
    run.queueCard('wait', 'stop');
    expect(await drive(run)).toBe('paused');
    expect(eng.receivedTexts).toHaveLength(0);
  });

  it('live cards are not counted as auto cards in the receipt', async () => {
    const run = new Run({ workflow: wf('## phase one\n> first'), engine: new FakeEngine() });
    run.queueCard('hello');
    await drive(run);
    const r = receipt(run.getEvents());
    expect(r.autoCardsFired).toBe(0);
    expect(r.liveCardsDelivered).toBe(1);
  });
});

describe('now: and stop: auto cards', () => {
  it('parse and print round-trip', () => {
    const text = src('## phase one\n> first\n\n## whenever same error twice\nstop: Hard stop, same error.\n\n## whenever attempts > 3\nnow: Read the error.');
    const { workflow, diagnostics } = parseWorkflow(text);
    expect(diagnostics).toEqual([]);
    expect(workflow!.autos.map((a) => a.card.kind)).toEqual(['stop', 'now']);
    expect(printWorkflow(workflow!)).toBe(text);
  });

  it('the validator refuses now:/stop: on a step', () => {
    const { workflow } = parseWorkflow(src('## phase one\nstop: no\n> first'));
    const errs = validate(workflow!).filter((d) => d.severity === 'error');
    expect(errs.some((e) => e.message.includes('whenever'))).toBe(true);
  });

  it('a stop: auto card pauses the run', async () => {
    const eng = new FakeEngine([{ text: 'ok\nREINS: done' }, { text: 'REINS: done' }]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever agent says done\nstop: check it'), engine: eng });
    expect(await drive(run)).toBe('paused');
    expect(run.pauseReason?.type).toBe('stop');
    expect(eng.receivedTexts).toHaveLength(1);
  });
});

describe('policy checks (checkTool)', () => {
  const write: Policy = { mode: 'write', guards: ['migrations/**'], allowShell: true };
  it('a Windows absolute path is matched relative to the run cwd', () => {
    expect(checkTool(write, 'Edit', { file_path: 'D:\\repo\\migrations\\0001.sql' }, 'D:\\repo')).toContain('guard');
    expect(checkTool(write, 'Edit', { file_path: 'D:\\repo\\src\\upload.mjs' }, 'D:\\repo')).toBeNull();
    expect(checkTool(write, 'Write', { file_path: 'd:/repo/migrations/x.sql' }, 'D:\\repo')).toContain('guard');
  });
  it('a relative path matches as before', () => {
    expect(checkTool(write, 'Write', { file_path: 'migrations/001.sql' }, '/r')).toContain('guard');
  });
  it('read-only blocks writes and shell, allows reads', () => {
    const ro: Policy = { mode: 'read-only', guards: [], allowShell: true };
    expect(checkTool(ro, 'Edit', { file_path: 'a' }, '/r')).toContain('read-only');
    expect(checkTool(ro, 'Bash', { command: 'ls' }, '/r')).toContain('read-only');
    expect(checkTool(ro, 'PowerShell', { command: 'ls' }, '/r')).toContain('read-only');
    expect(checkTool(ro, 'Read', { file_path: 'a' }, '/r')).toBeNull();
    expect(checkTool(ro, 'Grep', { pattern: 'x' }, '/r')).toBeNull();
  });
  it('Bash and PowerShell are the same tool', () => {
    const noShell: Policy = { mode: 'write', guards: [], allowShell: false };
    expect(checkTool(noShell, 'Bash', { command: 'ls' }, '/r')).not.toBeNull();
    expect(checkTool(noShell, 'PowerShell', { command: 'ls' }, '/r')).not.toBeNull();
    expect(checkTool(write, 'PowerShell', { command: 'Set-Content D:\\repo\\migrations\\0001.sql x' }, 'D:\\repo')).toContain('guard');
    expect(checkTool(write, 'Bash', { command: 'echo x > "migrations/0002.sql"' }, '/r')).toContain('guard');
    expect(checkTool(write, 'PowerShell', { command: 'npm test' }, 'D:\\repo')).toBeNull();
  });
  it('a pending gate blocks every write', () => {
    const gated: Policy = { mode: 'write', guards: [], allowShell: true, pendingGate: 'gate-1' };
    expect(checkTool(gated, 'Edit', { file_path: 'a' }, '/r')).not.toBeNull();
    expect(checkTool(gated, 'Read', { file_path: 'a' }, '/r')).toBeNull();
  });
  it('the FakeEngine uses the same check (Windows guard path)', async () => {
    const eng = new FakeEngine([{ events: [{ type: 'tool_call', tool: 'Edit', input: { file_path: 'D:\\repo\\migrations\\1.sql' } }], text: 'REINS: done' }]);
    const run = new Run({ workflow: wf('## phase one\nguard: migrations/**\n> first'), engine: eng, cwd: 'D:\\repo' });
    await drive(run);
    expect(receipt(run.getEvents()).guardRefusals).toBe(1);
  });
});

describe('what the terminal runner needs from Run', () => {
  it('allowMore(1) after a used-up loop gives exactly one more attempt', async () => {
    let n = 0;
    const run = new Run({
      workflow: wf('## repeat\nuntil: `t` passes\nmax: 2\n\n### run `t`\n\n### phase fix\n> f'),
      engine: new FakeEngine(),
      commandRunner: async () => { n++; return { exitCode: n >= 3 ? 0 : 1, stdout: '', stderr: 'x' }; },
    });
    expect(await drive(run)).toBe('paused');
    expect(n).toBe(2);
    run.allowMore(1);
    expect(await drive(run)).toBe('done');
    expect(n).toBe(3);
    expect(receipt(run.getEvents()).loopAttempts).toBe(2);
  });

  it('onEvent sees every event as it is logged', async () => {
    const seen: string[] = [];
    const run = new Run({ workflow: wf('## phase one\n> first'), engine: new FakeEngine(), onEvent: (e) => seen.push(e.type) });
    await drive(run);
    expect(seen).toEqual(run.getEvents().map((e) => e.type));
  });

  it('the snapshot keeps the engine session id and restore resumes it', async () => {
    const opened: Array<string | undefined> = [];
    const eng = new FakeEngine();
    const open = eng.open.bind(eng);
    eng.open = async (o) => { opened.push(o.sessionId); return open(o); };
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## gate\nuntil: you approve\n\n## phase two\n> second'), engine: eng });
    await drive(run);
    const snap = run.snapshot();
    expect(snap.sessionId).toMatch(/^fake-sess-/);
    const again = Run.restore(snap, { engine: eng });
    again.approve();
    await drive(again);
    expect(opened).toEqual([undefined, snap.sessionId]);
  });

  it('touches <glob> matches Windows absolute paths relative to the run cwd', async () => {
    const eng = new FakeEngine([
      { events: [{ type: 'tool_call', tool: 'Read', input: { file_path: 'D:\\repo\\src\\core\\a.ts' } }], text: 'REINS: done' },
      { text: 'REINS: done' },
    ]);
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## phase two\n> second\n\n## whenever touches src/core/**\ncheckpoint: core touched'), engine: eng, cwd: 'D:\\repo' });
    await drive(run);
    expect(eng.receivedTexts[1]).toContain('core touched');
  });

  it('request changes at a gate sends the note as a turn, with writes locked, and asks again', async () => {
    const eng = new FakeEngine([
      { text: 'plan v1\nREINS: done' },
      { events: [{ type: 'tool_call', tool: 'Edit', input: { file_path: 'a.ts' } }], text: 'plan v2\nREINS: done' },
      { text: 'REINS: done' },
    ]);
    const run = new Run({ workflow: wf('## phase plan\n> p\n\n## gate\nuntil: you approve\n\n## phase implement\n> i'), engine: eng });
    expect(await drive(run)).toBe('paused');
    await run.requestChanges('Add a step for tests.');
    expect(run.pauseReason?.type).toBe('gate');
    expect(eng.receivedTexts[1]).toContain('Add a step for tests.');
    expect(eng.recordedPolicyChecks[0]!.policy.pendingGate).toBe('gate-1');
    expect(run.getEvents().filter((e) => e.type === 'refusal')).toHaveLength(1);
    run.approve();
    expect(await drive(run)).toBe('done');
    expect(eng.recordedPolicyChecks.length).toBe(1);
  });

  it('close() closes the engine session', async () => {
    let closed = 0;
    const eng = new FakeEngine();
    const open = eng.open.bind(eng);
    eng.open = async (o) => { const s = await open(o); return { ...s, close: async () => { closed++; } }; };
    const run = new Run({ workflow: wf('## phase one\n> first'), engine: eng });
    await drive(run);
    const id = run.snapshot().sessionId;
    await run.close();
    expect(closed).toBe(1);
    expect(run.snapshot().sessionId).toBe(id);
  });

  it('stop() twice logs one run_stopped', async () => {
    const run = new Run({ workflow: wf('## phase one\n> first'), engine: new FakeEngine() });
    await run.step();
    await Promise.all([run.stop(), run.stop()]);
    expect(run.getEvents().filter((e) => e.type === 'run_stopped')).toHaveLength(1);
  });

  it('the log records each judge answer', async () => {
    const run = new Run({ workflow: wf('## gate\nuntil: llm says "ok"'), engine: new FakeEngine(), judge: async () => false });
    await drive(run);
    expect(run.getEvents().find((e) => e.type === 'judge')?.data).toEqual({ cond: { t: 'llm', q: 'ok' }, answer: false });
  });

  it('a step inlined from a use block reaches the agent with its own prompt and cards', async () => {
    const block = parseWorkflow('---\nreins: 1\nblock: rp\n---\n\n## phase review\nnote: as a harsh reviewer\n> Review the full diff.\n').workflow!;
    const eng = new FakeEngine();
    const run = new Run({ workflow: wf('## phase one\n> first\n\n## use rp'), engine: eng, resolveBlock: (n) => (n === 'rp' ? block : undefined) });
    await drive(run);
    expect(eng.receivedTexts[1]).toContain('Review the full diff.');
    expect(eng.receivedTexts[1]).toContain('as a harsh reviewer');
  });

  it('engine hook events reach the run log', async () => {
    const engine: any = {
      id: 'claude', probe: async () => ({}),
      open: async () => ({
        sessionId: 's', interrupt: async () => {}, close: async () => {}, events: (async function* () {})(),
        turn: async () => ({ text: 'REINS: done', events: [{ type: 'hook', event: 'PreToolUse', tool: 'Edit', decision: 'deny', reason: 'r' }] }),
      }),
    };
    const run = new Run({ workflow: wf('## phase one\n> first'), engine });
    await drive(run);
    expect(run.getEvents().find((e) => e.type === 'hook')?.data).toMatchObject({ event: 'PreToolUse', decision: 'deny' });
  });
});
