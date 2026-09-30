// The Phase 3b exit test (plan 15d 3b.8 lines 1609-1620, 13 line 677): the eleven checks over real HTTP,
// with fake-claude behind the real claudeEngine. Assertions are on session_log and on what the fake saw.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { until } from './helpers.js';
import { askedQuestion, boot, cleanup, tmpDir, type World } from './http-helpers.js';

afterEach(cleanup);

const T = 20_000;
const TURNS = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
const APPROVAL = 'claude-2.1.281-approval-allow-hold.jsonl';
const HOOK_DENY = 'claude-2.1.281-hook-deny.jsonl';
const MARKER = 'claude-2.1.281-card-marker-hook.jsonl';
const DONE = 'REINS: done';

const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n';
const ECHO = `${FRONT}## run \`echo hi\`\n\n## phase go\n> do it\n`;
const WITH_BLOCK = `${FRONT}## use rp\n\n## gate\nuntil: you approve\n\n## phase go\n> do it\n`;
const RP = '---\nreins: 1\nblock: rp\n---\n\n## run `echo one`\n';
const put = (dir: string, name: string, text: string) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

const fakeUsers = (w: World) => w.fake.log().filter((e) => e.kind === 'user');
const fakeArgs = (w: World) => w.fake.log().filter((e) => e.kind === 'args');
const engineRows = (w: World, id: string) => w.rows(id, 'engine').map((r) => r.data as { type: string; reason?: string; channel?: string });
const receipts = (w: World, id: string, n: number) => until(() => w.rows(id, 'receipt').length >= n);

describe('Phase 3b exit test (spec 3b.8)', () => {
  it('1. a plain message is a plain turn with no Reins header', async () => {
    const w = await boot([TURNS]);
    const id = await w.session();
    expect((await w.say(id, 'what does upload.mjs do?')).status).toBe(200);
    await w.settled(id, 1);
    const seen = fakeUsers(w);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0].text)).toContain('what does upload.mjs do?');
    expect(JSON.stringify(seen[0].text)).not.toContain('REINS');
    expect(w.rows(id, 'run_started')).toEqual([]);
  }, T);

  it('2. a tool call raises a question, n <reason> denies it, and with auto-approve on the next one never asks', async () => {
    const w = await boot([{ fixture: APPROVAL, approve: true }, { fixture: APPROVAL, approve: true }]);
    const id = await w.session();
    await w.say(id, 'change upload');
    const q = await askedQuestion(w.store, id, 'tool');
    expect((await w.answer(id, q.id, 'n no way')).status).toBe(200);
    await w.settled(id, 1);
    expect((await w.post(id, 'settings', { autoApprove: true })).status).toBe(200);
    await w.say(id, 'change it again');
    await w.settled(id, 2);
    const decisions = w.fake.log().filter((e) => e.kind === 'approve').map((e) => e.decision);
    expect(decisions.map((d) => d.behavior)).toEqual(['deny', 'allow']);
    expect(decisions[0].message).toContain('no way');
    // both questions are logged (spec 1418); the second is answered y at once by auto-approve
    const asked = w.rows(id, 'question').map((r) => (r.data as { id: string }).id);
    expect(asked).toHaveLength(2);
    expect(w.rows(id, 'answer').map((r) => r.data)).toEqual([{ questionId: asked[0], answer: 'n no way' }, { questionId: asked[1], answer: 'y' }]);
    const rows = w.store.readLog(id);
    const at = rows.findIndex((r) => r.type === 'settings');
    expect(at).toBeGreaterThan(0);
    expect(rows.slice(at).some((r) => r.type === 'status' && (r.data as { status: string }).status === 'waiting')).toBe(false);
  }, T);

  it('3. #read-only blocks an edit: a refusal in the log, and the hook denied it', async () => {
    const w = await boot([{ fixture: APPROVAL, text: DONE }]);
    const id = await w.session();
    expect((await w.say(id, 'edit upload.mjs', [{ tag: 'read-only' }])).status).toBe(200);
    await receipts(w, id, 1);
    const refusal = engineRows(w, id).find((e) => e.type === 'refusal');
    expect(refusal?.reason).toContain('read-only');
    const pre = w.fake.log().find((e) => e.kind === 'hook' && e.event === 'PreToolUse' && e.tool === 'Edit');
    expect(pre.response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(w.rows(id, 'message')[0]!.data).toEqual({ role: 'user', text: 'edit upload.mjs', tags: [{ tag: 'read-only' }] });
  }, T);

  it('4. #guard migrations/** blocks a migrations edit', async () => {
    const w = await boot([{ fixture: HOOK_DENY, text: DONE }]);
    const id = await w.session();
    expect((await w.say(id, 'add a column', [{ tag: 'guard', arg: 'migrations/**' }])).status).toBe(200);
    await receipts(w, id, 1);
    const refusal = engineRows(w, id).find((e) => e.type === 'refusal');
    expect(refusal?.reason).toContain('migrations/0001.sql is guarded');
  }, T);

  it('5. #gate pauses with a gate question, and approve goes on', async () => {
    const w = await boot([{ ...TURNS, text: DONE }]);
    const id = await w.session();
    expect((await w.say(id, 'go', [{ tag: 'gate' }])).status).toBe(200);
    const q = await askedQuestion(w.store, id, 'gate');
    expect(w.rows(id, 'run_finished')).toEqual([]);
    expect((await w.answer(id, q.id, 'approve')).status).toBe(200);
    await receipts(w, id, 1);
    expect(w.rows(id, 'run_finished')).toHaveLength(1);
    expect(w.rows(id, 'answer').map((r) => r.data)).toEqual([{ questionId: q.id, answer: 'approve' }]);
  }, T);

  it('6. a steer card sent mid-turn is delivered mid-turn', async () => {
    const w = await boot([{ fixture: MARKER, delayMs: 150 }]);
    const id = await w.session();
    await w.say(id, 'read three files');
    await until(() => engineRows(w, id).some((e) => e.type === 'tool_call'));
    expect((await w.card(id, 'End your answer with PINEAPPLE.', 'steer')).status).toBe(200);
    await w.settled(id, 1);
    expect(engineRows(w, id).filter((e) => e.type === 'card_delivered' && e.channel === 'mid-turn')).toHaveLength(1);
    const post = w.fake.log().filter((e) => e.kind === 'hook' && e.event === 'PostToolUse');
    expect(post.some((e) => JSON.stringify(e.response).includes('PINEAPPLE'))).toBe(true);
    expect(w.rows(id, 'message')).toHaveLength(1);
    expect(w.rows(id, 'cards_unsent')).toEqual([]);
  }, T);

  it('7. two sessions run side by side and their logs do not mix', async () => {
    const w = await boot([TURNS]);
    const a = await w.session();
    const b = await w.session();
    await Promise.all([w.say(a, 'alpha one'), w.say(b, 'beta one')]);
    await Promise.all([w.settled(a, 1), w.settled(b, 1)]);
    await w.say(a, 'alpha two');
    await w.settled(a, 2);
    const texts = (id: string) => w.rows(id, 'message').map((r) => (r.data as { text: string }).text);
    expect(texts(a)).toEqual(['alpha one', 'alpha two']);
    expect(texts(b)).toEqual(['beta one']);
    for (const id of [a, b]) {
      const seqs = w.store.readLog(id).map((r) => r.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
    const ea = w.store.getSession(a)!.engineSessionId;
    const eb = w.store.getSession(b)!.engineSessionId;
    expect(ea).toEqual(expect.any(String));
    expect(eb).toEqual(expect.any(String));
    expect(ea).not.toBe(eb);
    const given = fakeArgs(w).map((e) => e.args[e.args.indexOf('--session-id') + 1]);
    expect(new Set(given)).toEqual(new Set([ea, eb]));
  }, T);

  it('8. after a restart the session list and history are back, and the next message spawns claude with --resume', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const w1 = await boot([TURNS], { store: openStore(file), dir });
    const id = await w1.session({ title: 'Named' });
    await w1.say(id, 'before the restart');
    await w1.settled(id, 1);
    const before = w1.store.readLog(id);
    const engineId = w1.store.getSession(id)!.engineSessionId!;
    await w1.srv.close();
    w1.store.close();

    const w2 = await boot([], { store: openStore(file), dir, fake: w1.fake });
    const state = (await w2.api('GET', '/api/state')).json;
    expect(state.sessions.map((s: { id: string; title?: string }) => [s.id, s.title])).toEqual([[id, 'Named']]);
    const log = (await w2.api('GET', `/api/sessions/${id}/log`)).json.rows;
    expect(log.slice(0, before.length)).toEqual(before);
    await w2.say(id, 'after the restart');
    await w2.settled(id, 2);
    const spawns = fakeArgs(w2);
    expect(spawns).toHaveLength(2);
    expect(spawns[0].args).toContain('--session-id');
    expect(spawns[1].args[spawns[1].args.indexOf('--resume') + 1]).toBe(engineId);
    expect(spawns[1].args).not.toContain('--session-id');
  }, T);

  it('9. a workflow file with a command gets a trust question; after y the same file runs with no question', async () => {
    const w = await boot([{ ...TURNS, text: DONE }, { ...TURNS, text: DONE }]);
    const id = await w.session();
    const file = put(w.cwd, 'a.reins.md', ECHO);
    expect((await w.post(id, 'run', { path: file })).status).toBe(200);
    const q = await askedQuestion(w.store, id, 'trust');
    expect(q.detail).toBe('echo hi\nnpm test');
    expect(w.rows(id, 'run_started')).toEqual([]);
    expect(w.fake.log()).toEqual([]);
    expect((await w.answer(id, q.id, 'y')).status).toBe(200);
    await until(() => w.rows(id, 'run_finished').length === 1);
    await w.settled(id, 0);
    expect((await w.post(id, 'run', { path: file })).status).toBe(200);
    await until(() => w.rows(id, 'run_finished').length === 2);
    expect(w.rows(id, 'question').filter((r) => (r.data as { kind: string }).kind === 'trust')).toHaveLength(1);
  }, T);

  it('10. after a restart a run from a workflow file that was detached at a gate resumes and finishes', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const w1 = await boot([{ ...TURNS, text: DONE }], { store: openStore(file), dir });
    const id = await w1.session();
    put(w1.cwd, 'blocks/rp.reins.md', RP);
    expect((await w1.post(id, 'run', { path: put(w1.cwd, 'a.reins.md', WITH_BLOCK) })).status).toBe(200);
    await w1.answer(id, (await askedQuestion(w1.store, id, 'trust')).id, 'y');
    await askedQuestion(w1.store, id, 'gate');
    const runId = w1.rows(id, 'run_started')[0]!.runId!;
    await w1.srv.close();
    w1.store.close();

    const w2 = await boot([], { store: openStore(file), dir, fake: w1.fake });
    expect(w2.rows(id, 'run_detached').map((r) => r.runId)).toEqual([runId]);
    expect(w2.rows(id, 'run_finished')).toEqual([]);
    expect((await w2.post(id, 'resume', { runId })).status).toBe(200);
    const q = await askedQuestion(w2.store, id, 'gate');
    expect((await w2.answer(id, q.id, 'approve')).status).toBe(200);
    await until(() => w2.rows(id, 'run_finished').length === 1);
    await receipts(w2, id, 1);
    expect(w2.rows(id, 'receipt')).toHaveLength(1);
  }, T);

  it('11. a folder with a .claude/settings.json hook gets a trust question before claude is spawned', async () => {
    const w = await boot([TURNS]);
    put(w.cwd, '.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    const id = await w.session();
    await w.say(id, 'hello');
    const q = await askedQuestion(w.store, id, 'trust');
    expect(q.detail).toContain('.claude/settings.json');
    expect(w.fake.log()).toEqual([]);
    expect((await w.answer(id, q.id, 'y')).status).toBe(200);
    await w.settled(id, 1);
    expect(fakeArgs(w)).toHaveLength(1);
  }, T);
});
