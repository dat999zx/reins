// M5 T6: the session seam of a parallel run: the write guard on both policy sites, the USD cap before a new model call, the gone-folder 409.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Question } from '../src/drive.js';
import { openSession, type SessionDeps } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack();

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-par-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

const WORDS = 'The parallel run "r" has spent $5.00 of its $5.00 cap, so no new model call starts. Raise the cap in the rail, then Resume.';

function setup(script: TestTurn[] = [], o: { fenced?: boolean; words?: string } = {}) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const dir = tmp();
  const cwd = tmp();
  const state = { fenced: o.fenced ?? true, words: o.words as string | undefined };
  const parallel: NonNullable<SessionDeps['parallel']> = { fenced: () => state.fenced, capWords: () => state.words };
  const deps = { store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir, parallel };
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  const s = openSession(deps, row, true);
  const reopen = () => openSession(deps, store.getSession('s1')!);
  const log = () => store.readLog('s1');
  const rows = (type: string) => log().filter((r) => r.type === type);
  const data = (type: string) => rows(type).map((r) => r.data as any);
  const question = async (kind: Question['kind']) => {
    const open = () => {
      const l = log();
      return l.filter((r) => r.type === 'question').map((r) => r.data as Question)
        .filter((q) => q.kind === kind && !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as any).questionId === q.id));
    };
    await until(() => open().length > 0);
    return open()[0]!;
  };
  return { store, t, s, reopen, state, cwd, log, rows, data, question };
}

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const put = (dir: string, name: string, text: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
};
const runSub = async (x: ReturnType<typeof setup>) => {
  expect(x.s.runFile(put(x.cwd, 'w.reins.md', `${FRONT}## subagent one\n> Look.\n`))).toEqual({ ok: true });
  x.s.answer((await x.question('trust')).id, 'y');
};

describe('the write guard', () => {
  it('a fenced session\'s engine and subagent policies say inside', async () => {
    const x = setup([{}, { text: 'a' }, { text: 'used' }]);
    x.s.message('first');
    await x.s.idle();
    expect(x.t.opens[0]!.policy()).toEqual({ mode: 'write', guards: [], allowShell: true, inside: true });
    await runSub(x);
    await x.s.idle();
    expect(x.t.opens.length).toBeGreaterThan(1);
    expect(x.t.opens.at(-1)!.policy().inside).toBe(true);
  });

  it('a session that is not fenced gets the same policy object as before, with no inside key', async () => {
    const x = setup([{}, { text: 'a' }, { text: 'used' }], { fenced: false });
    x.s.message('first');
    await x.s.idle();
    const p = x.t.opens[0]!.policy();
    expect(p).toEqual({ mode: 'write', guards: [], allowShell: true });
    expect(p).not.toHaveProperty('inside');
    expect(x.t.opens[0]!.policy()).toBe(p);
    await runSub(x);
    await x.s.idle();
    expect(x.t.opens.at(-1)!.policy()).not.toHaveProperty('inside');
  });
});

describe('the USD cap', () => {
  it('a message at the cap logs turn_failed with the words; the engine gets no turn', async () => {
    const x = setup([{}], { words: WORDS });
    expect(x.s.message('hello')).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('turn_failed')).toEqual([{ error: WORDS }]);
    expect(x.t.turns).toEqual([]);
    expect(x.t.compacts).toBe(0);
    expect(x.t.opens).toEqual([]);
  });

  it('/compress is refused the same way', async () => {
    const x = setup([{}]);
    x.s.message('hello');
    await x.s.idle();
    x.state.words = WORDS;
    expect(x.s.compress()).toEqual({ ok: true });
    await x.s.idle();
    expect(x.data('turn_failed')).toEqual([{ error: WORDS }]);
    expect(x.t.compacts).toBe(0);
    expect(x.t.turns).toEqual(['hello']);
  });

  it('a run at the cap detaches with the words, and Resume runs on once the cap is cleared', async () => {
    const x = setup([{ text: 'REINS: done' }], { words: WORDS });
    x.s.message('go', [{ tag: 'read-only' }]);
    await x.s.idle();
    const runId = x.rows('run_started')[0]!.runId!;
    expect(x.rows('run_detached')).toEqual([expect.objectContaining({ runId, data: { error: WORDS } })]);
    expect(x.t.turns).toEqual([]);
    x.state.words = undefined;
    expect(x.s.resume(runId)).toEqual({ ok: true });
    await x.s.idle();
    expect(x.t.turns).toHaveLength(1);
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('a subagent step at the cap opens no engine and pauses with a resume question carrying the words', async () => {
    const x = setup([{ text: 'a' }], { words: WORDS });
    await runSub(x);
    const q = await x.question('resume');
    expect(x.data('run_paused')).toEqual([expect.objectContaining({ text: expect.stringContaining(WORDS) })]);
    expect(x.t.opens).toEqual([]);
    expect(x.t.turns).toEqual([]);
    x.s.answer(q.id, 'stop');
    await x.s.idle();
  });
});

describe('resume of a fenced session whose folder is gone', () => {
  const detached = async (x: ReturnType<typeof setup>) => {
    x.s.message('go', [{ tag: 'gate' }]);
    await x.question('gate');
    await x.s.shutdown();
    return x.rows('run_started')[0]!.runId!;
  };

  it('is 409 with the words, before the run-ownership check', async () => {
    const x = setup([{ text: 'REINS: done' }]);
    const runId = await detached(x);
    fs.rmSync(x.cwd, { recursive: true, force: true });
    const s2 = x.reopen();
    const words = (rid: string) => ({ ok: false, code: 409, error: `The worktree ${x.cwd} is gone, so run ${rid} cannot resume here.` });
    expect(s2.resume(runId)).toEqual(words(runId));
    expect(s2.resume('nope')).toEqual(words('nope'));
  });

  it('a session that is not fenced has no such 409', async () => {
    const x = setup([{ text: 'REINS: done' }], { fenced: false });
    const runId = await detached(x);
    fs.rmSync(x.cwd, { recursive: true, force: true });
    const r = x.reopen().resume('nope');
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect((r as { error: string }).error).not.toContain('is gone');
    expect(runId).toBeTruthy();
  });
});
