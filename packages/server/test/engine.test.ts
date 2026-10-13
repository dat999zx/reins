// The Claude adapter against fake-claude (plan 15b 2.3, 2.8): no real claude, no cost.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import type { EngineEvent, Policy } from '@reins/core';
import { claudeEngine, modelCosts, turnCost } from '../src/claude/engine.js';
import { FAKE_CLAUDE, fakeSetup, alive, until } from './helpers.js';

const write: Policy = { mode: 'write', guards: ['migrations/**'], allowShell: true };

function engine(over: { approve?: (r: any) => any; live?: EngineEvent[]; interruptTimeoutMs?: number } = {}) {
  return claudeEngine({
    bin: FAKE_CLAUDE,
    model: 'sonnet',
    effort: 'medium',
    onApprove: async (r) => (over.approve ? over.approve(r) : { behavior: 'allow' }),
    onLive: (e) => over.live?.push(e),
    ...(over.interruptTimeoutMs ? { interruptTimeoutMs: over.interruptTimeoutMs } : {}),
  });
}

describe('claude adapter', () => {
  it('starts claude with the Phase 0 flags, as files, and runs turns in one session', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-turns.jsonl', turn: 0 }, { fixture: 'claude-2.1.281-turns.jsonl', turn: 1 }, { fixture: 'claude-2.1.281-turns.jsonl', turn: 2 }]);
    const s = await engine().open({ cwd: f.dir, policy: () => write });
    const r1 = await s.turn('one');
    const r2 = await s.turn('two');
    const r3 = await s.turn('three');
    await s.close();
    expect([r1.text, r2.text, r3.text]).toEqual(['ONE', 'TWO', 'THREE']);
    // The stream reports a cumulative cost; each turn reports its own share.
    expect(r1.cost).toBeCloseTo(0.0640898);
    expect(r2.cost).toBeCloseTo(0.0802364 - 0.0640898);
    expect(r3.cost).toBeCloseTo(0.0871622 - 0.0802364);

    const args: string[] = f.log()[0].args;
    for (const flag of ['-p', '--verbose', '--settings', '--mcp-config', '--append-system-prompt-file']) expect(args).toContain(flag);
    expect(args.join(' ')).toContain('--input-format stream-json --output-format stream-json');
    expect(args[args.indexOf('--session-id') + 1]).toBe(s.sessionId);
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__reins__approve');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(f.log().filter((l) => l.kind === 'user').map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });

  it('writes HTTP hooks for 127.0.0.1 with a per-run token, and a trust note with a per-session nonce', async () => {
    const f = fakeSetup([]);
    const e = engine();
    const a = await e.open({ cwd: f.dir, policy: () => write });
    const b = await e.open({ cwd: f.dir, policy: () => write });
    await until(() => f.log().filter((l) => l.kind === 'args').length === 2);
    await a.close();
    await b.close();
    const [la, lb] = f.log().filter((l) => l.kind === 'args');
    const urlA: string = la.settings.hooks.PreToolUse[0].hooks[0].url;
    expect(la.settings.hooks.PreToolUse[0].hooks[0].type).toBe('http');
    expect(urlA).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]{64}$/);
    expect(la.settings.hooks.PreToolUse[0].matcher.split('|')).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'Bash', 'PowerShell']));
    expect(urlA).not.toBe(lb.settings.hooks.PreToolUse[0].hooks[0].url);
    const nonceA = /\[REINS CARD ([0-9a-f]{32}) /.exec(la.note)![1];
    const nonceB = /\[REINS CARD ([0-9a-f]{32}) /.exec(lb.note)![1];
    expect(nonceA).not.toBe(nonceB);
  });

  it('a guard refusal comes back in the turn events, with the hook call logged', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-hook-deny.jsonl' }]);
    const s = await engine().open({ cwd: f.dir, policy: () => write });
    const r = await s.turn('add a column');
    await s.close();
    const refusal = r.events!.find((e) => e.type === 'refusal') as { reason: string };
    expect(refusal.reason).toContain('migrations/0001.sql is guarded');
    expect(r.events!.some((e) => e.type === 'hook' && e.event === 'PreToolUse' && e.decision === 'deny')).toBe(true);
    const types = r.events!.map((e) => e.type);
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('refusal'));
  });

  it('a steer card goes out at the next PostToolUse, wrapped in this session\'s nonce marker', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-card-marker-hook.jsonl' }]);
    const cards = ['End your answer with PINEAPPLE.'];
    const s = await engine().open({ cwd: f.dir, policy: () => write, pendingCards: () => cards.splice(0) });
    const r = await s.turn('read three files');
    await s.close();
    const nonce = /\[REINS CARD ([0-9a-f]{32}) /.exec(f.log()[0].note)![1];
    const withCtx = f.log().filter((l) => l.kind === 'hook' && l.response.hookSpecificOutput?.additionalContext);
    expect(withCtx).toHaveLength(1);
    expect(withCtx[0].response.hookSpecificOutput.additionalContext).toContain(`[REINS CARD ${nonce} `);
    expect(withCtx[0].response.hookSpecificOutput.additionalContext).toContain('PINEAPPLE');
    expect(r.events).toContainEqual({ type: 'card_delivered', card: cards[0] ?? 'End your answer with PINEAPPLE.', channel: 'mid-turn' });
  });

  it('compact: /compact goes out as a user line, ends in a compacted event with no usage, and the process lives on', async () => {
    const COMPACT = 'claude-2.1.293-compact.jsonl';
    const f = fakeSetup([{ fixture: COMPACT, turn: 0 }], 10, { compact: COMPACT });
    const s = await engine().open({ cwd: f.dir, policy: () => write });
    const first = await s.turn('remember');
    const r = await s.compact!();
    expect(r.events).toContainEqual({ type: 'compacted', trigger: 'manual', before: 34469, after: 4795 });
    expect(r.events!.some((e) => e.type === 'usage')).toBe(false);
    expect(r.isError).toBe(false);
    expect(r.total).toBeCloseTo(0.00962756);
    expect(r.cost).toBeCloseTo(0.00962756 - 0.0068948);
    expect(first.total).toBeCloseTo(0.0068948);
    const users = f.log().filter((l) => l.kind === 'user').map((l) => l.text);
    expect(users).toEqual(['remember', '/compact']);
    expect((await s.turn('and now')).isError).toBe(false);
    await s.close();
  });

  it('interrupt: a control_request ends the turn, and the session takes the next turn', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-card-marker-hook.jsonl' }, { fixture: 'claude-2.1.281-interrupt-ctl.jsonl', turn: 1 }], 100);
    const live: EngineEvent[] = [];
    const s = await engine({ live }).open({ cwd: f.dir, policy: () => write });
    const turn = s.turn('slow');
    await until(() => live.some((e) => e.type === 'tool_call'));
    const t = Date.now();
    await s.interrupt();
    const r = await turn;
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(r.text).toBe('');
    expect(r.isError).toBe(false); // the interrupt asked for the error result
    expect(f.log().some((l) => l.kind === 'interrupt')).toBe(true);
    expect((await s.turn('after')).text).toBe('AFTER');
    await s.close();
  });

  it('interrupt with no result in time kills the process tree and marks the session dead', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-card-marker-hook.jsonl', ignoreInterrupt: true }], 400);
    const live: EngineEvent[] = [];
    const s = await engine({ live, interruptTimeoutMs: 500 }).open({ cwd: f.dir, policy: () => write });
    const turn = s.turn('slow');
    await until(() => live.some((e) => e.type === 'tool_call'));
    await s.interrupt();
    const r = await turn;
    expect(r.events!.some((e) => e.type === 'error')).toBe(true);
    const pid = f.log()[0].pid;
    await until(() => !alive(pid));
    await expect(s.turn('again')).rejects.toThrow(/dead|exited/);
    await s.close();
  });

  it('approvals go through the MCP server to onApprove; a deny reaches the agent', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-approval-allow-hold.jsonl', approve: true }, { fixture: 'claude-2.1.281-approval-deny.jsonl', approve: true }]);
    const asked: any[] = [];
    let answer: any = { behavior: 'allow' };
    const s = await engine({ approve: (r) => { asked.push(r); return answer; } }).open({ cwd: f.dir, policy: () => write });
    const r1 = await s.turn('edit it');
    answer = { behavior: 'deny', message: 'not today' };
    const r2 = await s.turn('edit it again');
    await s.close();
    expect(asked.map((a) => a.tool)).toEqual(['Edit', 'Edit']);
    expect(asked[0].input.file_path).toMatch(/upload\.mjs$/);
    expect(r1.events!.some((e) => e.type === 'hook' && e.event === 'approve' && e.decision === 'allow')).toBe(true);
    expect(r2.events!.some((e) => e.type === 'hook' && e.event === 'approve' && e.decision === 'deny')).toBe(true);
    expect(f.log().filter((l) => l.kind === 'approve').map((l) => l.decision)).toEqual([
      { behavior: 'allow', updatedInput: asked[0].input },
      { behavior: 'deny', message: 'not today' },
    ]);
  });

  it('resume passes --resume with the saved session id', async () => {
    const f = fakeSetup([]);
    const s = await engine().open({ cwd: f.dir, sessionId: '11111111-2222-3333-4444-555555555555', policy: () => write });
    await s.turn('hi');
    await s.close();
    const args: string[] = f.log()[0].args;
    expect(args[args.indexOf('--resume') + 1]).toBe('11111111-2222-3333-4444-555555555555');
    expect(args).not.toContain('--session-id');
    expect(s.sessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('close ends the process and removes the temp files', async () => {
    const f = fakeSetup([]);
    const s = await engine().open({ cwd: f.dir, policy: () => write });
    await until(() => f.log().length > 0);
    const { pid, args } = f.log()[0];
    await s.close();
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(args[args.indexOf('--settings') + 1])).toBe(false);
  });

  it('turnCost: the share of a running total; a total that went down is a new count', () => {
    expect(turnCost(0.08, 0.064)).toBeCloseTo(0.016);
    expect(turnCost(0.01, 0.064)).toBe(0.01);
    expect(turnCost(0.064, 0)).toBe(0.064);
  });

  it('a turn reports the parent context (usage) live and in its events, and the raw total', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-turns.jsonl', turn: 0 }]);
    const live: EngineEvent[] = [];
    const s = await engine({ live }).open({ cwd: f.dir, policy: () => write });
    const r = await s.turn('one');
    await s.close();
    const usage = { type: 'usage', model: 'claude-sonnet-5', used: 30550, window: 1000000 };
    expect(live).toContainEqual(usage);
    expect(r.events).toContainEqual(usage);
    expect(r.total).toBeCloseTo(0.0640898);
    expect(r.isError).toBe(false);
  });

  it('a resumed process counts its turn from the baseline it was given', async () => {
    const t0 = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
    const f = fakeSetup([t0], 10, { cumulative: true });
    const first = await engine().open({ cwd: f.dir, policy: () => write });
    const r1 = await first.turn('one');
    await first.close();
    expect(r1.cost).toBeCloseTo(0.0640898);

    const second = await engine().open({ cwd: f.dir, sessionId: first.sessionId, costBase: r1.total, policy: () => write });
    const r2 = await second.turn('two');
    await second.close();
    const args: string[] = f.log().filter((l) => l.kind === 'args')[1].args;
    expect(args[args.indexOf('--resume') + 1]).toBe(first.sessionId);
    expect(r2.total).toBeCloseTo(0.1281796);
    expect(r2.cost).toBeCloseTo(0.0640898);
  });

  it('a resumed process with no baseline has no cost for its first turn, but a total', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-turns.jsonl', turn: 0 }], 10, { cumulative: true });
    const first = await engine().open({ cwd: f.dir, policy: () => write });
    await first.turn('one');
    await first.close();
    const second = await engine().open({ cwd: f.dir, sessionId: first.sessionId, policy: () => write });
    const r2 = await second.turn('two');
    await second.close();
    expect(r2.cost).toBeUndefined();
    expect(r2.total).toBeCloseTo(0.1281796);
  });

  describe('cost per model (C)', () => {
    const sum = (m?: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
    const T0 = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
    const T1 = { fixture: 'claude-2.1.281-turns.jsonl', turn: 1 };
    const open = (dir: string, o: { model: string; sessionId?: string; costBase?: number; costBaseByModel?: Record<string, number> }) =>
      engine().open({ cwd: dir, policy: () => write, ...o });

    it('modelCosts: a model with no new spend is left out; a total that went down is a new count', () => {
      expect(modelCosts({ a: 0.5, b: 0.25 }, { a: 0.5 })).toEqual({ b: 0.25 });
      expect(modelCosts({ a: 0.75 }, { a: 0.5 })).toEqual({ a: 0.25 });
      expect(modelCosts({ a: 0.1 }, { a: 0.5 })).toEqual({ a: 0.1 });
    });

    it('one process: each reply carries its own share and the running total of its model', async () => {
      const f = fakeSetup([T0, T1], 10, { cumulative: true });
      const s = await open(f.dir, { model: 'a' });
      const r1 = await s.turn('one');
      const r2 = await s.turn('two');
      await s.close();
      expect(r1.models!.a).toBeCloseTo(0.0640898, 9);
      expect(r1.totals!.a).toBeCloseTo(0.0640898, 9);
      expect(sum(r1.models)).toBeCloseTo(r1.cost!, 9);
      expect(r2.models!.a).toBeCloseTo(0.0802364 - 0.0640898, 9);
      expect(r2.totals!.a).toBeCloseTo(0.0802364, 9);
      expect(sum(r2.models)).toBeCloseTo(r2.cost!, 9);
    });

    it('a switch: the resumed process on another model counts only that model, and the shares add up to the cost', async () => {
      const f = fakeSetup([T0, T1], 10, { cumulative: true });
      const first = await open(f.dir, { model: 'a' });
      await first.turn('one');
      const r2 = await first.turn('two');
      await first.close();

      const second = await open(f.dir, { model: 'b', sessionId: first.sessionId, costBase: r2.total, costBaseByModel: r2.totals });
      const r3 = await second.turn('three');
      await second.close();
      const args: string[] = f.log().filter((l) => l.kind === 'args')[1].args;
      expect(args[args.indexOf('--model') + 1]).toBe('b');
      expect(Object.keys(r3.models!)).toEqual(['b']);
      expect(r3.models!.b).toBeCloseTo(0.0640898, 9);
      expect(r3.cost).toBeCloseTo(0.0640898, 9);
      expect(sum(r3.models)).toBeCloseTo(r3.cost!, 9);
      expect(r3.totals!.a).toBeCloseTo(0.0802364, 9);
      expect(r3.totals!.b).toBeCloseTo(0.0640898, 9);
      expect(r3.total).toBeCloseTo(0.0802364 + 0.0640898, 9);
    });

    it('the usage event names the model the reply ran on, matching the dollars', async () => {
      const f = fakeSetup([T0], 10, { cumulative: true });
      const s = await open(f.dir, { model: 'a' });
      const r = await s.turn('one');
      await s.close();
      expect(r.events!.find((e) => e.type === 'usage')).toMatchObject({ model: 'a' });
      expect(Object.keys(r.models!)).toEqual(['a']);
    });

    it('a resumed process with no per-model base has no split for its first reply, then a split', async () => {
      const f = fakeSetup([T0, T1], 10, { cumulative: true });
      const first = await open(f.dir, { model: 'a' });
      const r1 = await first.turn('one');
      await first.close();

      const second = await open(f.dir, { model: 'a', sessionId: first.sessionId, costBase: r1.total });
      const r2 = await second.turn('two');
      const r3 = await second.turn('three');
      await second.close();
      expect(r2.cost).toBeCloseTo(0.0640898, 9);
      expect(r2.models).toBeUndefined();
      expect(r2.totals!.a).toBeCloseTo(0.0640898 * 2, 9);
      expect(r3.models!.a).toBeCloseTo(0.0802364 - 0.0640898, 9);
      expect(sum(r3.models)).toBeCloseTo(r3.cost!, 9);
    });

    it('a result with a total and no modelUsage: that reply and the next have no split, the one after is split', async () => {
      const f = fakeSetup([{ ...T0, noModelUsage: true }, T1, T0], 10, { cumulative: true });
      const s = await open(f.dir, { model: 'a' });
      const r1 = await s.turn('one');
      const r2 = await s.turn('two');
      const r3 = await s.turn('three');
      await s.close();
      expect(r1.total).toBeCloseTo(0.0640898, 9);
      expect(r1.totals).toBeUndefined();
      expect(r1.models).toBeUndefined();
      expect(r2.cost).toBeCloseTo(0.0802364 - 0.0640898, 9);
      expect(r2.models).toBeUndefined();
      expect(r2.totals!.a).toBeCloseTo(0.0802364, 9);
      expect(r3.models!.a).toBeCloseTo(0.0640898, 9);
      expect(sum(r3.models)).toBeCloseTo(r3.cost!, 9);
    });

    it('a split that does not add up to the reply cost is not given: a model that dropped out and came back', async () => {
      const f = fakeSetup([
        { ...T0, modelUsage: { a: 0.04, b: 0.0240898 } },
        { ...T1, modelUsage: { a: 0.0561466 } },
        { ...T0, modelUsage: { a: 0.0561466, b: 0.0881796 } },
      ], 10, { cumulative: true });
      const s = await open(f.dir, { model: 'a' });
      const r1 = await s.turn('one');
      const r2 = await s.turn('two');
      const r3 = await s.turn('three');
      await s.close();
      expect(sum(r1.models)).toBeCloseTo(r1.cost!, 9);
      expect(Object.keys(r1.models!).sort()).toEqual(['a', 'b']);
      expect(r2.cost).toBeCloseTo(0.0161466, 9);
      expect(sum(r2.models)).toBeCloseTo(r2.cost!, 9);
      expect(r3.cost).toBeCloseTo(0.0640898, 9);
      expect(r3.models).toBeUndefined();
    });

    it('an interrupt kill is no result: it carries neither a split nor totals', async () => {
      const f = fakeSetup([{ fixture: 'claude-2.1.281-card-marker-hook.jsonl', ignoreInterrupt: true }], 400, { cumulative: true });
      const live: EngineEvent[] = [];
      const s = await claudeEngine({ bin: FAKE_CLAUDE, model: 'a', onApprove: async () => ({ behavior: 'allow' }), onLive: (e) => live.push(e), interruptTimeoutMs: 500 })
        .open({ cwd: f.dir, policy: () => write });
      const turn = s.turn('slow');
      await until(() => live.some((e) => e.type === 'tool_call'));
      await s.interrupt();
      const r = await turn;
      await s.close();
      expect(r.models).toBeUndefined();
      expect(r.totals).toBeUndefined();
    });
  });

  it('an interrupt kill ends the turn with no cost and no total', async () => {
    const f = fakeSetup([{ fixture: 'claude-2.1.281-card-marker-hook.jsonl', ignoreInterrupt: true }], 400);
    const live: EngineEvent[] = [];
    const s = await engine({ live, interruptTimeoutMs: 500 }).open({ cwd: f.dir, policy: () => write });
    const turn = s.turn('slow');
    await until(() => live.some((e) => e.type === 'tool_call'));
    await s.interrupt();
    const r = await turn;
    await s.close();
    expect(r.cost).toBeUndefined();
    expect(r.total).toBeUndefined();
  });

  it('probe: version and login come from the CLI\'s own output', async () => {
    fakeSetup([]);
    const p = await engine().probe();
    expect(p).toMatchObject({ installed: true, version: '2.1.281', loggedIn: true, capabilities: { preToolDeny: true, midTurnSteer: 'hook', resume: true } });
    expect(p.problems).toEqual([]);
    const missing = await claudeEngine({ bin: '', onApprove: async () => ({ behavior: 'deny' }) }).probe();
    expect(missing.installed).toBe(false);
    expect(missing.problems[0]).toMatch(/claude/i);
  });
});
