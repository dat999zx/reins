// The chat session (plan 15d 3b.1, 3b.3-3b.5): plain turns, cards, questions, the engine wrapper, folder trust, tagged runs.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Question } from '../src/drive.js';
import { openSession } from '../src/session.js';
import { openStore, type LogRow } from '../src/store.js';
import { folderHash, hashCommands } from '../src/trust.js';
import { testEngine, type TestTurn } from './test-engine.js';

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-sess-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

function setup(script: TestTurn[] = [], o: { cwd?: string; dir?: string; autoApprove?: boolean } = {}) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const seen: LogRow[] = [];
  const dir = o.dir ?? tmp();
  const cwd = o.cwd ?? tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude' });
  const s = openSession({ store, makeEngine: t.makeEngine, dir, onRow: (r) => seen.push(r) }, row, true);
  const reopen = () => openSession({ store, makeEngine: t.makeEngine, dir, onRow: (r) => seen.push(r) }, store.getSession('s1')!);
  if (o.autoApprove) s.settings({ autoApprove: true });
  const log = () => store.readLog('s1');
  const rows = (type: string) => log().filter((r) => r.type === type);
  const data = (type: string) => rows(type).map((r) => r.data as any);
  const open = (): Question[] => {
    const l = log();
    return l.filter((r) => r.type === 'question').map((r) => r.data as Question)
      .filter((q) => !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as any).questionId === q.id));
  };
  const question = async (kind?: Question['kind']) => {
    await until(() => open().some((q) => !kind || q.kind === kind));
    return open().find((q) => !kind || q.kind === kind)!;
  };
  return { store, t, s, reopen, seen, dir, cwd, log, rows, data, open, question, types: () => log().map((r) => r.type) };
}

const turnsStarted = (x: ReturnType<typeof setup>, n: number) => until(() => x.t.turns.length === n);

describe('plain turns (3b.4)', () => {
  it('a message is one turn with the text as typed, logged in order, and every row reaches onRow', async () => {
    const x = setup([{ tools: [{ tool: 'Read', input: { file_path: 'a' } }], text: 'hi there' }]);
    expect(x.s.message('hello')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.t.turns).toEqual(['hello']);
    expect(x.types()).toEqual(['session_created', 'status', 'message', 'engine', 'engine', 'turn_ended', 'status']);
    expect(x.data('message')).toEqual([{ role: 'user', text: 'hello' }]);
    expect(x.data('turn_ended')).toEqual([{ text: 'hi there', cost: 0.01 }]);
    expect(x.data('status')).toEqual([{ status: 'running' }, { status: 'idle' }]);
    expect(x.t.opens[0]!.policy()).toEqual({ mode: 'write', guards: [], allowShell: true });
    expect(x.t.opens[0]!.cwd).toBe(x.cwd);
    expect(x.t.opens[0]!.sessionId).toBeUndefined();
    expect(x.seen.map((r) => r.seq)).toEqual(x.log().map((r) => r.seq));
  });

  it('a tool call is a question: y allows, n <reason> denies, and a second answer is 409', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }, { tool: 'Bash', input: { command: 'rm x' }, approve: true }] }]);
    x.s.message('go');
    const q1 = await x.question('tool');
    expect(q1.prompt).toBe('? Allow Bash: ls  [y / n <reason>]');
    expect(q1.detail).toBe('{"command":"ls"}');
    expect(x.s.status()).toBe('waiting');
    expect(x.s.answer(q1.id, 'y')).toEqual({ ok: true });
    const q2 = await x.question('tool');
    expect(q2.id).not.toBe(q1.id);
    expect(x.s.answer(q2.id, 'n not now')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }, { behavior: 'deny', message: 'The user said no: not now' }]);
    expect(x.s.answer(q2.id, 'y')).toMatchObject({ ok: false, code: 409, error: expect.stringContaining(q2.id) });
    expect(x.s.answer('nope', 'y')).toMatchObject({ ok: false, code: 409 });
    expect(x.data('status').map((d) => d.status)).toEqual(['running', 'waiting', 'running', 'waiting', 'running', 'idle']);
    expect(x.data('engine').some((e) => e.type === 'refusal')).toBe(true);
  });

  it('auto-approve answers a tool question at once, logs both rows, and never shows waiting; settings is logged and stored', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }] }], { autoApprove: true });
    x.s.settings({ title: 'named' });
    x.s.message('go');
    await x.s.idle();
    const q = x.data('question')[0] as Question;
    expect(x.data('answer')).toEqual([{ questionId: q.id, answer: 'y' }]);
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }]);
    expect(x.data('status').map((d) => d.status)).toEqual(['running', 'idle']);
    expect(x.data('settings')).toEqual([{ autoApprove: true }, { title: 'named' }]);
    expect(x.store.getSession('s1')).toMatchObject({ autoApprove: true, title: 'named' });
  });

  it('an approval request that arrives after its turn ended is denied at once and never left open', async () => {
    const x = setup([{ text: 'ok', lateApprove: true }]);
    x.s.message('go');
    await x.s.idle();
    await until(() => x.t.decisions.length === 1);
    expect(x.t.decisions).toEqual([{ behavior: 'deny', message: 'The user said no.' }]);
    expect(x.rows('question')).toEqual([]);
    expect(x.s.status()).toBe('idle');
  });

  it('a message while a turn runs is a steer card, delivered mid-turn by the hook, and is not a message row', async () => {
    const x = setup([{ tools: [{ tool: 'Read', hold: true }] }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    expect(x.s.message('second')).toEqual({ ok: true });
    x.t.release();
    await x.s.idle();
    expect(x.t.turns).toEqual(['first']);
    expect(x.data('card_queued')).toEqual([{ card: 'second', kind: 'steer' }]);
    expect(x.data('engine').filter((e) => e.type === 'card_delivered')).toEqual([{ type: 'card_delivered', card: 'second', channel: 'mid-turn' }]);
    expect(x.data('message').map((m) => m.text)).toEqual(['first']);
  });

  it('leftover cards become the next plain turn, joined by blank lines, with a fromCards message row', async () => {
    const x = setup([{ hold: true }, { text: 'second done' }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    x.s.message('a');
    x.s.card('b', 'steer');
    x.t.release();
    await x.s.idle();
    expect(x.t.turns).toEqual(['first', 'a\n\nb']);
    expect(x.data('message')).toEqual([{ role: 'user', text: 'first' }, { role: 'user', text: 'a\n\nb', fromCards: true }]);
    expect(x.rows('cards_unsent')).toEqual([]);
  });

  it('a now card interrupts, then is sent as the next turn ahead of the queued cards', async () => {
    const x = setup([{ hold: true }, { text: 'ok' }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    x.s.card('later', 'steer');
    x.s.card('now!', 'now');
    await x.s.idle();
    expect(x.t.interrupts).toBe(1);
    expect(x.t.turns).toEqual(['first', 'now!\n\nlater']);
    expect(x.data('card_delivered')).toEqual([{ card: 'now!', channel: 'interrupt' }]);
    expect(x.data('message')[1]).toEqual({ role: 'user', text: 'now!\n\nlater', fromCards: true });
  });

  it('a stop card interrupts, sends no next turn, and the queued cards become one cards_unsent; an idle stop is 409', async () => {
    const x = setup([{ hold: true }, { text: 'never' }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    x.s.card('later', 'steer');
    expect(x.s.card('halt', 'stop')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.t.turns).toEqual(['first']);
    expect(x.data('cards_unsent')).toEqual([{ cards: ['later'] }]);
    expect(x.data('turn_ended')).toHaveLength(1);
    expect(x.s.status()).toBe('idle');
    expect(x.s.card('halt', 'stop')).toMatchObject({ ok: false, code: 409 });
  });

  it('now, stop, now in one turn: nothing is lost, one interrupt, all held cards end as cards_unsent in typed order', async () => {
    const x = setup([{ hold: true }, { text: 'never' }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    x.s.card('a', 'now');
    x.s.card('b', 'stop');
    x.s.card('c', 'now');
    await x.s.idle();
    expect(x.t.interrupts).toBe(1);
    expect(x.t.turns).toEqual(['first']);
    expect(x.data('cards_unsent')).toEqual([{ cards: ['a', 'c'] }]);
    expect(x.data('card_queued').map((c) => c.card)).toEqual(['a', 'b', 'c']);
  });

  it('a stop that replaces a now card keeps typed order: a steer card typed before it stays first in cards_unsent', async () => {
    const x = setup([{ hold: true }, { text: 'never' }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    x.s.card('S', 'steer');
    x.s.card('N', 'now');
    x.s.card('halt', 'stop');
    await x.s.idle();
    expect(x.data('cards_unsent')).toEqual([{ cards: ['S', 'N'] }]);
    expect(x.t.turns).toEqual(['first']);
  });

  it('a stop card with a tool question open interrupts first, then answers the question with stop (deny)', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }] }]);
    x.s.message('go');
    const q = await x.question('tool');
    expect(x.s.card('halt', 'stop')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('answer')).toEqual([{ questionId: q.id, answer: 'stop' }]);
    expect(x.t.decisions).toEqual([{ behavior: 'deny', message: 'The user said no: stop' }]);
    expect(x.t.interrupts).toBe(1);
  });

  it('/close interrupts, closes the open question, ends the engine, logs closed, and the next message reopens', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }], hold: true }]);
    x.s.message('go');
    const q = await x.question('tool');
    await x.s.close();
    expect(x.data('question_closed')).toEqual([{ questionId: q.id, why: expect.any(String) }]);
    expect(x.s.answer(q.id, 'y')).toMatchObject({ ok: false, code: 409 });
    expect(x.t.interrupts).toBe(1);
    expect(x.t.closes).toBe(1);
    expect(x.s.status()).toBe('closed');
    expect(x.types().slice(-3)).toEqual(['status', 'closed', 'status']);
    expect(x.data('status').slice(-1)).toEqual([{ status: 'closed' }]);
    x.s.message('again');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    expect(x.s.status()).toBe('idle');
  });

  it('a card while idle is a plain turn whose message row says fromCards (spec 1557)', async () => {
    const x = setup([{ text: 'ok' }]);
    expect(x.s.card('do this', 'steer')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.t.turns).toEqual(['do this']);
    expect(x.data('message')).toEqual([{ role: 'user', text: 'do this', fromCards: true }]);
  });

  it('while /close is running every request is 409, and a second /close shares the first', async () => {
    const x = setup([{ hold: true }]);
    x.s.message('first');
    await turnsStarted(x, 1);
    const first = x.s.close();
    const second = x.s.close();
    expect(x.s.message('too soon')).toMatchObject({ ok: false, code: 409 });
    expect(x.s.card('too soon', 'steer')).toMatchObject({ ok: false, code: 409 });
    await Promise.all([first, second]);
    expect(x.rows('closed')).toHaveLength(1);
    expect(x.t.closes).toBe(1);
    expect(x.t.turns).toEqual(['first']);
    expect(x.s.message('now fine')).toEqual({ ok: true });
    await x.s.idle();
  });
});

describe('the engine session and its wrapper (3b.4)', () => {
  it('a first turn that fails leaves no engine_session_id, drops the engine with a note, and the reopen starts fresh', async () => {
    const x = setup([{ reject: 'claude exploded' }, { text: 'fine' }]);
    x.s.message('one');
    await x.s.idle();
    expect(x.data('turn_failed')).toEqual([{ error: 'claude exploded' }]);
    expect(x.data('note')).toEqual([{ text: expect.stringContaining('claude exploded') }]);
    expect(x.t.closes).toBe(1);
    expect(x.store.getSession('s1')!.engineSessionId).toBeUndefined();
    x.s.message('two');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    expect(x.t.opens[1]!.sessionId).toBeUndefined();
    expect(x.store.getSession('s1')!.engineSessionId).toBe('test-2');
  });

  it('the first result writes engine_session_id; a result with an error event (an interrupt timeout) marks the engine dead, and the reopen resumes it', async () => {
    const x = setup([{ text: 'a' }, { text: 'b', error: 'claude did not stop after an interrupt, so Reins killed it' }, { text: 'c' }]);
    x.s.message('1');
    await x.s.idle();
    expect(x.store.getSession('s1')!.engineSessionId).toBe('test-1');
    x.s.message('2');
    await x.s.idle();
    expect(x.t.closes).toBe(1);
    expect(x.data('note')).toEqual([{ text: expect.stringContaining('did not stop') }]);
    x.s.message('3');
    await x.s.idle();
    expect(x.t.opens.map((o) => o.sessionId)).toEqual([undefined, 'test-1']);
  });

  it('a tagged run and the plain turns share one engine session, and the run reads its policy live', async () => {
    const x = setup([{ tools: [{ tool: 'Read', hold: true }], text: 'REINS: done' }, { text: 'plain' }]);
    expect(x.s.message('scan', [{ tag: 'read-only' }])).toEqual({ ok: true });
    await turnsStarted(x, 1);
    expect(x.t.opens[0]!.policy().mode).toBe('read-only');
    x.t.release();
    await x.s.idle();
    expect(x.t.opens[0]!.policy()).toEqual({ mode: 'write', guards: [], allowShell: true });
    x.s.message('next');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(1);
    expect(x.t.turns[1]).toBe('next');
    const engineRows = x.rows('engine');
    expect(engineRows.some((r) => r.runId)).toBe(true);
    expect(engineRows.slice(-1)[0]!.runId).toBeUndefined();
  });

  it('a run turn that rejects detaches the run with the error, drops the engine, and logs no receipt', async () => {
    const x = setup([{ reject: 'boom' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.rows('run_detached')).toEqual([expect.objectContaining({ runId, data: { error: 'boom' } })]);
    expect(x.rows('receipt')).toEqual([]);
    expect(x.t.closes).toBe(1);
    expect(x.s.status()).toBe('idle');
    x.s.message('again');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
  });
});

describe('folder trust (3b.4, exit check 11)', () => {
  const claudeFolder = () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{"hooks":{}}');
    return cwd;
  };

  it('asks before the engine is opened, y stores the hash and opens, the same hash asks no more, a changed file asks again', async () => {
    const cwd = claudeFolder();
    const x = setup([{ text: 'ok' }], { cwd });
    x.s.message('hi');
    const q = await x.question('trust');
    expect(x.t.opens).toHaveLength(0);
    expect(q.detail).toContain('.claude/settings.json');
    expect(q.detail).toContain('{"hooks":{}}');
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(1);
    expect(x.store.isTrusted(cwd, '.claude/', folderHash(cwd)!.hash)).toBe(true);
    await x.s.close();
    x.s.message('again');
    await x.s.idle();
    expect(x.rows('question')).toHaveLength(1);
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{"hooks":{"x":1}}');
    await x.s.close();
    x.s.message('third');
    await x.question('trust').then((again) => expect(again.id).not.toBe(q.id));
    expect(x.rows('question')).toHaveLength(2);
    await x.s.close();
  });

  it('a now card typed while the engine waits on the trust question does not drop the text: it is sent first, the card after', async () => {
    const x = setup([{ text: 'a' }, { text: 'b' }], { cwd: claudeFolder() });
    x.s.message('typed');
    const q = await x.question('trust');
    expect(x.s.card('right now', 'now')).toEqual({ ok: true });
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.turns).toEqual(['typed', expect.stringContaining('right now')]);
    expect(x.rows('turn_failed')).toEqual([]);
    expect(x.rows('cards_unsent')).toEqual([]);
  });

  it('a now card typed while a run waits on the trust question: the step prompt is still sent, the card follows', async () => {
    const x = setup([{ text: 'REINS: done' }, { text: 'REINS: done' }], { cwd: claudeFolder() });
    x.s.message('go', [{ tag: 'read-only' }]);
    const q = await x.question('trust');
    expect(x.s.card('right now', 'now')).toEqual({ ok: true });
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.turns[0]).toContain('go');
    expect(x.t.turns[0]).not.toContain('right now');
    expect(x.t.turns.some((t) => t.includes('right now'))).toBe(true);
  });

  it('n logs a note and turn_failed, and nothing is spawned', async () => {
    const x = setup([{ text: 'ok' }], { cwd: claudeFolder() });
    x.s.message('hi');
    const q = await x.question('trust');
    x.s.answer(q.id, 'n');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(0);
    expect(x.data('note')).toEqual([{ text: expect.stringContaining('not trusted') }]);
    expect(x.data('turn_failed')).toEqual([{ error: expect.stringContaining('not trusted') }]);
    expect(x.s.status()).toBe('idle');
  });

  it('n inside a run: the turn rejects, the run detaches with the error, and nothing is spawned', async () => {
    const x = setup([{ text: 'REINS: done' }], { cwd: claudeFolder() });
    x.s.message('go', [{ tag: 'gate' }]);
    const q = await x.question('trust');
    expect(q.detail).toContain('.claude/settings.json');
    x.s.answer(q.id, 'n');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(0);
    expect(x.rows('run_detached')).toEqual([expect.objectContaining({ data: { error: expect.stringContaining('not trusted') } })]);
    expect(x.rows('receipt')).toEqual([]);
  });
});

describe('auto-approve inside a run (3b.2)', () => {
  it('a tool question in a run is answered y at once, logged with the run id, and the run never shows waiting', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }], text: 'REINS: done' }], { autoApprove: true });
    x.s.message('go', [{ tag: 'read-only' }]);
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.rows('question')).toEqual([expect.objectContaining({ runId })]);
    expect(x.rows('answer')).toEqual([expect.objectContaining({ runId, data: expect.objectContaining({ answer: 'y' }) })]);
    expect(x.data('status').map((d) => d.status)).toEqual(['running', 'idle']);
  });
});

describe('tagged prompts (3b.5)', () => {
  it('a #gate prompt is a run in the session: message row with tags, run_started, a gate question, receipt, and the generated file', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    expect(x.s.message('fix it', [{ tag: 'gate' }])).toEqual({ ok: true });
    const q = await x.question('gate');
    expect(q.prompt).toBe('approve / changes <note> / stop');
    expect(x.s.status()).toBe('waiting');
    x.s.answer(q.id, 'approve');
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    const file = path.join(x.dir, 'runs', `${runId}.reins.md`);
    expect(fs.readFileSync(file, 'utf8')).toContain('> fix it');
    expect(x.store.loadRun(runId)!.workflowPath).toBe(file);
    expect(x.data('message')).toEqual([{ role: 'user', text: 'fix it', tags: [{ tag: 'gate' }] }]);
    expect(x.rows('question')[0]!.runId).toBe(runId);
    expect(x.rows('say').length).toBeGreaterThan(0);
    expect(x.rows('receipt')).toEqual([expect.objectContaining({ runId })]);
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.t.turns[0]).toContain('fix it');
    expect(x.t.opens).toHaveLength(1);
  });

  it('a warning of the generated workflow is a note carrying the run id, after run_started (spec 1480)', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'repeat', arg: 'llm says "fine"' }]);
    x.s.answer((await x.question('judge')).id, 'y');
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.rows('note')).toEqual(expect.arrayContaining([expect.objectContaining({ runId, data: { text: expect.stringContaining('extra model calls') } })]));
    const t = x.types();
    expect(t.indexOf('note')).toBeGreaterThan(t.indexOf('run_started'));
  });

  it('a card typed while a run waits at its gate is in the run snapshot at once, with no shutdown in between (spec 1322)', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    await x.question('gate');
    x.s.message('typed');
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.store.loadRun(runId)!.snapshot.pendingCards).toEqual(['typed']);
    await x.s.shutdown();
  });

  it('a bad tag is 400 with the text and diagnostics and logs no row; a tagged message while busy is 409', async () => {
    const x = setup([{ hold: true }]);
    const before = x.log().length;
    expect(x.s.message('go', [{ tag: 'max', arg: '3' }])).toEqual({ ok: false, code: 400, error: expect.stringMatching(/unknown tag "max"/) });
    expect(x.s.message('go', [{ tag: 'mode', arg: 'readonly' }])).toMatchObject({
      ok: false, code: 400, text: expect.stringContaining('mode: readonly'), diagnostics: expect.any(Array),
    });
    expect(x.log()).toHaveLength(before);
    x.s.message('plain');
    await turnsStarted(x, 1);
    expect(x.s.message('go', [{ tag: 'gate' }])).toMatchObject({ ok: false, code: 409 });
    x.t.release();
    await x.s.idle();
  });

  it('/card stop with a gate question open answers it with stop, and the run ends stopped with a receipt', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    const q = await x.question('gate');
    expect(x.s.card('halt', 'stop')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('answer')).toEqual([{ questionId: q.id, answer: 'stop' }]);
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('receipt')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([]);
  });

  it('/card stop on a judge question is applied first: the next question is resume / stop, not a gate', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'repeat', arg: 'llm says "fine"' }]);
    const j = await x.question('judge');
    expect(x.s.card('halt', 'stop')).toEqual({ ok: true });
    const r = await x.question('resume');
    expect(r.prompt).toBe('resume [note] / stop');
    expect(x.data('answer')[0]).toEqual({ questionId: j.id, answer: 'stop' });
    x.s.answer(r.id, 'stop');
    await x.s.idle();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('question').filter((q) => (q.data as Question).kind === 'gate')).toEqual([]);
  });

  it('/close during a run turn stops the run: no new question, no detach, a receipt, closed', async () => {
    const x = setup([{ tools: [{ tool: 'Read', hold: true }], text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    await turnsStarted(x, 1);
    await x.s.close();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('question')).toEqual([]);
    expect(x.rows('run_detached')).toEqual([]);
    expect(x.rows('receipt')).toHaveLength(1);
    expect(x.s.status()).toBe('closed');
  });

  it('a card typed during a run goes to the run; when the run is done it is the next plain turn', async () => {
    const x = setup([{ hold: true, text: 'REINS: done' }, { text: 'after' }]);
    x.s.message('go', [{ tag: 'read-only' }]);
    await turnsStarted(x, 1);
    x.s.message('a');
    expect(x.rows('card_queued')[0]!.runId).toBeDefined();
    x.t.release();
    await x.s.idle();
    expect(x.t.turns).toHaveLength(2);
    expect(x.t.turns[1]).toBe('a');
    expect(x.data('message').slice(-1)).toEqual([{ role: 'user', text: 'a', fromCards: true }]);
    expect(x.rows('cards_unsent')).toEqual([]);
  });

  it('a run answered stop leaves its pending cards as cards_unsent and sends no turn', async () => {
    const x = setup([{ hold: true, text: 'REINS: done' }, { text: 'never' }]);
    x.s.message('go', [{ tag: 'read-only' }]);
    await turnsStarted(x, 1);
    x.s.message('a');
    x.s.card('halt', 'stop');
    const r = await x.question('resume');
    x.s.answer(r.id, 'stop');
    await x.s.idle();
    expect(x.data('cards_unsent')).toEqual([{ cards: ['a'] }]);
    expect(x.t.turns).toHaveLength(1);
  });
});

const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n';
const ECHO = `${FRONT}## run \`echo hi\`\n\n## phase go\n> do it\n`;
const WITH_BLOCK = `${FRONT}## use rp\n\n## gate\nuntil: you approve\n\n## phase go\n> do it\n`;
const rp = (cmd: string) => `---\nreins: 1\nblock: rp\n---\n\n## run \`${cmd}\`\n`;
const put = (dir: string, name: string, text: string) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

describe('workflow files (3b.6)', () => {
  it('runs a file under the folder after a trust question that lists its commands; the same file then runs with no question', async () => {
    const x = setup([{ text: 'REINS: done' }, { text: 'REINS: done' }]);
    const file = put(x.cwd, 'a.reins.md', ECHO);
    expect(x.s.runFile(file)).toEqual({ ok: true });
    const q = await x.question('trust');
    expect(q.detail).toBe('echo hi\nnpm test');
    expect(x.rows('run_started')).toEqual([]);
    expect(x.t.opens).toHaveLength(0);
    expect(x.s.status()).toBe('waiting');
    x.s.answer(q.id, 'y');
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.store.loadRun(runId)!.workflowPath).toBe(fs.realpathSync(file));
    expect(x.store.isTrusted(x.cwd, fs.realpathSync(file), hashCommands(['echo hi', 'npm test']))).toBe(true);
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.data('say').map((s) => s.text)).toContain('$ echo hi');
    expect(x.rows('receipt')).toHaveLength(1);
    expect(x.s.runFile(file)).toEqual({ ok: true });
    await x.s.idle();
    expect(x.rows('question')).toHaveLength(1);
    expect(x.rows('run_started')).toHaveLength(2);
  });

  it('n refuses: nothing runs, a note says so, and a message typed meanwhile ends as cards_unsent', async () => {
    const x = setup();
    x.s.runFile(put(x.cwd, 'a.reins.md', ECHO));
    const q = await x.question('trust');
    x.s.message('typed');
    x.s.answer(q.id, 'n');
    await x.s.idle();
    expect(x.rows('run_started')).toEqual([]);
    expect(x.t.opens).toHaveLength(0);
    expect(x.data('note')).toEqual([{ text: expect.stringContaining('not trusted') }]);
    expect(x.data('cards_unsent')).toEqual([{ cards: ['typed'] }]);
    expect(x.s.status()).toBe('idle');
  });

  it('a message typed during the trust question is moved into the run and is in its first turn, once', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.runFile(put(x.cwd, 'a.reins.md', ECHO));
    const q = await x.question('trust');
    expect(x.s.message('typed')).toEqual({ ok: true });
    expect(x.rows('card_queued')).toEqual([expect.objectContaining({ data: { card: 'typed', kind: 'steer' } })]);
    // once the run exists, the move logs the run's own card_queued (with the run id): two rows in all, on purpose
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.turns).toHaveLength(1);
    expect(x.t.turns[0]).toContain('typed');
    expect(x.rows('card_delivered').filter((r) => (r.data as any).channel === 'next-turn')).toHaveLength(1);
    expect(x.rows('cards_unsent')).toEqual([]);
    expect(x.rows('card_queued')).toEqual([
      expect.objectContaining({ data: { card: 'typed', kind: 'steer' } }),
      expect.objectContaining({ runId: expect.any(String), data: { card: 'typed', kind: 'steer', source: 'live' } }),
    ]);
  });

  it('a now card typed during the trust question waits like a steer card: not lost, in the first turn once (spec 1293)', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.runFile(put(x.cwd, 'a.reins.md', ECHO));
    const q = await x.question('trust');
    expect(x.s.card('right now', 'now')).toEqual({ ok: true });
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.interrupts).toBe(0);
    expect(x.t.turns).toHaveLength(1);
    expect(x.t.turns[0]).toContain('right now');
    expect(x.rows('cards_unsent')).toEqual([]);
  });

  it('a relative path is relative to the session folder, a folder named ..foo is under it, and ~/.reins/runs is refused', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    put(x.cwd, '..foo/a.reins.md', ECHO);
    expect(x.s.runFile('..foo/a.reins.md')).toEqual({ ok: true });
    x.s.answer((await x.question('trust')).id, 'n');
    await x.s.idle();
    const d = tmp();
    const y = setup([], { dir: d, cwd: d });
    expect(y.s.runFile(put(d, 'runs/x.reins.md', ECHO))).toMatchObject({ ok: false, code: 400, error: expect.stringContaining('runs') });
  });

  it('refuses with 400 a missing file, a file outside the folder and ~/.reins/workflows, and an invalid file (with diagnostics), logging nothing; ~/.reins/workflows is allowed', async () => {
    const x = setup();
    const outside = put(path.dirname(x.cwd), 'reins-outside.reins.md', ECHO);
    tmps.push(outside);
    const before = x.log().length;
    expect(x.s.runFile(path.join(x.cwd, 'missing.reins.md'))).toMatchObject({ ok: false, code: 400 });
    expect(x.s.runFile(outside)).toMatchObject({ ok: false, code: 400, error: expect.stringContaining('under') });
    expect(x.s.runFile(path.join(x.cwd, '..', 'reins-outside.reins.md'))).toMatchObject({ ok: false, code: 400 });
    const bad = put(x.cwd, 'bad.reins.md', `${FRONT}## phase go\nmode: readonly\n> x\n`);
    expect(x.s.runFile(bad)).toMatchObject({ ok: false, code: 400, diagnostics: expect.any(Array) });
    expect(x.log()).toHaveLength(before);
    expect(x.s.runFile(put(path.join(x.dir, 'workflows'), 'h.reins.md', ECHO))).toEqual({ ok: true });
    x.s.answer((await x.question('trust')).id, 'n');
    await x.s.idle();
  });

  it('a workflow model: is ignored in a session, with a note carrying the run id', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.runFile(put(x.cwd, 'm.reins.md', '---\nreins: 1\nname: t\nmodel: opus\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n## phase go\n> x\n'));
    x.s.answer((await x.question('trust')).id, 'y');
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId;
    expect(x.rows('note')).toEqual([expect.objectContaining({ runId, data: { text: expect.stringContaining('ignores') } })]);
  });

  it('is 409 while the session is busy', async () => {
    const x = setup([{ hold: true }]);
    x.s.message('plain');
    await turnsStarted(x, 1);
    expect(x.s.runFile(put(x.cwd, 'a.reins.md', ECHO))).toMatchObject({ ok: false, code: 409 });
    expect(x.s.resume('r1')).toMatchObject({ ok: false, code: 409 });
    x.t.release();
    await x.s.idle();
  });
});

describe('/resume (3b.6, 3b.7)', () => {
  it('re-checks trust first when a block changed after the detach; nothing is logged for the run until y; then a note and the run goes on from its gate', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    const file = put(x.cwd, 'a.reins.md', WITH_BLOCK);
    put(x.cwd, 'blocks/rp.reins.md', rp('echo one'));
    x.s.runFile(file);
    x.s.answer((await x.question('trust')).id, 'y');
    const gate = await x.question('gate');
    await x.s.shutdown();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.rows('run_detached')).toHaveLength(1);

    put(x.cwd, 'blocks/rp.reins.md', rp('echo two'));
    const s2 = x.reopen();
    expect(s2.resume(runId)).toEqual({ ok: true });
    const q = await x.question('trust');
    expect(q.detail).toBe('echo two\nnpm test');
    expect(x.rows('note').filter((r) => r.runId === runId)).toEqual([]);
    s2.answer(q.id, 'y');
    const g2 = await x.question('gate');
    expect(g2.id).not.toBe(gate.id);
    expect(x.rows('note').filter((r) => r.runId === runId)).toEqual([expect.objectContaining({ data: { text: `Resumed run ${runId}.` } })]);
    s2.answer(g2.id, 'approve');
    await s2.idle();
    expect(x.rows('run_started')).toHaveLength(1);
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.rows('receipt')).toHaveLength(1);
  });

  it('a tagged run resumes with no trust question', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    const gate = await x.question('gate');
    await x.s.shutdown();
    const runId = x.rows('run_started')[0]!.runId!;
    const s2 = x.reopen();
    expect(s2.resume(runId)).toEqual({ ok: true });
    const g2 = await x.question('gate');
    expect(g2.id).not.toBe(gate.id);
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'trust')).toEqual([]);
    s2.answer(g2.id, 'approve');
    await s2.idle();
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('is 409 for an unknown run, another session\'s run, and a run that has ended', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    expect(x.s.resume('nope')).toMatchObject({ ok: false, code: 409 });
    x.store.createSession({ id: 's2', cwd: x.cwd, engine: 'claude' });
    x.store.appendLog('s2', { type: 'run_started', runId: 'r9' });
    x.store.createRun({ id: 'r9', workflowPath: '', cwd: x.cwd });
    x.store.saveSnapshot('r9', { events: [] } as any);
    expect(x.s.resume('r9')).toMatchObject({ ok: false, code: 409, error: expect.stringMatching(/does not belong/) });
    x.s.message('go', [{ tag: 'read-only' }]);
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.s.resume(runId)).toMatchObject({ ok: false, code: 409, error: expect.stringContaining('ended') });
  });

  it('a card typed while a run waits at its gate stays in the run\'s snapshot when it detaches (not cards_unsent) and is delivered once after /resume', async () => {
    const x = setup([{ text: 'REINS: done' }, { text: 'ok' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    await x.question('gate');
    x.s.message('typed');
    await x.s.shutdown();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.store.loadRun(runId)!.snapshot.pendingCards).toEqual(['typed']);
    expect(x.rows('cards_unsent')).toEqual([]);
    const s2 = x.reopen();
    s2.resume(runId);
    s2.answer((await x.question('gate')).id, 'approve');
    await s2.idle();
    expect(x.t.turns.filter((t) => t.includes('typed'))).toHaveLength(1);
    expect(x.rows('cards_unsent')).toEqual([]);
  });
});

describe('shutdown (server stop)', () => {
  it('at a question the run detaches: question_closed and run_detached, no receipt, no run_stopped, no closed row', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    await x.question('gate');
    await x.s.shutdown();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.rows('question_closed')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([expect.objectContaining({ runId })]);
    expect(x.rows('receipt')).toEqual([]);
    expect(x.rows('run_stopped')).toEqual([]);
    expect(x.rows('closed')).toEqual([]);
    expect(x.t.closes).toBe(1);
    expect(x.store.loadRun(runId)!.snapshot).toMatchObject({ status: 'paused' });
  });

  it('a plain turn at a tool question is interrupted and the question closed: nothing goes on', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }], hold: true }, { text: 'never' }]);
    x.s.message('go');
    await x.question('tool');
    x.s.message('queued');
    await x.s.shutdown();
    expect(x.t.interrupts).toBe(1);
    expect(x.t.turns).toEqual(['go']);
    expect(x.rows('question_closed')).toHaveLength(1);
    expect(x.data('cards_unsent')).toEqual([{ cards: ['queued'] }]);
    expect(x.t.closes).toBe(1);
  });

  it('a run at a tool question is stopped, not left to carry on to its next step', async () => {
    const x = setup([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }], text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'gate' }]);
    await x.question('tool');
    await x.s.shutdown();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([]);
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'gate')).toEqual([]);
    expect(x.t.turns).toHaveLength(1);
  });

  it('with no question open a run in its turn is stopped, not detached', async () => {
    const x = setup([{ hold: true, text: 'REINS: done' }]);
    x.s.message('go', [{ tag: 'read-only' }]);
    await turnsStarted(x, 1);
    await x.s.shutdown();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([]);
    expect(x.rows('closed')).toEqual([]);
  });
});
