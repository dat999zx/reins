// The chat session (plan 15d 3b.1, 3b.3-3b.5): plain turns, cards, questions, the engine wrapper, folder trust, tagged runs.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Question } from '../src/drive.js';
import { openSession, type MakeEngine } from '../src/session.js';
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

function setup(script: TestTurn[] = [], o: { cwd?: string; dir?: string; autoApprove?: boolean; describe?: Parameters<typeof openSession>[0]['describeModel'] } = {}) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const models: Array<string | undefined> = [];
  const makeEngine: MakeEngine = (e) => { models.push(e.model); return t.makeEngine(e); };
  const seen: LogRow[] = [];
  const dir = o.dir ?? tmp();
  const cwd = o.cwd ?? tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude' });
  const s = openSession({ store, makeEngine, dir, onRow: (r) => seen.push(r), ...(o.describe ? { describeModel: o.describe } : {}) }, row, true);
  const reopen = () => openSession({ store, makeEngine, dir, onRow: (r) => seen.push(r), ...(o.describe ? { describeModel: o.describe } : {}) }, store.getSession('s1')!);
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
  return { store, t, s, reopen, seen, dir, cwd, models, log, rows, data, open, question, types: () => log().map((r) => r.type) };
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

describe('cost baseline (A)', () => {
  const total = (x: ReturnType<typeof setup>, sid: string) => x.store.getEngineTotal(sid);
  const unknownNote = "This reply's cost is not known: the session began before Reins kept the provider's running total. Later replies are counted.";

  it('a new session opens with base 0, and a turn stores its raw total under the claude session id', async () => {
    const x = setup([{ total: 0.5 }]);
    x.s.message('hi');
    await x.s.idle();
    expect(x.t.opens[0]!.costBase).toBe(0);
    const sid = x.store.getSession('s1')!.engineSessionId!;
    expect(total(x, sid)).toBe(0.5);
  });

  it('after a switch, and after a restart, the open gets the stored total', async () => {
    const x = setup([{ total: 0.5, usage: 1000 }, { total: 0.75 }, { total: 1 }]);
    x.s.message('one');
    await x.s.idle();
    expect(x.s.settings({ model: 'model-b', estimate: 0.01, label: 'B' })).toEqual({ ok: true });
    x.s.message('two');
    await x.s.idle();
    expect(x.t.opens.map((o) => o.costBase)).toEqual([0, 0.5]);
    await x.s.shutdown();
    const s2 = x.reopen();
    s2.message('three');
    await s2.idle();
    expect(x.t.opens.map((o) => o.costBase)).toEqual([0, 0.5, 0.75]);
  });

  it('a legacy session (a claude id, no stored total) opens with an unknown base; its first reply has no cost and a note; later ones are counted', async () => {
    const x = setup([{ cost: null, total: 0.3 }, { total: 0.4 }]);
    x.store.updateSession('s1', { engineSessionId: 'old' });
    x.s.message('one');
    await x.s.idle();
    expect(x.t.opens[0]!.costBase).toBeUndefined();
    expect(x.t.opens[0]!.sessionId).toBe('old');
    expect(x.data('turn_ended')).toEqual([{ text: 'ok' }]);
    expect(x.data('note')).toEqual([{ text: unknownNote }]);
    expect(total(x, 'old')).toBe(0.3);
    x.s.message('two');
    await x.s.idle();
    expect(x.data('turn_ended')[1]).toEqual({ text: 'ok', cost: 0.01 });
    expect(x.data('note')).toHaveLength(1);
    expect(total(x, 'old')).toBe(0.4);
  });

  it('a turn that rejects stores nothing, and the next open gets the last stored total', async () => {
    const x = setup([{ total: 0.5 }, { reject: 'boom', total: 9 }, { total: 0.7 }]);
    x.s.message('one');
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    const sid = x.store.getSession('s1')!.engineSessionId!;
    expect(total(x, sid)).toBe(0.5);
    x.s.message('three');
    await x.s.idle();
    expect(x.t.opens.map((o) => o.costBase)).toEqual([0, 0.5]);
    expect(total(x, sid)).toBe(0.7);
  });
});

describe('model switch (A)', () => {
  const sw = (x: ReturnType<typeof setup>, model: string, extra: { estimate?: number; label?: string } = {}) =>
    x.s.settings({ model, estimate: 0.01, label: 'Test model', ...extra });
  const settingsRows = (x: ReturnType<typeof setup>) => x.data('settings');
  const notes = (x: ReturnType<typeof setup>) => x.data('note').map((n) => n.text as string);
  const conflict = (error: string | RegExp) => ({ ok: false, code: 409, error: typeof error === 'string' ? error : expect.stringMatching(error) });

  it('a fresh session: ok, stored, logged with its note, and the next engine is made with that model', async () => {
    const x = setup([{}]);
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    expect(x.store.getSession('s1')!.model).toBe('model-b');
    expect(settingsRows(x)).toEqual([{ model: 'model-b' }]);
    expect(notes(x)).toEqual(['Model set to Test model from the next reply. The whole conversation goes to it as input.']);
    x.s.message('hi');
    await x.s.idle();
    expect(x.models).toEqual(['model-b']);
  });

  it('with a context of 150,000 tokens: the switch is ok, the old process is closed, and the next message resumes the same id on the new model', async () => {
    const x = setup([{ usage: 150_000 }, {}]);
    x.s.message('one');
    await x.s.idle();
    const sid = x.store.getSession('s1')!.engineSessionId!;
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    await until(() => x.t.closes === 1);
    x.s.message('two');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    expect(x.t.opens[1]!.sessionId).toBe(sid);
    expect(x.models).toEqual([undefined, 'model-b']);
  });

  it('an immediate reply waits for the old process to close, then opens once', async () => {
    const x = setup([{ usage: 1000 }, {}]);
    x.s.message('one');
    await x.s.idle();
    x.t.holdClose();
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    x.s.message('hi');
    await new Promise((r) => setTimeout(r, 50));
    expect(x.t.opens).toHaveLength(1);
    expect(x.t.turns).toEqual(['one']);
    x.t.releaseClose();
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    expect(x.t.turns).toEqual(['one', 'hi']);
  });

  it('two rapid switches open one process, on the second model', async () => {
    const x = setup([{ usage: 1000 }, {}]);
    x.s.message('one');
    await x.s.idle();
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    expect(sw(x, 'model-c')).toEqual({ ok: true });
    x.s.message('two');
    await x.s.idle();
    expect(x.t.opens).toHaveLength(2);
    expect(x.models.at(-1)).toBe('model-c');
    expect(x.t.closes).toBe(1);
  });

  it('a shutdown during a switch resolves only after the old process has closed', async () => {
    const x = setup([{ usage: 1000 }]);
    x.s.message('one');
    await x.s.idle();
    x.t.holdClose();
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    let done = false;
    const down = x.s.shutdown().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    x.t.releaseClose();
    await down;
    expect(done).toBe(true);
  });

  it('a first reply that is an error undoes the switch: the model and the claude id go back, with a note; a later good reply does not undo', async () => {
    const x = setup([{ usage: 1000 }, { isError: true, text: 'no access' }, {}]);
    x.s.message('one');
    await x.s.idle();
    const sid = x.store.getSession('s1')!.engineSessionId!;
    sw(x, 'model-b');
    x.s.message('two');
    await x.s.idle();
    expect(x.store.getSession('s1')!.model).toBeUndefined();
    expect(x.store.getSession('s1')!.engineSessionId).toBe(sid);
    expect(notes(x).at(-1)).toMatch(/^model-b did not answer \(.+\)\. The model is back to the default\.$/);
    expect(settingsRows(x).at(-1)).toEqual({ model: '' });
    x.s.message('three');
    await x.s.idle();
    expect(x.models).toEqual([undefined, 'model-b', undefined]);
    expect(x.t.opens[2]!.sessionId).toBe(sid);
    expect(notes(x).filter((n) => n.includes('did not answer'))).toHaveLength(1);
  });

  it('a first reply that rejects undoes the switch too, back to the previous model', async () => {
    const x = setup([{ usage: 1000 }, { reject: 'refused' }, {}]);
    x.s.settings({ model: 'model-a' });
    x.s.message('one');
    await x.s.idle();
    sw(x, 'model-b');
    x.s.message('two');
    await x.s.idle();
    expect(x.store.getSession('s1')!.model).toBe('model-a');
    expect(notes(x).some((n) => n === 'model-b did not answer (refused). The model is back to model-a.')).toBe(true);
    x.s.message('three');
    await x.s.idle();
    expect(x.models.at(-1)).toBe('model-a');
  });

  it('is refused when busy or detached, and asks with a switch card when unknown, over a limit or without a price; nothing is stored until Switch', async () => {
    const x = setup([{ hold: true }, { usage: 200_000 }, { usage: 1000 }, { reject: 'x' }]);
    // the newest switch card is the question row just logged; answering keep closes it without a switch
    const card = () => x.rows('question').at(-1)!.data as { id: string; kind: string; prompt: string; detail: string };
    const keep = async () => { expect(x.s.answer(card().id, 'keep')).toEqual({ ok: true }); await x.s.idle(); };
    x.s.message('busy');
    await turnsStarted(x, 1);
    expect(sw(x, 'model-b')).toMatchObject(conflict('Switch the model when the session is idle.'));
    x.t.release();
    await x.s.idle();
    // turn 1 had no usage: the size is unknown while a claude session exists
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    expect(card()).toMatchObject({
      kind: 'switch', prompt: 'Switch to Test model?',
      detail: 'The whole conversation goes to Test model as input. Reins does not know its size, so the cost cannot be estimated.',
    });
    await keep();
    x.s.message('big');
    await x.s.idle();
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    expect(card()).toMatchObject({
      kind: 'switch', prompt: 'Switch to Test model?',
      detail: 'The whole conversation, 200,000 tokens, goes to Test model as input. Estimate: about $0.01 (an estimate from the provider\'s price table).\nAsked because the context is at or over the 200,000-token switch limit.',
    });
    await keep();
    expect(x.store.getSession('s1')!.model).toBeUndefined();
    x.store.putSetting('switchApprovalTokens', 300_000);
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    x.s.message('small');
    await x.s.idle();
    expect(sw(x, 'model-c', { estimate: 0.7, label: 'Fable 5.1' })).toEqual({ ok: true });
    expect(card()).toMatchObject({
      kind: 'switch', prompt: 'Switch to Fable 5.1?',
      detail: 'The whole conversation, 1,000 tokens, goes to Fable 5.1 as input. Estimate: about $0.70 (an estimate from the provider\'s price table).\nAsked because the estimate is at or over the $0.50 switch limit.',
    });
    await keep();
    expect(sw(x, 'model-c', { estimate: undefined, label: 'Fable 5.1' })).toEqual({ ok: true });
    expect(card()).toMatchObject({
      kind: 'switch', prompt: 'Switch to Fable 5.1?',
      detail: 'The whole conversation, 1,000 tokens, goes to Fable 5.1 as input. No price is known for Fable 5.1, so the cost cannot be estimated.',
    });
    await keep();
    expect(x.store.getSession('s1')!.model).toBe('model-b');
    // a failed turn after a usage row makes the size unknown again
    x.s.message('boom');
    await x.s.idle();
    expect(sw(x, 'model-c')).toEqual({ ok: true });
    expect(card()).toMatchObject({
      kind: 'switch', prompt: 'Switch to Test model?',
      detail: 'The whole conversation goes to Test model as input. Reins does not know its size, so the cost cannot be estimated.',
    });
    await keep();
    x.store.appendLog('s1', { type: 'run_detached', runId: 'r1', data: {} });
    expect(sw(x, 'model-c')).toMatchObject(conflict('A run is left paused in this session. Resume or stop it before switching the model.'));
  });

  it('Default stores no model, says so, and the next engine has none', async () => {
    const x = setup([{}]);
    sw(x, 'model-b');
    expect(sw(x, '')).toEqual({ ok: true });
    expect(x.store.getSession('s1')).not.toHaveProperty('model');
    expect(notes(x).at(-1)).toBe('Model set to the default from the next reply. The whole conversation goes to it as input.');
    x.s.message('hi');
    await x.s.idle();
    expect(x.models).toEqual([undefined]);
  });

  it('a title alone, or the same model again, switches nothing', () => {
    const x = setup();
    sw(x, 'model-b');
    const before = x.log().length;
    expect(x.s.settings({ title: 'x' })).toEqual({ ok: true });
    expect(sw(x, 'model-b')).toEqual({ ok: true });
    expect(x.log().slice(before).map((r) => r.type)).toEqual(['settings']);
    expect(x.data('note')).toHaveLength(1);
  });
});

describe('switch approval (B)', () => {
  const sw = (x: ReturnType<typeof setup>, model = 'model-b') => x.s.settings({ model, estimate: 0.01, label: 'Test model' });
  const big = async (o: { autoApprove?: boolean } = {}) => {
    const x = setup([{ usage: 300_000 }, {}], o);
    x.s.message('one');
    await x.s.idle();
    return x;
  };
  const card = (x: ReturnType<typeof setup>) => x.rows('question').at(-1)!.data as { id: string; kind: string; prompt: string };
  const modelRows = (x: ReturnType<typeof setup>) => x.data('settings').filter((d) => 'model' in d);

  it('asks: ok at once, a switch question, the session waits, nothing is stored', async () => {
    const x = await big();
    expect(sw(x)).toEqual({ ok: true });
    expect(card(x)).toMatchObject({ kind: 'switch', prompt: 'Switch to Test model?' });
    expect(x.s.status()).toBe('waiting');
    expect(modelRows(x)).toEqual([]);
    expect(x.store.getSession('s1')!.model).toBeUndefined();
  });

  it('Switch applies it as A does: the row, the note, idle, and the next message resumes the same id on the new model', async () => {
    const x = await big();
    const sid = x.store.getSession('s1')!.engineSessionId!;
    sw(x);
    expect(x.s.answer(card(x).id, 'switch')).toEqual({ ok: true });
    await x.s.idle();
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
    expect(x.data('note').at(-1).text).toBe('Model set to Test model from the next reply. The whole conversation goes to it as input.');
    expect(x.s.status()).toBe('idle');
    x.s.message('two');
    await x.s.idle();
    expect(x.models).toEqual([undefined, 'model-b']);
    expect(x.t.opens[1]!.sessionId).toBe(sid);
  });

  it('Keep stores nothing and logs no note; the next message runs on the old model', async () => {
    const x = await big();
    sw(x);
    x.s.answer(card(x).id, 'keep');
    await x.s.idle();
    expect(modelRows(x)).toEqual([]);
    expect(x.data('note')).toEqual([]);
    expect(x.s.status()).toBe('idle');
    x.s.message('two');
    await x.s.idle();
    expect(x.models).toEqual([undefined]); // the engine was never remade
    expect(x.store.getSession('s1')!.model).toBeUndefined();
  });

  it('a message while it waits closes it first; the turn runs on the old model; a late Switch is 409', async () => {
    const x = await big();
    sw(x);
    const qid = card(x).id;
    x.s.message('two');
    await x.s.idle();
    const closed = x.rows('question_closed').at(-1)!;
    expect(closed.data).toEqual({ questionId: qid, why: 'work started before it was answered' });
    expect(closed.seq).toBeLessThan(x.rows('message').at(-1)!.seq);
    // no spurious idle between waiting and running (B1)
    expect(x.data('status').map((d) => d.status).slice(-3)).toEqual(['waiting', 'running', 'idle']);
    expect(x.models).toEqual([undefined]); // the engine was never remade
    expect(x.store.getSession('s1')!.model).toBeUndefined();
    expect(x.s.answer(qid, 'switch')).toEqual({ ok: false, code: 409, error: `Question ${qid} is not open.` });
    expect(modelRows(x)).toEqual([]);
  });

  it('Stop while it waits answers keep', async () => {
    const x = await big();
    sw(x);
    const qid = card(x).id;
    expect(x.s.card('', 'stop')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('answer').at(-1)).toEqual({ questionId: qid, answer: 'keep' });
    expect(x.s.status()).toBe('idle');
    expect(modelRows(x)).toEqual([]);
  });

  it('a second switch while one waits is 409', async () => {
    const x = await big();
    sw(x);
    expect(sw(x, 'model-c')).toEqual({ ok: false, code: 409, error: 'Answer the switch question first.' });
    expect(x.rows('question')).toHaveLength(1);
  });

  it('Auto-approve never answers a switch', async () => {
    const x = await big({ autoApprove: true });
    sw(x);
    expect(x.s.status()).toBe('waiting');
    expect(x.data('answer')).toEqual([]);
  });

  it('closing the session closes it', async () => {
    const x = await big();
    sw(x);
    const qid = card(x).id;
    await x.s.close();
    expect(x.data('question_closed').at(-1)).toEqual({ questionId: qid, why: 'the session was closed' });
    expect(modelRows(x)).toEqual([]);
  });

  it('under a raised token limit there is no card: switched at once', async () => {
    const x = await big();
    x.store.putSetting('switchApprovalTokens', 400_000);
    expect(sw(x)).toEqual({ ok: true });
    expect(x.rows('question')).toHaveLength(0);
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
  });
});

describe('model step in a run (C)', () => {
  const FRONT_C = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
  const WF = `${FRONT_C}## model model-b\n\n## phase one\n> Go.\n`;
  const WF_GATE = `${FRONT_C}## model model-b\n\n## gate\nuntil: you approve\n\n## phase one\n> Go.\n`;
  const describeB = (_e: string, m: string) => ({ listed: m !== 'nope', label: m === 'model-b' ? 'B' : m, estimate: 0.01 });
  const SWITCHED = "Model set to B from the next reply. The whole conversation goes to it as input.";
  const CLOSED = "⏸ model-1: the switch question was closed before it was answered; Resume asks it again";
  /** A session that has had one reply (context 1,000 tokens) with the `describeB` list. */
  const ready = async (o: { autoApprove?: boolean; describe?: boolean } = {}, script: TestTurn[] = [{}]) => {
    const x = setup([{ usage: 1000 }, ...script], { ...(o.autoApprove ? { autoApprove: true } : {}), ...(o.describe === false ? {} : { describe: describeB }) });
    x.s.message('first');
    await x.s.idle();
    return x;
  };
  /** Writes `text`, runs it and answers the trust question. */
  const go = async (x: ReturnType<typeof setup>, text = WF, name = 'w.reins.md') => {
    const file = put(x.cwd, name, text);
    expect(x.s.runFile(file)).toEqual({ ok: true });
    const q = await x.question('trust');
    x.s.answer(q.id, 'y');
    return file;
  };
  const rid = (x: ReturnType<typeof setup>) => x.rows('run_started')[0]!.runId!;
  const modelRows = (x: ReturnType<typeof setup>) => x.data('settings').filter((d) => 'model' in d);
  const lowLimit = (x: ReturnType<typeof setup>) => x.store.putSetting('switchApprovalTokens', 500);

  it('under the limits there is no card: the session switches as the header does, with the run id, and the run turn opens on the new model', async () => {
    const x = await ready();
    await go(x);
    await x.s.idle();
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'switch')).toEqual([]);
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
    expect(x.rows('note').find((r) => (r.data as { text: string }).text === SWITCHED)!.runId).toBe(rid(x));
    expect(x.models).toEqual([undefined, 'model-b']);
    expect(x.t.opens[1]!.sessionId).toBe(x.store.getSession('s1')!.engineSessionId);
    expect(x.t.turns).toEqual(['first', expect.stringContaining('Go.')]);
    expect(x.data('model_switched')).toEqual([{ step: 'model-1', model: 'model-b', how: 'switched', label: 'B' }]);
  });

  it('over a limit it asks with the run id and the block named; the session waits and no turn is sent yet', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    expect(q.prompt).toBe('Switch to B?');
    expect(q.detail).toMatch(/\nAsked by the workflow's model block `model-1`\.$/);
    expect(x.rows('question').find((r) => (r.data as Question).id === q.id)!.runId).toBe(rid(x));
    expect(x.s.status()).toBe('waiting');
    expect(x.t.turns).toEqual(['first']);
    expect(modelRows(x)).toEqual([]);
    x.s.answer(q.id, 'switch');
    await x.s.idle();
  });

  it('Switch applies it, then the run goes on to its end', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    x.s.answer(q.id, 'switch');
    await x.s.idle();
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
    expect(x.rows('note').find((r) => (r.data as { text: string }).text === SWITCHED)!.runId).toBe(rid(x));
    expect(x.models).toEqual([undefined, 'model-b']);
    expect(x.data('model_switched')).toEqual([{ step: 'model-1', model: 'model-b', how: 'switched', label: 'B' }]);
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.t.turns).toHaveLength(2);
  });

  it('Keep stores nothing, says so with the run id, and the turn runs on the old model', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    x.s.answer(q.id, 'keep');
    await x.s.idle();
    expect(modelRows(x)).toEqual([]);
    const note = x.rows('note').find((r) => (r.data as { text: string }).text.startsWith('Kept'))!;
    expect((note.data as { text: string }).text).toBe('Kept the default model: the steps after `model-1` run on it.');
    expect(note.runId).toBe(rid(x));
    expect(x.data('model_switched')).toEqual([{ step: 'model-1', model: 'model-b', how: 'kept', label: 'the default model' }]);
    expect(x.models).toEqual([undefined]);
    expect(x.t.turns).toHaveLength(2);
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('Stop while it waits stops the run: the answer row stop, run_stopped, a receipt, no turn sent', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    expect(x.s.card('', 'stop')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('answer').at(-1)).toEqual({ questionId: q.id, answer: 'stop' });
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('receipt')).toHaveLength(1);
    expect(x.t.turns).toEqual(['first']);
    expect(modelRows(x)).toEqual([]);
    expect(x.data('model_switched')).toEqual([]);
  });

  it('shutdown while it waits detaches the run (question closed, say, run_detached, no run_stopped); Resume asks resume, then the switch again', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    await x.s.shutdown();
    expect(x.data('question_closed')).toEqual([{ questionId: q.id, why: 'the server stopped' }]);
    expect(x.data('say').map((d) => d.text)).toContain(CLOSED);
    expect(x.rows('run_detached')).toEqual([expect.objectContaining({ runId: rid(x) })]);
    expect(x.rows('run_stopped')).toEqual([]);
    expect(x.rows('receipt')).toEqual([]);
    expect(x.t.turns).toEqual(['first']);
    const s2 = x.reopen();
    expect(s2.resume(rid(x))).toEqual({ ok: true });
    const r = await x.question('resume');
    s2.answer(r.id, 'resume');
    const again = await x.question('switch');
    expect(again.id).not.toBe(q.id);
    expect(again.detail).toMatch(/Asked by the workflow's model block `model-1`\.$/);
    s2.answer(again.id, 'switch');
    await s2.idle();
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('a snapshot saved running at the model step (a crash) asks the switch directly on resume', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    const snap = x.store.loadRun(rid(x))!.snapshot!;
    expect(snap.status).toBe('running');
    await x.s.shutdown();
    x.store.saveSnapshot(rid(x), snap);
    const s2 = x.reopen();
    expect(s2.resume(rid(x))).toEqual({ ok: true });
    const again = await x.question('switch');
    expect(again.id).not.toBe(q.id);
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'resume')).toEqual([]);
    s2.answer(again.id, 'switch');
    await s2.idle();
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
  });

  it('a resumed run says when the session was switched meanwhile: the run chose B, the session is on the default model', async () => {
    const x = await ready();
    await go(x, WF_GATE);
    const g = await x.question('gate');
    await x.s.shutdown();
    expect(modelRows(x)).toEqual([{ model: 'model-b' }]);
    x.store.updateSession('s1', { model: null }); // another run's model step stands in: the header refuses while a run is detached
    const s2 = x.reopen();
    expect(s2.resume(rid(x))).toEqual({ ok: true });
    const g2 = await x.question('gate');
    expect(g2.id).not.toBe(g.id);
    const note = x.rows('note').find((r) => (r.data as { text: string }).text.startsWith("This run's model block"))!;
    expect((note.data as { text: string }).text).toBe("This run's model block chose B; the session is on the default model, so the next steps run on it.");
    expect(note.runId).toBe(rid(x));
    s2.answer(g2.id, 'approve');
    await s2.idle();
  });

  it('close() while it waits stops the run, closes the session and asks nothing more', async () => {
    const x = await ready();
    lowLimit(x);
    await go(x);
    await x.question('switch');
    await x.s.close();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([]);
    expect(x.rows('closed')).toHaveLength(1);
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'switch')).toHaveLength(1);
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'resume')).toEqual([]);
    expect(x.t.turns).toEqual(['first']);
    expect(x.s.status()).toBe('closed');
  });

  it('a session already on the model asks nothing and logs no note and no settings row', async () => {
    const x = await ready();
    lowLimit(x);
    x.store.updateSession('s1', { model: 'model-b' });
    await go(x);
    await x.s.idle();
    expect(x.rows('question').filter((r) => (r.data as Question).kind === 'switch')).toEqual([]);
    expect(x.rows('note').filter((r) => (r.data as { text: string }).text === SWITCHED)).toEqual([]);
    expect(modelRows(x)).toEqual([]);
    expect(x.data('model_switched')).toEqual([{ step: 'model-1', model: 'model-b', how: 'same', label: 'B' }]);
  });

  it('Auto-approve never answers it', async () => {
    const x = await ready({ autoApprove: true });
    lowLimit(x);
    await go(x);
    const q = await x.question('switch');
    expect(x.s.status()).toBe('waiting');
    expect(x.data('answer').filter((a) => a.questionId === q.id)).toEqual([]);
    x.s.answer(q.id, 'keep');
    await x.s.idle();
  });

  it('a model that is not in the provider list is 400 at run start with nothing logged; the session\'s own off-list model passes', async () => {
    const x = await ready();
    const file = put(x.cwd, 'bad.reins.md', WF.replace('model-b', 'nope'));
    const before = x.log().length;
    expect(x.s.runFile(file)).toEqual({ ok: false, code: 400, error: "Unknown model nope in step `model-1`: it is not in this session's provider list." });
    expect(x.log()).toHaveLength(before);
    x.store.updateSession('s1', { model: 'nope' });
    await go(x, WF.replace('model-b', 'nope'), 'bad.reins.md');
    await x.s.idle();
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('a model block with only a usd: slice names no model: the run is not refused as an unknown model', async () => {
    const x = setup([{ usage: 1000 }, {}], { describe: (_e: string, m: string) => ({ listed: m === 'model-b', label: m, estimate: 0.01 }) });
    x.s.message('first');
    await x.s.idle();
    x.store.updateSession('s1', { model: 'model-b' });
    const front = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: 2.00 }\nalways: []\n---\n\n';
    const file = put(x.cwd, 'slice.reins.md', `${front}## model\nusd: 0.50\n\n## phase one\n> Go.\n`);
    expect(x.s.runFile(file)).toEqual({ ok: true });
  });

  it('resume refuses a model the provider no longer lists, with nothing logged', async () => {
    let known = true;
    const x = setup([{ usage: 1000 }, {}], { describe: (_e: string, m: string) => ({ listed: m !== 'nope' && (known || m !== 'model-b'), label: m, estimate: 0.01 }) });
    x.s.message('first');
    await x.s.idle();
    x.store.putSetting('switchApprovalTokens', 500);
    await go(x);
    await x.question('switch');
    await x.s.shutdown();
    known = false;
    const s2 = x.reopen();
    const before = x.log().length;
    expect(s2.resume(rid(x))).toEqual({ ok: false, code: 400, error: "Unknown model model-b in step `model-1`: it is not in this session's provider list." });
    expect(x.log()).toHaveLength(before);
  });

  it('with no price known the card says so (P3: no price asks)', async () => {
    const x = await ready({ describe: false });
    await go(x);
    const q = await x.question('switch');
    expect(q.prompt).toBe('Switch to model-b?');
    expect(q.detail).toBe("The whole conversation, 1,000 tokens, goes to model-b as input. No price is known for model-b, so the cost cannot be estimated.\nAsked by the workflow's model block `model-1`.");
    x.s.answer(q.id, 'keep');
    await x.s.idle();
  });

  it('shutdown at the USD question detaches the run too, with the run\'s own numbers', async () => {
    const x = setup([{ cost: 0.01 }, { cost: 0.01 }]);
    await go(x, `---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: 0.005 }\nalways: []\n---\n\n## phase one\n> Go.\n\n## phase two\n> Again.\n`);
    const q = await x.question('usd');
    expect(x.data('budget_reached')).toEqual([{ usd: 0.005, spent: 0.01 }]);
    await x.s.shutdown();
    expect(x.data('question_closed')).toEqual([{ questionId: q.id, why: 'the server stopped' }]);
    expect(x.rows('run_detached')).toEqual([expect.objectContaining({ runId: rid(x) })]);
    expect(x.rows('run_stopped')).toEqual([]);
    expect(x.t.turns).toHaveLength(1);
  });
});

describe('compress (B)', () => {
  const autoNote = (n: number, pct: number, w = '1,000,000') =>
    `The context, ${n.toLocaleString('en-US')} tokens, is at or over ${pct}% of the ${w}-token window: compressing before the next reply.`;
  const stillNote = 'The context is still at or over 50% of the window after compressing, so Reins does not compress again before this reply.';
  const notes = (x: ReturnType<typeof setup>) => x.data('note').map((d) => d.text as string);
  const compactedRows = (x: ReturnType<typeof setup>) => x.data('engine').filter((d) => d.type === 'compacted');

  it('is 409 before any message, and while busy', async () => {
    const x = setup([{ hold: true }]);
    expect(x.s.compress()).toEqual({ ok: false, code: 409, error: 'Nothing to compress yet: send a message first.' });
    x.s.message('one');
    await turnsStarted(x, 1);
    expect(x.s.compress()).toEqual({ ok: false, code: 409, error: 'Compress when the session is idle.' });
    x.t.release();
    await x.s.idle();
    expect(x.t.compacts).toBe(0);
  });

  it('is 409 while a run is left paused (as a model switch is)', async () => {
    const x = setup([{}]);
    x.s.message('one');
    await x.s.idle();
    x.store.appendLog('s1', { type: 'run_detached', runId: 'r1', data: {} });
    expect(x.s.compress()).toEqual({ ok: false, code: 409, error: 'A run is left paused in this session. Resume or stop it before compressing.' });
    expect(x.t.compacts).toBe(0);
  });

  it('after a turn: the /compress user row, the compacted row, a turn_ended with the cost, idle; it is not a message turn', async () => {
    const x = setup([{}, {}]);
    x.s.message('one');
    await x.s.idle();
    const from = x.log().length;
    expect(x.s.compress()).toEqual({ ok: true });
    await x.s.idle();
    expect(x.log().slice(from).filter((r) => r.type !== 'status').map((r) => [r.type, r.data])).toEqual([
      ['message', { role: 'user', text: '/compress' }],
      ['engine', { type: 'compacted', trigger: 'manual', before: 1000, after: 100 }],
      ['turn_ended', { text: '', cost: 0.01 }],
    ]);
    expect(x.t.compacts).toBe(1);
    expect(x.t.turns).toEqual(['one']);
    expect(x.s.status()).toBe('idle');
  });

  it("the reply after a compaction is charged only its own cost, and the stored total is the running total", async () => {
    const x = setup([{ total: 0.5, usage: 1000 }, { total: 0.6, cost: 0.1 }, { total: 0.75, cost: 0.15 }]);
    x.s.message('one');
    await x.s.idle();
    x.s.compress();
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    expect(x.data('turn_ended').map((d) => d.cost)).toEqual([0.01, 0.1, 0.15]);
    expect(x.store.getEngineTotal(x.store.getSession('s1')!.engineSessionId!)).toBe(0.75);
    // a restart counts from that total
    await x.s.shutdown();
    const s2 = x.reopen();
    s2.message('three');
    await s2.idle();
    expect(x.t.opens.at(-1)!.costBase).toBe(0.75);
  });

  it('closes a waiting switch card (work started before it was answered)', async () => {
    const x = setup([{ usage: 300_000 }, {}]);
    x.s.message('one');
    await x.s.idle();
    x.s.settings({ model: 'model-b', estimate: 0.01, label: 'Test model' });
    const q = x.rows('question').at(-1)!.data as { id: string; kind: string };
    expect(q.kind).toBe('switch');
    expect(x.s.compress()).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('question_closed').at(-1)).toEqual({ questionId: q.id, why: 'work started before it was answered' });
    expect(x.store.getSession('s1')!.model).toBeUndefined();
  });

  it('an engine session without compact fails the turn: "This provider cannot compress."', async () => {
    const store = openStore(':memory:');
    const t = testEngine([{}]);
    const makeEngine: MakeEngine = (e) => {
      const eng = t.makeEngine(e);
      return { ...eng, open: async (o) => { const s = await eng.open(o); delete s.compact; return s; } };
    };
    const row = store.createSession({ id: 's1', cwd: tmp(), engine: 'claude' });
    const s = openSession({ store, makeEngine, dir: tmp() }, row, true);
    s.message('one');
    await s.idle();
    expect(s.compress()).toEqual({ ok: true });
    await s.idle();
    const failed = store.readLog('s1').filter((r) => r.type === 'turn_failed');
    expect(failed.map((r) => r.data)).toEqual([{ error: 'This provider cannot compress.' }]);
    expect(store.readLog('s1').filter((r) => r.type === 'note')).toEqual([]); // no "dropped" note: the process is healthy
    expect(t.compacts).toBe(0);
    expect(s.status()).toBe('idle');
  });

  it('Stop during a held compaction interrupts it like a turn', async () => {
    const x = setup([{}, { hold: true }]);
    x.s.message('one');
    await x.s.idle();
    x.s.compress();
    await until(() => x.t.compacts === 1);
    expect(x.s.card('', 'stop')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.t.interrupts).toBe(1);
    expect(compactedRows(x)).toEqual([]);
    expect(x.s.status()).toBe('idle');
  });

  describe('auto-compress', () => {
    it('at or over autoCompressAt of the window it compresses first, then sends the reply; the reply carries both costs; the next message does not compress again', async () => {
      const x = setup([{ usage: 600_000 }, {}, {}, {}]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      expect(x.t.compacts).toBe(0);
      x.s.message('two');
      await x.s.idle();
      expect(notes(x)).toEqual([autoNote(600_000, 50)]);
      expect(x.t.compacts).toBe(1);
      expect(x.t.turns).toEqual(['one', 'two']);
      expect(x.data('turn_ended').at(-1)).toEqual({ text: 'ok', cost: 0.02 });
      x.s.message('three');
      await x.s.idle();
      expect(x.t.compacts).toBe(1);
      expect(notes(x)).toHaveLength(1);
    });

    it('under the threshold nothing is compressed; the default is 90% of the window', async () => {
      const under = setup([{ usage: 400_000 }, {}, {}]);
      under.store.putSetting('autoCompressAt', 0.5);
      under.s.message('one');
      await under.s.idle();
      under.s.message('two');
      await under.s.idle();
      expect(under.t.compacts).toBe(0);

      const below = setup([{ usage: 899_999 }, {}, {}]);
      below.s.message('one');
      await below.s.idle();
      below.s.message('two');
      await below.s.idle();
      expect(below.t.compacts).toBe(0);

      const at = setup([{ usage: 900_000 }, {}, {}, {}]);
      at.s.message('one');
      await at.s.idle();
      at.s.message('two');
      await at.s.idle();
      expect(at.t.compacts).toBe(1);
      expect(notes(at)).toEqual([autoNote(900_000, 90)]);
    });

    it('autoCompressAt 1 is off: even a full window is not compressed', async () => {
      const x = setup([{ usage: 1_000_000 }, {}, {}]);
      x.store.putSetting('autoCompressAt', 1);
      x.s.message('one');
      await x.s.idle();
      x.s.message('two');
      await x.s.idle();
      expect(x.t.compacts).toBe(0);
      expect(x.t.turns).toEqual(['one', 'two']);
      expect(notes(x)).toEqual([]);
    });

    it('in a run, its note carries the run id', async () => {
      const x = setup([{ usage: 600_000 }, {}, { text: 'REINS: done' }]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      x.s.runFile(put(x.cwd, 'a.reins.md', ECHO));
      const q = await x.question('trust');
      x.s.answer(q.id, 'y');
      await x.s.idle();
      const runId = x.rows('run_started')[0]!.runId!;
      const note = x.rows('note').find((r) => (r.data as { text: string }).text === autoNote(600_000, 50))!;
      expect(note.runId).toBe(runId);
      expect(x.t.compacts).toBe(1);
    });

    it('no progress: when the size measured right after a compaction is still over, it skips, with one note', async () => {
      const x = setup([{ usage: 600_000 }, {}, { usage: 700_000 }, {}, {}]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      x.s.message('two'); // compresses; its reply is measured at 700k, still over
      await x.s.idle();
      expect(x.t.compacts).toBe(1);
      x.s.message('three');
      await x.s.idle();
      expect(x.t.compacts).toBe(1);
      expect(notes(x)).toEqual([autoNote(600_000, 50), stillNote]);
      expect(x.t.turns).toEqual(['one', 'two', 'three']);
    });

    it('a Stop while the engine is opening (after a switch) sends nothing', async () => {
      const x = setup([{ usage: 1000 }, {}]);
      x.s.message('one');
      await x.s.idle();
      x.t.holdClose();
      x.s.settings({ model: 'model-b', estimate: 0.01, label: 'Test model' });
      x.s.message('hi');
      expect(x.s.card('', 'stop')).toEqual({ ok: true });
      x.t.releaseClose();
      await x.s.idle();
      expect(x.t.turns).toEqual(['one']);
    });

    it('no progress holds for every reply while the context stays over, one note each; a reply under the limit lets it compress again', async () => {
      const x = setup([{ usage: 600_000 }, {}, { usage: 700_000 }, { usage: 700_000 }, {}]);
      x.store.putSetting('autoCompressAt', 0.5);
      for (const m of ['one', 'two', 'three', 'four']) {
        x.s.message(m);
        await x.s.idle();
      }
      expect(x.t.compacts).toBe(1);
      expect(notes(x)).toEqual([autoNote(600_000, 50), stillNote, stillNote]);

      const y = setup([{ usage: 600_000 }, {}, { usage: 100_000 }, { usage: 600_000 }, {}, {}]);
      y.store.putSetting('autoCompressAt', 0.5);
      for (const m of ['one', 'two', 'three', 'four']) {
        y.s.message(m);
        await y.s.idle();
      }
      expect(y.t.compacts).toBe(2);
      expect(notes(y)).toEqual([autoNote(600_000, 50), autoNote(600_000, 50)]);
    });

    it("the compaction's cost is logged when the reply after it fails", async () => {
      const x = setup([{ usage: 600_000 }, { cost: 0.02 }, { reject: 'x' }]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      x.s.message('two');
      await x.s.idle();
      expect(x.data('turn_failed')).toEqual([{ error: 'x' }]);
      expect(x.data('turn_ended').map((d) => d.cost)).toEqual([0.01, 0.02]);
    });

    it('after a model switch the old window is not known, so the first reply is not compressed', async () => {
      const x = setup([{ usage: 190_000, window: 200_000 }, {}, {}]);
      x.s.message('one');
      await x.s.idle();
      x.s.settings({ model: 'model-b', estimate: 0.01, label: 'Test model' });
      x.s.message('two');
      await x.s.idle();
      expect(x.t.compacts).toBe(0);
      expect(x.t.turns).toEqual(['one', 'two']);
    });

    it('in a run, a Stop during the auto-compaction does not send the reply', async () => {
      const x = setup([{ usage: 600_000 }, { hold: true }, {}]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      x.s.message('two', [{ tag: 'read-only' }]);
      await until(() => x.t.compacts === 1);
      expect(x.s.card('', 'stop')).toEqual({ ok: true });
      // a stop pauses the run, which asks resume / stop; answering stop ends it
      const r = await x.question('resume');
      x.s.answer(r.id, 'stop');
      await x.s.idle();
      expect(x.t.turns).toEqual(['one']);
      expect(x.s.status()).toBe('idle');
    });

    it('a Stop during the auto-compaction returns without sending the reply (C3)', async () => {
      const x = setup([{ usage: 600_000 }, { hold: true }, {}]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      x.s.message('two');
      await until(() => x.t.compacts === 1);
      expect(x.s.card('', 'stop')).toEqual({ ok: true });
      await x.s.idle();
      expect(x.t.turns).toEqual(['one']);
      expect(x.rows('turn_ended')).toHaveLength(2);
      expect(x.s.status()).toBe('idle');
    });
  });
});

describe('per-model cost (C)', () => {
  type X = ReturnType<typeof setup>;
  const sidOf = (x: X) => x.store.getSession('s1')!.engineSessionId!;
  const stored = (x: X) => x.store.getEngineModels(sidOf(x));
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  const describeB = (_e: string, m: string) => ({ listed: true, label: m === 'model-b' ? 'B' : m, estimate: 0.01 });
  const WF_B = `${FRONT}## model model-b\n\n## phase one\n> Go.\n`;
  const WF_B4 = `${FRONT}## model model-b\n\n## phase one\n> a\n\n## phase two\n> b\n\n## phase three\n> c\n\n## phase four\n> d\n`;
  const WF_P = `${FRONT}## phase one\n> Go.\n`;
  /** Runs `text` from a trusted file to its end; returns the run id. */
  const runIt = async (x: X, text: string) => {
    expect(x.s.runFile(put(x.cwd, 'w.reins.md', text))).toEqual({ ok: true });
    const q = await x.question('trust');
    x.s.answer(q.id, 'y');
    await x.s.idle();
    return x.rows('run_started')[0]!.runId!;
  };
  const runEvents = (x: X, rid: string, type: string) => x.store.loadRun(rid)!.snapshot.events.filter((e) => e.type === type).map((e) => e.data as any);
  const receiptOf = (x: X) => x.data('receipt')[0] as { models?: Array<{ model: string; usd: number; turns: number; label?: string }>; unsplitUsd?: number; totalCostUsd: number };
  /** The money rule: the receipt's split plus what it could not split is the total. */
  const addsUp = (r: ReturnType<typeof receiptOf>) =>
    expect((r.models ?? []).reduce((a, m) => a + m.usd, 0) + (r.unsplitUsd ?? 0)).toBeCloseTo(r.totalCostUsd, 9);

  it('a plain reply stores its per-model totals; a restart opens with them as its base; plain turn_ended rows carry no models', async () => {
    const x = setup([
      { cost: 0.5, total: 0.5, models: { a: 0.5 }, totals: { a: 0.5 } },
      { cost: 0.25, total: 0.75, models: { a: 0.25 }, totals: { a: 0.75 } },
    ]);
    x.s.message('one');
    await x.s.idle();
    expect(stored(x)).toEqual({ a: 0.5 });
    expect(x.t.opens[0]).not.toHaveProperty('costBaseByModel');
    await x.s.shutdown();
    const s2 = x.reopen();
    s2.message('two');
    await s2.idle();
    expect(x.t.opens[1]!.costBaseByModel).toEqual({ a: 0.5 });
    expect(stored(x)).toEqual({ a: 0.75 });
    expect(x.data('turn_ended').map((d) => d.cost)).toEqual([0.5, 0.25]);
    for (const d of x.data('turn_ended')) expect(d).not.toHaveProperty('models');
  });

  it('a legacy row (a total, no per-model totals) opens with no per-model base; its reply has no split, the next is split, and the receipt adds up', async () => {
    const x = setup([
      { usage: 1000, model: 'model-b', cost: 0.1, total: 0.3, totals: { 'model-b': 0.3 } }, // the adapter has no base: no `models`
      { usage: 1000, model: 'model-b', cost: 0.2, total: 0.5, totals: { 'model-b': 0.5 }, models: { 'model-b': 0.2 } },
    ], { describe: describeB });
    x.store.updateSession('s1', { engineSessionId: 'old', model: 'model-b' });
    x.store.putEngineTotal('old', 0.2);
    const rid = await runIt(x, `${FRONT}## phase one\n> a\n\n## phase two\n> b\n`);
    expect(x.t.opens[0]!.costBase).toBe(0.2);
    expect(x.t.opens[0]).not.toHaveProperty('costBaseByModel');
    expect(runEvents(x, rid, 'engine_cost')).toEqual([{ usd: 0.1 }, { usd: 0.2, models: { 'model-b': 0.2 } }]);
    const r = receiptOf(x);
    expect(r.models).toEqual([{ model: 'model-b', usd: 0.2, turns: 2, label: 'B' }]);
    expect(r.unsplitUsd).toBeCloseTo(0.1, 9);
    expect(r.totalCostUsd).toBeCloseTo(0.3, 9);
    addsUp(r);
    expect(x.store.getEngineModels('old')).toEqual({ 'model-b': 0.5 });
  });

  it('a result with a total and no modelUsage stores no split; that reply and the next are unsplit, the one after is split again', async () => {
    const x = setup([
      { usage: 1000, model: 'model-b', cost: 0.1, total: 0.1, totals: { 'model-b': 0.1 }, models: { 'model-b': 0.1 } },
      { usage: 1000, model: 'model-b', cost: 0.2, total: 0.3 },                                             // no modelUsage
      { usage: 1000, model: 'model-b', cost: 0.3, total: 0.6, totals: { 'model-b': 0.6 } },                 // the adapter's base is gone: no split
      { usage: 1000, model: 'model-b', cost: 0.4, total: 1.0, totals: { 'model-b': 1.0 }, models: { 'model-b': 0.4 } },
    ], { describe: describeB });
    const rid = await runIt(x, WF_B4);
    expect(x.rows('run_finished')).toHaveLength(1);
    const r = receiptOf(x);
    expect(r.models).toEqual([{ model: 'model-b', usd: 0.5, turns: 4, label: 'B' }]);
    expect(r.unsplitUsd).toBeCloseTo(0.5, 9);
    expect(r.totalCostUsd).toBe(1);
    addsUp(r);
    expect(runEvents(x, rid, 'engine_cost').map((d) => d.usd)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(stored(x)).toEqual({ 'model-b': 1 });
  });

  it('stored totals: a total with no modelUsage clears the stored split, so the next open has no per-model base', async () => {
    const x = setup([{ total: 0.5, totals: { a: 0.5 } }, { total: 0.75 }, {}]);
    x.s.message('one');
    await x.s.idle();
    expect(stored(x)).toEqual({ a: 0.5 });
    x.s.message('two');
    await x.s.idle();
    expect(stored(x)).toBeUndefined();
    expect(x.store.getEngineTotal(sidOf(x))).toBe(0.75);
    await x.s.shutdown();
    const s2 = x.reopen();
    s2.message('three');
    await s2.idle();
    expect(x.t.opens[1]).not.toHaveProperty('costBaseByModel');
    expect(x.t.opens[1]!.costBase).toBe(0.75);
  });

  it('a reply that rejects stores nothing, and the next open gets the last stored per-model totals', async () => {
    const x = setup([{ total: 0.5, totals: { a: 0.5 } }, { reject: 'boom', total: 9, totals: { a: 9 } }, { total: 0.7, totals: { a: 0.7 }, models: { a: 0.2 } }]);
    for (const m of ['one', 'two', 'three']) {
      x.s.message(m);
      await x.s.idle();
    }
    expect(x.t.opens.map((o) => o.costBaseByModel)).toEqual([undefined, { a: 0.5 }]);
    expect(stored(x)).toEqual({ a: 0.7 });
  });

  it('an interrupt kill (no total, no figures) keeps the stored per-model totals for the next reply', async () => {
    const x = setup([{ total: 0.5, totals: { a: 0.5 } }, { cost: 0 }, { total: 0.7, totals: { a: 0.7 } }]);
    x.s.message('one');
    await x.s.idle();
    x.s.message('two');
    await x.s.idle();
    expect(stored(x)).toEqual({ a: 0.5 });
    expect(x.store.getEngineTotal(sidOf(x))).toBe(0.5);
    x.s.message('three');
    await x.s.idle();
    expect(stored(x)).toEqual({ a: 0.7 });
  });

  it('a switch inside a run resumes with the stored per-model totals as its base; the run reply is the new model only and the parts add up', async () => {
    const x = setup([
      { usage: 1000, cost: 0.5, total: 0.5, totals: { a: 0.5 }, models: { a: 0.5 } },
      { usage: 1000, model: 'model-b', cost: 0.01, total: 0.51, totals: { a: 0.5, 'model-b': 0.01 }, models: { 'model-b': 0.01 } },
    ], { describe: describeB });
    x.s.message('first');
    await x.s.idle();
    const rid = await runIt(x, WF_B);
    expect(x.models).toEqual([undefined, 'model-b']);
    expect(x.t.opens[1]!.costBaseByModel).toEqual({ a: 0.5 });
    expect(x.t.opens[1]!.costBase).toBe(0.5);
    const [cost] = runEvents(x, rid, 'engine_cost');
    expect(cost).toEqual({ usd: 0.01, models: { 'model-b': 0.01 } });
    expect(sum(cost.models)).toBeCloseTo(cost.usd, 9);
    const r = receiptOf(x);
    expect(r.models).toEqual([{ model: 'model-b', usd: 0.01, turns: 1, label: 'B' }]);
    expect(r).not.toHaveProperty('unsplitUsd');
    expect(r.totalCostUsd).toBe(0.01);
    addsUp(r);
    expect(stored(x)).toEqual({ a: 0.5, 'model-b': 0.01 });
  });

  describe('auto-compaction in a run', () => {
    it('the reply carries the compaction and its split: one engine_cost whose models sum to usd', async () => {
      const x = setup([{ usage: 600_000 }, { cost: 0.01, models: { a: 0.01 } }, { usage: 1000, model: 'a', cost: 0.02, models: { a: 0.02 } }]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      const rid = await runIt(x, WF_P);
      expect(x.t.compacts).toBe(1);
      const evs = runEvents(x, rid, 'engine_cost');
      expect(evs).toHaveLength(1);
      expect(evs[0].usd).toBeCloseTo(0.03, 9);
      expect(evs[0].models.a).toBeCloseTo(0.03, 9);
      expect(sum(evs[0].models)).toBeCloseTo(evs[0].usd, 9);
      const r = receiptOf(x);
      expect(r.models).toEqual([{ model: 'a', usd: expect.closeTo(0.03, 9), turns: 1, label: 'a' }]);
      expect(r).not.toHaveProperty('unsplitUsd');
      addsUp(r);
    });

    it('a reply with no split after a compaction with one: the run gets the compaction\'s split only, and the receipt shows the rest as unsplit', async () => {
      const x = setup([{ usage: 600_000 }, { cost: 0.01, models: { a: 0.01 } }, { usage: 1000, model: 'a', cost: 0.02 }]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      const rid = await runIt(x, WF_P);
      const [c] = runEvents(x, rid, 'engine_cost');
      expect(c.usd).toBeCloseTo(0.03, 9);
      expect(c.models).toEqual({ a: 0.01 });
      const r = receiptOf(x);
      expect(r.models).toEqual([{ model: 'a', usd: 0.01, turns: 1, label: 'a' }]);
      expect(r.unsplitUsd).toBeCloseTo(0.02, 9);
      expect(r.totalCostUsd).toBeCloseTo(0.03, 9);
      addsUp(r);
    });

    it("when the reply fails, the compaction's dollars go to its own turn_ended with no split and none to the run", async () => {
      const x = setup([{ usage: 600_000 }, { cost: 0.02, models: { a: 0.02 } }, { reject: 'x' }]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      expect(x.s.runFile(put(x.cwd, 'w.reins.md', WF_P))).toEqual({ ok: true });
      const q = await x.question('trust');
      x.s.answer(q.id, 'y');
      await x.s.idle();
      const rid = x.rows('run_started')[0]!.runId!;
      expect(x.rows('run_detached')).toHaveLength(1);
      expect(x.data('turn_ended')).toEqual([{ text: 'ok', cost: 0.01 }, { text: '', cost: 0.02 }]);
      expect(runEvents(x, rid, 'engine_cost')).toEqual([]);
    });

    it('a Stop during the compaction still hands the run its cost and split', async () => {
      const x = setup([{ usage: 600_000 }, { hold: true, cost: 0.02, models: { a: 0.02 } }, {}]);
      x.store.putSetting('autoCompressAt', 0.5);
      x.s.message('one');
      await x.s.idle();
      x.s.message('two', [{ tag: 'read-only' }]);
      await until(() => x.t.compacts === 1);
      expect(x.s.card('', 'stop')).toEqual({ ok: true });
      const r = await x.question('resume');
      x.s.answer(r.id, 'stop');
      await x.s.idle();
      expect(x.t.turns).toEqual(['one']);
      const rid = x.rows('run_started')[0]!.runId!;
      expect(runEvents(x, rid, 'engine_cost')).toEqual([{ usd: 0.02, models: { a: 0.02 } }]);
    });
  });
});