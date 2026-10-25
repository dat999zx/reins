// M2 task 13: a session that runs a split asks every branch's questions at once, keeps each branch's tool cards apart (a card belongs to its owner and
// closes when THAT owner's turn ends), and a Stop settles every question of the run. Driven as the app drives a run: openSession, a real workflow
// file, the toy `split`, and an engine whose sessions are independent (their own plan and their own hold), because the shared script of test-engine.ts
// cannot order two sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { register, type Decision, type EngineSession } from '@reins/core';
import { openSession, type SessionDeps } from '../src/session.js';
import { openStore } from '../src/store.js';
import { split } from '../../core/test/fixtures/split.js';
import { openQuestions } from './http-helpers.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-sessiontracks-')); tmps.push(d); return d; };
const closers: Array<() => Promise<unknown>> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
afterEach(async () => {
  for (const c of closers.splice(0)) await within(c().catch(() => {}), 3000);
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}, 20_000);

async function until(f: () => boolean, ms = 4000) {
  for (let i = 0; i < ms / 5 && !f(); i++) await sleep(5);
  expect(f(), 'the condition was not met in time').toBe(true);
}

interface Plan {
  /** The turn waits here until `release(marker)`, an interrupt or a close. */
  hold?: true;
  /** After the hold: an approval the engine asks for, and waits on. */
  tool?: { tool: string; input: unknown };
  /** After the turn has returned: an approval that arrives late. */
  late?: { tool: string; input: unknown };
  text?: string;
}
interface Sess { id: string; marker?: string; closed: number; interrupts: number; texts: string[] }

/** Engine sessions that are independent. A turn is told apart by a marker in its text (the phase's prompt); a session keeps the marker of its first turn. */
function lab(markers: string[], plans: Record<string, Plan[]> = {}) {
  const sessions: Sess[] = [];
  const decisions: Record<string, Decision[]> = {};
  const held = new Map<string, () => void>();
  const makeEngine: Parameters<typeof openSession>[0]['makeEngine'] = ({ onApprove }) => ({
    id: 'test',
    probe: async () => ({ installed: true, loggedIn: true, capabilities: { midTurnSteer: 'hook', preToolDeny: true, resume: true }, problems: [] }),
    open: async () => {
      const rec: Sess = { id: `lab-${sessions.length + 1}`, closed: 0, interrupts: 0, texts: [] };
      sessions.push(rec);
      let wake: (() => void) | undefined;
      let done: Promise<void> = Promise.resolve();
      let interrupted = false, closing = false;
      const session: EngineSession = {
        sessionId: rec.id,
        turn: async (text) => {
          rec.texts.push(text);
          rec.marker ??= markers.find((m) => text.includes(m));
          const m = rec.marker!;
          const plan = plans[m]?.shift() ?? {};
          interrupted = false;
          let end!: () => void;
          done = new Promise<void>((r) => { end = r; });
          try {
            if (plan.hold) {
              await new Promise<void>((r) => { wake = r; held.set(m, r); });
              wake = undefined; held.delete(m);
              if (closing) throw new Error('closed');
              if (interrupted) return { text: '', events: [], cost: 0 };
            }
            if (plan.tool) (decisions[m] ??= []).push(await onApprove(plan.tool));
            if (plan.late) setTimeout(() => { void onApprove(plan.late!).then((d) => (decisions[`${m}:late`] ??= []).push(d)); }, 20);
            return { text: plan.text ?? 'ok\nREINS: done', events: [], cost: 0.01 };
          } finally { end(); }
        },
        // Like the real adapter: an interrupt of a turn that waits on an approval waits until that question is settled.
        interrupt: async () => { rec.interrupts++; interrupted = true; wake?.(); await done; },
        events: { async *[Symbol.asyncIterator]() {} },
        close: async () => { rec.closed++; closing = true; wake?.(); },
      };
      return session;
    },
  });
  return {
    makeEngine, sessions, decisions,
    release: (m: string) => held.get(m)?.(),
    isHeld: (m: string) => held.has(m),
    of: (m: string) => sessions.find((s) => s.marker === m)!,
  };
}

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n';
const MAIN = '## phase main\n> main-after\n\n## end\n\n';
const split2 = (a: string, b: string, pre = '') => `${pre}## split\nnext: a\nnext: b\n\n${MAIN}${a}${b}`;
const A = '## phase a\n> work-A\n\n## end\n\n';
const B = '## phase b\n> work-B\n\n## end\n\n';
const B_GATE = '## phase b\n> work-B\n\n## gate\nid: gb\nuntil: you approve\n\n## end\n\n';
const A_JUDGE = '## phase a\n> work-A\n\n## gate\nid: ja\nuntil: llm says "fine"\n\n## end\n\n';
const MARKERS = ['work-A', 'work-B', 'main-after', 'pre-main', 'work-S'];

function setup(plans: Record<string, Plan[]> = {}) {
  const store = openStore(':memory:');
  const l = lab(MARKERS, plans);
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  const s = openSession({ store, makeEngine: l.makeEngine, dir: tmp() }, row, true);
  closers.push(() => s.close());
  const open = (kind?: string) => openQuestions(store.readLog('s1')).filter((q) => !kind || q.kind === kind);
  const rows = (type: string) => store.readLog('s1').filter((r) => r.type === type);
  const question = async (kind: string) => { await until(() => open(kind).length > 0); return open(kind)[0]!; };
  const go = async (body: string) => {
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, FRONT + body);
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await question('trust')).id, 'y');
  };
  return { store, s, l, open, rows, question, go };
}

describe('a Stop settles every question of a run with branches', () => {
  it('Stop answered on one branch\'s gate while another branch waits on a judge question: the run ends within 2 s, the judge question is closed, every session is closed', async () => {
    const x = setup();
    await x.go(split2(A_JUDGE, B_GATE));
    const judge = await x.question('judge');
    const gate = await x.question('gate');
    expect(gate.title).toBe('Split split-1');
    x.s.answer(gate.id, 'stop');
    expect(await within(x.s.idle(), 2000)).not.toBe('timeout');
    expect(x.open()).toEqual([]);
    expect(x.rows('question_closed').map((r) => (r.data as { questionId: string }).questionId)).toContain(judge.id);
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.l.sessions).toHaveLength(2);
    expect(x.l.sessions.every((s) => s.closed > 0)).toBe(true);
  });

  it('Stop while a branch waits on a tool approval: the card is closed as a denial, the engine\'s own wait ends, and the run ends within 2 s', async () => {
    const x = setup({ 'work-A': [{ tool: { tool: 'Bash', input: { command: 'ls' } } }] });
    await x.go(split2(A, B_GATE));
    const tool = await x.question('tool');
    const gate = await x.question('gate');
    expect(tool.title).toBe('Split split-1');
    x.s.answer(gate.id, 'stop');
    expect(await within(x.s.idle(), 2000)).not.toBe('timeout');
    expect(x.open()).toEqual([]);
    expect(x.rows('question_closed').map((r) => (r.data as { questionId: string }).questionId)).toContain(tool.id);
    expect(x.l.decisions['work-A']!.map((d) => d.behavior)).toEqual(['deny']);   // the engine side settled
    expect(x.l.sessions.every((s) => s.closed > 0)).toBe(true);
  });

  it('close() with two branch turns in flight: both are interrupted, both processes are closed, the session is closed, and the run\'s own process is not interrupted', async () => {
    const x = setup({ 'work-A': [{ hold: true }], 'work-B': [{ hold: true }], 'pre-main': [{}] });
    await x.go(split2(A, B, '## phase pre\n> pre-main\n\n'));
    await until(() => x.l.isHeld('work-A') && x.l.isHeld('work-B'));
    expect(await within(x.s.close(), 3000)).not.toBe('timeout');
    expect(x.s.status()).toBe('closed');
    for (const m of ['work-A', 'work-B']) {
      expect(x.l.of(m).interrupts, m).toBe(1);
      expect(x.l.of(m).closed, m).toBeGreaterThan(0);
    }
    // the run's own line has no turn open: only a track's turn is, so its process is left alone (it is only closed)
    expect(x.l.of('pre-main').interrupts).toBe(0);
    expect(x.l.of('pre-main').closed).toBeGreaterThan(0);
  });
});

describe('a tool card belongs to its owner', () => {
  it('A\'s turn ends while B\'s tool card is open: B\'s card stays open, and the answer reaches B', async () => {
    const x = setup({ 'work-A': [{ hold: true }], 'work-B': [{ tool: { tool: 'Bash', input: { command: 'ls' } } }] });
    await x.go(split2(A, B));
    const card = await x.question('tool');
    await until(() => x.l.isHeld('work-A'));
    x.l.release('work-A');
    await until(() => x.rows('track_ended').some((r) => (r.data as { track: string }).track === 'a'));
    expect(x.open('tool').map((q) => q.id)).toEqual([card.id]);   // A's turn is over; B's card is not closed with it
    x.s.answer(card.id, 'y');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.l.decisions['work-B']!.map((d) => d.behavior)).toEqual(['allow']);
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('an approval that arrives after its own turn ended is denied with no card; a sibling\'s approval, in a turn that is still open, is asked', async () => {
    const x = setup({
      'work-A': [{ late: { tool: 'Bash', input: { command: 'late' } } }],
      'work-B': [{ hold: true, tool: { tool: 'Bash', input: { command: 'ls' } } }],
    });
    await x.go(split2(A, B));
    await until(() => x.l.isHeld('work-B'));
    await until(() => (x.l.decisions['work-A:late'] ?? []).length > 0);
    expect(x.l.decisions['work-A:late']!.map((d) => d.behavior)).toEqual(['deny']);
    expect(x.rows('question').filter((r) => (r.data as { kind: string }).kind === 'tool')).toEqual([]);   // no card for the late one
    x.l.release('work-B');
    const card = await x.question('tool');   // B's turn is open: its approval is a card, though A's turn has ended
    expect((card as { owner?: string }).owner).toBe('b');
    x.s.answer(card.id, 'y');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.l.decisions['work-B']!.map((d) => d.behavior)).toEqual(['allow']);
  });

  it('a run without branches: the run\'s own approval is a card with no owner, and it closes with its turn', async () => {
    const x = setup({ 'work-S': [{ tool: { tool: 'Bash', input: { command: 'ls' } } }] });
    await x.go('## phase solo\n> work-S\n\n## end\n');
    const card = await x.question('tool');
    expect('owner' in card).toBe(false);
    x.s.answer(card.id, 'y');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.l.decisions['work-S']!.map((d) => d.behavior)).toEqual(['allow']);
    expect(x.open()).toEqual([]);
  });
});

describe('a keyed answer', () => {
  it('Resume with a note on a blocked branch reaches that branch\'s next turn and is no card', async () => {
    const x = setup({ 'work-A': [{ text: 'stuck\nREINS: blocked: no api' }] });
    await x.go(split2(A, B));
    const q = await x.question('resume');
    expect(q.title).toBe('Split split-1');
    x.s.answer(q.id, 'resume try the other API');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    const a = x.l.of('work-A').texts;
    expect(a).toHaveLength(2);
    expect(a[1]).toContain('try the other API');
    expect(a[0]).not.toContain('try the other API');
    expect(x.l.of('work-B').texts.join('\n')).not.toContain('try the other API');
    expect(x.rows('card_queued')).toEqual([]);
    expect(x.rows('run_finished')).toHaveLength(1);
  });
});

// M2 task 14: the folder question once for tracks that start together, and what a server stop does with a run whose branches are at different places.
const FOLDER = { hash: 'h1', key: 'k1', detail: 'the folder holds settings the provider runs', prompt: 'Trust this folder? [y / n]', refused: 'The folder is not trusted.', stopped: 'The session was stopped before the folder was trusted.' };
const C = '## phase c\n> work-C\n\n## end\n\n';
const A_GATE = '## phase a\n> work-A\n\n## gate\nid: ga\nuntil: you approve\n\n## end\n\n';
const split3 = `## split\nnext: a\nnext: b\nnext: c\n\n${MAIN}${A}${B}${C}`;

/** Like `setup`, with the folder question of a protocol (none = a protocol without `folderTrust`) and a way to open the same session again. */
function setupT(plans: Record<string, Plan[]> = {}, folderTrust?: SessionDeps['folderTrust']) {
  const store = openStore(':memory:');
  const l = lab([...MARKERS, 'work-C'], plans);
  const cwd = tmp();
  const dir = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  const deps: SessionDeps = { store, makeEngine: l.makeEngine, dir, ...(folderTrust ? { folderTrust } : {}) };
  const s = openSession(deps, row, true);
  closers.push(() => s.close());
  const open = (kind?: string) => openQuestions(store.readLog('s1')).filter((q) => !kind || q.kind === kind);
  const rows = (type: string) => store.readLog('s1').filter((r) => r.type === type);
  const folderAsks = () => rows('question').filter((r) => (r.data as { prompt: string }).prompt === FOLDER.prompt);
  const workflowTrust = async () => { await until(() => open('trust').some((q) => q.prompt !== FOLDER.prompt)); return open('trust').find((q) => q.prompt !== FOLDER.prompt)!; };
  const folderQuestion = async () => { await until(() => open('trust').some((q) => q.prompt === FOLDER.prompt)); return open('trust').find((q) => q.prompt === FOLDER.prompt)!; };
  const go = async (body: string) => {
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, FRONT + body);
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await workflowTrust()).id, 'y');
  };
  const reopen = () => { const s2 = openSession(deps, store.getSession('s1')!); closers.push(() => s2.close()); return s2; };
  return { store, cwd, s, l, open, rows, folderAsks, folderQuestion, go, reopen };
}
const ask = (): SessionDeps['folderTrust'] => () => FOLDER;

describe('a folder is trusted once for tracks that start together', () => {
  it('three tracks that are the first step in an untrusted folder ask ONE folder question; a yes lets all three go on', async () => {
    const x = setupT({}, ask());
    await x.go(split3);
    const q = await x.folderQuestion();
    await sleep(150);   // the other two tracks have had time to ask
    expect(x.folderAsks()).toHaveLength(1);
    x.s.answer(q.id, 'y');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.folderAsks()).toHaveLength(1);
    expect(x.store.isTrusted(x.cwd, FOLDER.key, FOLDER.hash)).toBe(true);
    for (const m of ['work-A', 'work-B', 'work-C']) expect(x.l.of(m), m).toBeDefined();
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('a no refuses all three tracks with the same reason, asks once, and no process starts', async () => {
    const x = setupT({}, ask());
    await x.go(split3);
    x.s.answer((await x.folderQuestion()).id, 'n');
    await until(() => x.open('resume').length === 3);
    expect(x.folderAsks()).toHaveLength(1);
    expect(x.rows('note').filter((r) => (r.data as { text: string }).text === FOLDER.refused)).toHaveLength(1);
    const failed = x.rows('say').filter((r) => (r.data as { text: string }).text.includes(`failed: ${FOLDER.refused}`));
    expect(failed).toHaveLength(3);
    expect(x.l.sessions).toHaveLength(0);
    expect(x.store.isTrusted(x.cwd, FOLDER.key, FOLDER.hash)).toBe(false);
    x.s.answer(x.open('resume')[0]!.id, 'stop');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
  });

  it('a protocol without a folder question asks none', async () => {
    let calls = 0;
    const x = setupT({}, () => { calls++; return undefined; });
    await x.go(split3);
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(calls).toBeGreaterThan(0);   // it was asked about, and said nothing
    expect(x.folderAsks()).toEqual([]);
    expect(x.rows('question').filter((r) => (r.data as { kind: string }).kind === 'trust')).toHaveLength(1);   // the workflow's own
    expect(x.rows('run_finished')).toHaveLength(1);
  });
});

describe('a server stop with branches', () => {
  it('shutdown with both branches at a gate detaches the run, and Resume restores both from the saved snapshot', async () => {
    const x = setupT();
    await x.go(split2(A_GATE, B_GATE));
    await until(() => x.open('gate').length === 2);
    await x.s.shutdown();
    expect(x.rows('run_detached')).toHaveLength(1);
    expect(x.rows('run_stopped')).toEqual([]);
    const runId = x.rows('run_started')[0]!.runId!;
    const saved = x.store.loadRun(runId)!.snapshot;
    expect(saved.tracks!.map((t) => [t.key, t.status, t.pauseReason?.type])).toEqual([['a', 'paused', 'gate'], ['b', 'paused', 'gate']]);
    expect(x.open('gate')).toEqual([]);
    const s2 = x.reopen();
    expect(s2.resume(runId)).toEqual({ ok: true });
    await until(() => x.open('gate').length === 2);
    for (const g of x.open('gate')) s2.answer(g.id, 'approve');
    expect(await within(s2.idle(), 3000)).not.toBe('timeout');
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.l.sessions.flatMap((s) => s.texts).filter((t) => t.includes('main-after'))).toHaveLength(1);
  });

  it('shutdown with one branch at a gate and the other in the middle of a turn STOPS the run, and never detaches it', async () => {
    const x = setupT({ 'work-A': [{ hold: true }] });
    await x.go(split2(A, B_GATE));
    await until(() => x.open('gate').length === 1 && x.l.isHeld('work-A'));
    expect(await within(x.s.shutdown(), 3000)).not.toBe('timeout');
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([]);
    expect(x.open()).toEqual([]);
    expect(x.l.sessions.every((s) => s.closed > 0)).toBe(true);
  });
});

describe('a track asks like the main run (a pin of what the host already does)', () => {
  const KEYS = ['a', 'b', 'c'];
  const WF = (n: number) => `---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: 5 }\nalways: []\n---\n\n## split\n${KEYS.slice(0, n).map((k) => `next: ${k}\n`).join('')}\n## phase after\n> after\n\n## end\n\n${KEYS.slice(0, n).map((k) => `## phase ${k}\n> ${k}\n\n## end\n\n`).join('')}`;
  function setupE(script: TestTurn[], n: number, settings: Record<string, unknown> = {}) {
    const store = openStore(':memory:');
    const t = testEngine(script);
    const cwd = tmp();
    const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
    for (const [k, v] of Object.entries(settings)) store.putSetting(k, v);
    const s = openSession({ store, makeEngine: t.makeEngine, dir: tmp() }, row, true);
    closers.push(() => s.close());
    const open = (kind: string) => openQuestions(store.readLog('s1')).filter((q) => q.kind === kind);
    const go = async () => {
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, WF(n));
      expect(s.runFile(file)).toEqual({ ok: true });
      await until(() => open('trust').length > 0);
      s.answer(open('trust')[0]!.id, 'y');
    };
    return { t, s, open, go };
  }

  it('`asks`, `step` and `title` never reach engine.open, for any of three tracks', async () => {
    const x = setupE([], 3);
    await x.go();
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.t.opens.length).toBeGreaterThanOrEqual(4);   // three tracks and the main line
    for (const o of x.t.opens) for (const k of ['asks', 'step', 'title']) expect(k in o, k).toBe(false);
  });

  it('with subagent approvals on deny, a track\'s own request is a card titled with `asks`, and a subagent block inside it is denied', async () => {
    const x = setupE([{ tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }, { tool: 'Bash', input: { command: 'pwd' }, approve: true, via: 'native child' }], text: 'REINS: done' }, {}], 1, { subagentApprovals: 'deny' });
    await x.go();
    await until(() => x.open('tool').length > 0);
    expect(x.open('tool')[0]!.title).toBe('Split split-1');
    x.s.answer(x.open('tool')[0]!.id, 'y');
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.t.decisions.map((d) => d.behavior)).toEqual(['allow', 'deny']);
  });
});

describe('fix round 1: what the folder map and shutdown must not remember or assume', () => {
  it('a refused folder question is not remembered: a retried track asks again, and a yes lets it go on and is stored', async () => {
    const x = setupT({}, ask());
    await x.go(split2(A, B));
    x.s.answer((await x.folderQuestion()).id, 'n');
    await until(() => x.open('resume').length === 2);
    expect(x.folderAsks()).toHaveLength(1);
    x.s.answer(x.open('resume')[0]!.id, 'resume');   // the first track tries again, in the same folder, in the same server session
    await until(() => x.folderAsks().length === 2);
    x.s.answer((await x.folderQuestion()).id, 'y');
    await until(() => x.l.sessions.length === 1);   // that track went on
    expect(x.store.isTrusted(x.cwd, FOLDER.key, FOLDER.hash)).toBe(true);
    x.s.answer(x.open('resume')[0]!.id, 'resume');   // the other one: trusted now, so no third question
    expect(await within(x.s.idle(), 3000)).not.toBe('timeout');
    expect(x.folderAsks()).toHaveLength(2);
    expect(x.rows('run_finished')).toHaveLength(1);
  });

  it('a run between two steps (nothing in flight, nothing open) is stopped by shutdown, not detached: it would carry on', async () => {
    const x = setupT();
    const save = x.store.saveSnapshot.bind(x.store);
    let down: Promise<void> | undefined;
    // The first snapshot is the run's own, saved before the driver steps it: no instruction is running and no question is open.
    x.store.saveSnapshot = (...a: Parameters<typeof save>) => { x.store.saveSnapshot = save; save(...a); down = x.s.shutdown(); };
    await x.go('## phase p\n> work-S\n\n## phase q\n> pre-main\n\n## end\n');
    await until(() => down !== undefined);
    expect(await within(down!, 3000)).not.toBe('timeout');
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.rows('run_detached')).toEqual([]);
    expect(x.rows('run_finished')).toEqual([]);
  });
});