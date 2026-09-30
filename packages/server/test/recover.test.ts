// The restart rules (plan 15d 3b.7 lines 1554-1564, 3b.3 line 1395) and the 3b.8 restart scenarios.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Question } from '../src/drive.js';
import { recover } from '../src/recover.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine, type TestTurn } from './test-engine.js';

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-rec-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

function world() {
  const store = openStore(':memory:');
  store.createSession({ id: 's1', cwd: '/x', engine: 'claude' });
  const add = (type: string, data: unknown = {}, runId?: string) => store.appendLog('s1', { type, data, ...(runId ? { runId } : {}) });
  const recovered = () => {
    const n = store.readLog('s1').length;
    recover(store);
    return store.readLog('s1').slice(n).map((r) => [r.type, r.runId, r.data] as const);
  };
  return { store, add, recovered };
}
type World = ReturnType<typeof world>;

describe('recover: the rules over a log (3b.7)', () => {
  it('closes every question that is still open, with its run id, and only those', () => {
    const w = world();
    w.add('question', { id: 'q1', kind: 'tool', prompt: 'p' }, 'r1');
    w.add('question', { id: 'q2', kind: 'trust', prompt: 'p' });
    w.add('question', { id: 'q3', kind: 'tool', prompt: 'p' });
    w.add('answer', { questionId: 'q3', answer: 'y' });
    w.add('question', { id: 'q4', kind: 'gate', prompt: 'p' });
    w.add('question_closed', { questionId: 'q4', why: 'x' });
    w.add('status', { status: 'waiting' });
    expect(w.recovered()).toEqual([
      ['question_closed', 'r1', { questionId: 'q1', why: 'the server restarted' }],
      ['question_closed', undefined, { questionId: 'q2', why: 'the server restarted' }],
      ['status', undefined, { status: 'idle' }],
    ]);
  });

  it('detaches every run that has not ended and is not already detached', () => {
    const w = world();
    for (const r of ['r1', 'r2', 'r3', 'r4', 'r5']) w.add('run_started', {}, r);
    w.add('run_finished', {}, 'r2');
    w.add('run_stopped', {}, 'r3');
    w.add('engine', { type: 'text', text: 'late' }, 'r3');
    w.add('run_detached', {}, 'r4');
    w.add('run_detached', {}, 'r5');
    w.add('note', { text: 'Resumed run r5.' }, 'r5');
    w.add('status', { status: 'running' });
    expect(w.recovered()).toEqual([
      ['run_detached', 'r1', {}],
      ['run_detached', 'r5', {}],
      ['status', undefined, { status: 'idle' }],
    ]);
  });

  it('an untagged message with no later turn_ended or turn_failed is a turn that was in flight', () => {
    const msg = (w: World, extra: object = {}) => w.add('message', { role: 'user', text: 'hi', ...extra });
    const cases: Array<[string, (w: World) => void, boolean]> = [
      ['in flight', (w) => msg(w), true],
      ['a leftover-card turn in flight', (w) => msg(w, { fromCards: true }), true],
      ['ended', (w) => { msg(w); w.add('turn_ended', { text: 'x' }); }, false],
      ['failed', (w) => { msg(w); w.add('turn_failed', { error: 'x' }); }, false],
      ['a tagged message is a run, not a plain turn', (w) => msg(w, { tags: [{ tag: 'gate' }] }), false],
      ['an earlier turn ended and the latest is in flight', (w) => { msg(w); w.add('turn_ended', { text: 'x' }); msg(w); }, true],
    ];
    for (const [label, setup, inFlight] of cases) {
      const w = world();
      setup(w);
      const failed = w.recovered().filter((r) => r[0] === 'turn_failed');
      expect(failed, label).toEqual(inFlight ? [['turn_failed', undefined, { error: 'server restarted' }]] : []);
    }
  });

  it('cards_unsent is rebuilt from the session card_queued rows after the last row that empties the queue', () => {
    const q = (w: World, card: string, kind = 'steer', runId?: string) => w.add('card_queued', { card, kind }, runId);
    const cases: Array<[string, (w: World) => void, string[]]> = [
      ['no cards', () => {}, []],
      ['steer and now cards', (w) => { q(w, 'a'); q(w, 'b', 'now'); }, ['a', 'b']],
      ['a stop card is not a card to send', (w) => { q(w, 'a'); q(w, 's', 'stop'); }, ['a']],
      ['a card with a run id belongs to the run', (w) => q(w, 'a', 'steer', 'r1'), []],
      ['a cards_unsent row empties the queue', (w) => { q(w, 'a'); w.add('cards_unsent', { cards: ['a'] }); q(w, 'b'); }, ['b']],
      ['a fromCards message empties it', (w) => { q(w, 'a'); w.add('message', { role: 'user', text: 'a', fromCards: true }); }, []],
      ['a plain message does not', (w) => { q(w, 'a'); w.add('message', { role: 'user', text: 'm' }); }, ['a']],
      ['run_started empties it', (w) => { q(w, 'a'); w.add('run_started', {}, 'r1'); }, []],
      ['a note with a run id empties it', (w) => { q(w, 'a'); w.add('note', { text: 'Resumed run r1.' }, 'r1'); }, []],
      ['a note without a run id does not', (w) => { q(w, 'a'); w.add('note', { text: 'x' }); }, ['a']],
      ['a session mid-turn delivery empties it', (w) => { q(w, 'a'); w.add('engine', { type: 'card_delivered', card: 'a', channel: 'mid-turn' }); }, []],
      ['a mid-turn delivery inside a run does not', (w) => { q(w, 'a'); w.add('engine', { type: 'card_delivered', card: 'a', channel: 'mid-turn' }, 'r1'); }, ['a']],
    ];
    for (const [label, setup, cards] of cases) {
      const w = world();
      setup(w);
      const unsent = w.recovered().filter((r) => r[0] === 'cards_unsent');
      expect(unsent, label).toEqual(cards.length ? [['cards_unsent', undefined, { cards }]] : []);
    }
  });

  it('logs its rows in the spec order, and a second start adds nothing', () => {
    const w = world();
    w.add('run_started', {}, 'r1');
    w.add('question', { id: 'q1', kind: 'gate', prompt: 'p' }, 'r1');
    w.add('message', { role: 'user', text: 'hi' });
    w.add('card_queued', { card: 'a', kind: 'steer' });
    w.add('status', { status: 'waiting' });
    expect(w.recovered().map((r) => r[0])).toEqual(['question_closed', 'run_detached', 'turn_failed', 'cards_unsent', 'status']);
    expect(w.recovered()).toEqual([]);
  });

  it('a closed or idle session gets no status row, an empty log gets nothing, and every session is recovered', () => {
    const closed = world();
    closed.add('status', { status: 'closed' });
    expect(closed.recovered()).toEqual([]);
    const idle = world();
    idle.add('status', { status: 'idle' });
    expect(idle.recovered()).toEqual([]);
    expect(world().recovered()).toEqual([]);
    const w = world();
    w.store.createSession({ id: 's2', cwd: '/y', engine: 'claude' });
    w.store.appendLog('s2', { type: 'question', data: { id: 'q', kind: 'tool', prompt: 'p' } });
    recover(w.store);
    expect(w.store.readLog('s2').map((r) => r.type)).toEqual(['question', 'question_closed']);
  });
});

const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n';
const WITH_BLOCK = `${FRONT}## use rp\n\n## gate\nuntil: you approve\n\n## phase go\n> do it\n`;
const rp = (cmd: string) => `---\nreins: 1\nblock: rp\n---\n\n## run \`${cmd}\`\n`;
const put = (dir: string, name: string, text: string) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

function boot(script: TestTurn[] = []) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const dir = tmp();
  const cwd = tmp();
  store.createSession({ id: 's1', cwd, engine: 'claude' });
  const start = (fresh = false) => openSession({ store, makeEngine: t.makeEngine, dir }, store.getSession('s1')!, fresh);
  const restart = () => { recover(store); return start(); };
  const log = () => store.readLog('s1');
  const rows = (type: string) => log().filter((r) => r.type === type);
  const gates = () => rows('question').filter((r) => (r.data as Question).kind === 'gate').length;
  const question = async (kind?: Question['kind']) => {
    const open = (): Question[] => {
      const l = log();
      return l.filter((r) => r.type === 'question').map((r) => r.data as Question)
        .filter((q) => !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
    };
    await until(() => open().some((q) => !kind || q.kind === kind));
    return open().find((q) => !kind || q.kind === kind)!;
  };
  return { store, t, dir, cwd, start, restart, log, rows, gates, question };
}
type Boot = ReturnType<typeof boot>;

async function detachedFileRun(x: Boot) {
  put(x.cwd, 'blocks/rp.reins.md', rp('echo one'));
  const s = x.start(true);
  s.runFile(put(x.cwd, 'a.reins.md', WITH_BLOCK));
  s.answer((await x.question('trust')).id, 'y');
  await x.question('gate');
  await s.shutdown();
  return x.rows('run_started')[0]!.runId!;
}

describe('recover: restart scenarios (3b.8)', () => {
  it('a restart during a resumed run logs a new run_detached for it, and it can be resumed again', async () => {
    const x = boot([{ text: 'REINS: done' }]);
    const runId = await detachedFileRun(x);
    expect(x.rows('run_detached')).toHaveLength(1);
    expect(x.start().resume(runId)).toEqual({ ok: true });
    await until(() => x.gates() === 2);
    recover(x.store);
    expect(x.rows('run_detached')).toHaveLength(2);
    const n = x.log().length;
    recover(x.store);
    expect(x.log()).toHaveLength(n);
    const s3 = x.start();
    expect(s3.resume(runId)).toEqual({ ok: true });
    s3.answer((await x.question('gate')).id, 'approve');
    await s3.idle();
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('a card typed during a /resume trust question, then y, then a restart: no cards_unsent, and the card is delivered once', async () => {
    const x = boot([{ text: 'REINS: done' }]);
    const runId = await detachedFileRun(x);
    put(x.cwd, 'blocks/rp.reins.md', rp('echo two'));
    const s2 = x.start();
    s2.resume(runId);
    const q = await x.question('trust');
    expect(s2.message('typed')).toEqual({ ok: true });
    s2.answer(q.id, 'y');
    await until(() => x.gates() === 2);
    const s3 = x.restart();
    expect(x.rows('cards_unsent')).toEqual([]);
    s3.resume(runId);
    s3.answer((await x.question('gate')).id, 'approve');
    await s3.idle();
    expect(x.t.turns.filter((t) => t.includes('typed'))).toHaveLength(1);
    expect(x.rows('cards_unsent')).toEqual([]);
  });

  it('a steer card, then two now cards in one plain turn, then a restart: the resent turn has all three cards and no cards_unsent is logged', async () => {
    const x = boot([{ hold: true }, { hold: true }]);
    const s = x.start(true);
    s.message('plain');
    await until(() => x.t.turns.length === 1);
    s.message('S');
    s.card('N1', 'now');
    s.card('N2', 'now');
    await until(() => x.t.turns.length === 2);
    expect(x.t.turns[1]).toBe('N1\n\nS\n\nN2');
    x.restart();
    expect(x.rows('cards_unsent')).toEqual([]);
    expect(x.rows('turn_failed').map((r) => r.data)).toEqual([{ error: 'server restarted' }]);
  });

  it('a steer card sent to a run waiting at a gate, then a restart: the card is in the run snapshot, and /resume delivers it once', async () => {
    const x = boot([{ text: 'REINS: done' }, { text: 'ok' }]);
    const s1 = x.start(true);
    s1.message('go', [{ tag: 'gate' }]);
    await x.question('gate');
    expect(s1.message('typed')).toEqual({ ok: true });
    const runId = x.rows('run_started')[0]!.runId!;
    const s2 = x.restart();
    expect(x.rows('cards_unsent')).toEqual([]);
    expect(x.store.loadRun(runId)!.snapshot.pendingCards).toEqual(['typed']);
    expect(x.rows('run_detached')).toHaveLength(1);
    expect(s2.resume(runId)).toEqual({ ok: true });
    s2.answer((await x.question('gate')).id, 'approve');
    await s2.idle();
    expect(x.t.turns.filter((t) => t.includes('typed'))).toHaveLength(1);
    expect(x.rows('cards_unsent')).toEqual([]);
  });

  it('/close during a run turn, then a restart: no run_detached for that run', async () => {
    const x = boot([{ hold: true }]);
    const s = x.start(true);
    s.message('go', [{ tag: 'read-only' }]);
    await until(() => x.t.turns.length === 1);
    await s.close();
    expect(x.rows('run_stopped')).toHaveLength(1);
    x.restart();
    expect(x.rows('run_detached')).toEqual([]);
  });

  it('two restarts in a row after a plain turn is cut off with a card queued: one cards_unsent and one turn_failed in total', async () => {
    const x = boot([{ hold: true }]);
    const s = x.start(true);
    s.message('plain');
    await until(() => x.t.turns.length === 1);
    s.message('typed');
    x.restart();
    x.restart();
    expect(x.rows('cards_unsent').map((r) => r.data)).toEqual([{ cards: ['typed'] }]);
    expect(x.rows('turn_failed').map((r) => r.data)).toEqual([{ error: 'server restarted' }]);
    expect(x.rows('status').at(-1)!.data).toEqual({ status: 'idle' });
  });

  it('two restarts in a row after a stopped plain turn with a queued card: the stop logged the one cards_unsent, the restarts add none', async () => {
    const x = boot([{ hold: true }]);
    const s = x.start(true);
    s.message('plain');
    await until(() => x.t.turns.length === 1);
    s.message('typed');
    expect(s.card('halt', 'stop')).toEqual({ ok: true });
    await s.idle();
    x.restart();
    x.restart();
    expect(x.rows('cards_unsent').map((r) => r.data)).toEqual([{ cards: ['typed'] }]);
    expect(x.rows('turn_failed')).toEqual([]);
  });
});
