// M2 task 13: a session that runs a split asks every branch's questions at once, keeps each branch's tool cards apart (a card belongs to its owner and
// closes when THAT owner's turn ends), and a Stop settles every question of the run. Driven as the app drives a run: openSession, a real workflow
// file, the toy `split`, and an engine whose sessions are independent (their own plan and their own hold), because the shared script of test-engine.ts
// cannot order two sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { register, type Decision, type EngineSession } from '@reins/core';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { split } from '../../core/test/fixtures/split.js';
import { openQuestions } from './http-helpers.js';

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
