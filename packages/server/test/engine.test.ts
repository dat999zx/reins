// The Claude adapter against fake-claude (plan 15b 2.3, 2.8): no real claude, no cost.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import type { EngineEvent, Policy } from '@reins/core';
import { claudeEngine } from '../src/claude/engine.js';
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
