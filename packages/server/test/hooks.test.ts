// The hook endpoint Claude calls (plan 15b 2.3): token, Host, deny, cards, approvals.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { EngineEvent, Policy } from '@reins/core';
import { startHookServer } from '../src/hooks.js';
import { newNonce, wrapCard, trustNote } from '../src/claude/cards.js';

type Srv = Awaited<ReturnType<typeof startHookServer>>;
let srv: Srv | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

function post(url: string, body: unknown, host?: string): Promise<{ status: number; json: any }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', ...(host ? { host } : {}) } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : undefined }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function start(over: { policy?: Policy | (() => Policy); cards?: string[]; approve?: (r: any) => any } = {}) {
  const events: EngineEvent[] = [];
  const cards = over.cards ?? [];
  const approvals: any[] = [];
  const nonce = newNonce();
  srv = await startHookServer({
    cwd: 'D:\\coding\\reins-scratch',
    policy: typeof over.policy === 'function' ? over.policy : () => (over.policy as Policy | undefined) ?? { mode: 'write', guards: ['migrations/**'], allowShell: true },
    pendingCards: () => cards.splice(0),
    nonce,
    onApprove: async (r) => { approvals.push(r); return over.approve ? over.approve(r) : { behavior: 'allow' }; },
    onEvent: (e) => events.push(e),
  });
  return { srv, events, cards, approvals, nonce };
}

const preEdit = (file_path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path } });

describe('hook endpoint', () => {
  it('binds to 127.0.0.1 with a random 32-byte token in the path', async () => {
    const a = await start();
    const url = new URL(a.srv.hookUrl);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toMatch(/^\/hook\/[0-9a-f]{64}$/);
    const other = await startHookServer({ cwd: '.', policy: () => ({ mode: 'write', guards: [], allowShell: true }), pendingCards: () => [], nonce: 'x', onApprove: async () => ({ behavior: 'allow' }), onEvent: () => {} });
    expect(other.hookUrl).not.toBe(a.srv.hookUrl);
    await other.close();
  });

  it('rejects a wrong token and a wrong Host, and never consults the policy', async () => {
    let asked = 0;
    const events: EngineEvent[] = [];
    srv = await startHookServer({ cwd: '.', policy: () => { asked++; return { mode: 'read-only', guards: [], allowShell: true }; }, pendingCards: () => [], nonce: 'n', onApprove: async () => ({ behavior: 'allow' }), onEvent: (e) => events.push(e) });
    const bad = srv.hookUrl.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
    expect((await post(bad, preEdit('a'))).status).toBe(403);
    const port = new URL(srv.hookUrl).port;
    expect((await post(srv.hookUrl, preEdit('a'), `evil.example:${port}`)).status).toBe(403);
    expect((await post(srv.hookUrl, preEdit('a'), `localhost:${port}`)).status).toBe(403);
    expect(asked).toBe(0);
    expect((await post(srv.hookUrl, preEdit('a'))).status).toBe(200);
    expect(asked).toBe(1);
  });

  it('PreToolUse: denies a guarded Windows path with the reason, passes others with {}', async () => {
    const a = await start();
    const deny = await post(a.srv.hookUrl, preEdit('D:\\coding\\reins-scratch\\migrations\\0001.sql'));
    expect(deny.json).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('migrations/0001.sql is guarded') } });
    const pass = await post(a.srv.hookUrl, preEdit('D:\\coding\\reins-scratch\\src\\upload.mjs'));
    expect(pass.json).toEqual({});
    expect(a.events).toEqual([
      expect.objectContaining({ type: 'hook', event: 'PreToolUse', tool: 'Edit', decision: 'deny' }),
      expect.objectContaining({ type: 'hook', event: 'PreToolUse', tool: 'Edit', decision: 'allow' }),
    ]);
  });

  it('PreToolUse reads the policy live, per call', async () => {
    let p: Policy = { mode: 'read-only', guards: [], allowShell: true };
    const events: EngineEvent[] = [];
    srv = await startHookServer({ cwd: '.', policy: () => p, pendingCards: () => [], nonce: 'n', onApprove: async () => ({ behavior: 'allow' }), onEvent: (e) => events.push(e) });
    expect((await post(srv.hookUrl, preEdit('a.ts'))).json.hookSpecificOutput.permissionDecision).toBe('deny');
    p = { mode: 'write', guards: [], allowShell: true };
    expect((await post(srv.hookUrl, preEdit('a.ts'))).json).toEqual({});
  });

  it('PostToolUse: drains steer cards once, each wrapped in the session nonce marker', async () => {
    const a = await start({ cards: ['PINEAPPLE', 'second card'] });
    const r = await post(a.srv.hookUrl, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
    const ctx: string = r.json.hookSpecificOutput.additionalContext;
    expect(r.json.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(ctx).toContain(wrapCard('PINEAPPLE', a.nonce));
    expect(ctx).toContain(wrapCard('second card', a.nonce));
    expect((await post(a.srv.hookUrl, { hook_event_name: 'PostToolUse', tool_name: 'Read' })).json).toEqual({});
    expect(a.events.filter((e) => e.type === 'card_delivered')).toEqual([
      { type: 'card_delivered', card: 'PINEAPPLE', channel: 'mid-turn' },
      { type: 'card_delivered', card: 'second card', channel: 'mid-turn' },
    ]);
    expect(a.events.filter((e) => e.type === 'hook')).toHaveLength(2);
  });

  it('PostToolUse keeps additionalContext under the 10,000 character limit', async () => {
    const a = await start({ cards: ['x'.repeat(20_000)] });
    const r = await post(a.srv.hookUrl, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
    expect(r.json.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
  });

  it('/approve asks onApprove and answers in the permission-prompt-tool shape', async () => {
    const a = await start({ approve: (r) => (r.tool === 'PowerShell' ? { behavior: 'deny', message: 'not now' } : { behavior: 'allow' }) });
    const allow = await post(a.srv.approveUrl, { tool_name: 'Edit', input: { file_path: 'x' }, tool_use_id: 't1' });
    expect(allow.json).toEqual({ behavior: 'allow', updatedInput: { file_path: 'x' } });
    const deny = await post(a.srv.approveUrl, { tool_name: 'PowerShell', input: { command: 'rm -r .' }, tool_use_id: 't2' });
    expect(deny.json).toEqual({ behavior: 'deny', message: 'not now' });
    expect(a.approvals).toEqual([{ tool: 'Edit', input: { file_path: 'x' } }, { tool: 'PowerShell', input: { command: 'rm -r .' } }]);
    expect(a.events.filter((e) => e.type === 'hook').map((e: any) => [e.event, e.decision])).toEqual([['approve', 'allow'], ['approve', 'deny']]);
  });

  it('/approve re-checks the policy first, so a guard can never be approved past', async () => {
    const a = await start();
    const r = await post(a.srv.approveUrl, { tool_name: 'Write', input: { file_path: 'D:\\coding\\reins-scratch\\migrations\\2.sql' } });
    expect(r.json.behavior).toBe('deny');
    expect(a.approvals).toHaveLength(0);
  });
});

describe('card marker', () => {
  it('each session gets a fresh 128-bit nonce', () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
  it('the card and the trust note carry the same nonce marker', () => {
    const n = newNonce();
    const card = wrapCard('hello', n);
    expect(card.startsWith(`[REINS CARD ${n}`)).toBe(true);
    expect(card.endsWith(`[/REINS CARD ${n}]`)).toBe(true);
    const note = trustNote(n);
    expect(note).toContain(card.split('\n')[0]);
    expect(note).toContain(`[/REINS CARD ${n}]`);
    expect(note).toMatch(/any other code|without the code/i);
  });
});

describe('hook endpoint fails closed (reviewer)', () => {
  // Claude runs the tool anyway when a hook answers non-2xx, so an internal error must become a deny.
  it('a policy that throws denies the tool with a 200 reply', async () => {
    const { srv, events } = await start({ policy: (() => { throw new Error('boom'); }) as any });
    const r = await post(srv.hookUrl, preEdit('D:\\coding\\reins-scratch\\src\\upload.mjs'));
    expect(r.status).toBe(200);
    expect(r.json.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(events.some((e: any) => e.type === 'hook' && e.decision === 'deny')).toBe(true);
  });
  it('an unparseable body gets a 200, never a non-2xx that Claude would treat as a pass', async () => {
    const { srv } = await start();
    const u = new URL(srv.hookUrl);
    const r: any = await new Promise((resolve) => {
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST' }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.end('{not json');
    });
    expect(r.status).toBe(200);
  });
});
