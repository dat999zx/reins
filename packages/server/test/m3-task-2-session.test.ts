// M3 Task 2: a resumed run says when the session moved off the model its model block chose, from the HOST's own record (saved beside the run), not from the
// run's model event. The same words as before for a run saved by this build; a damaged record reads as none; the run's events alone say nothing.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Question } from '../src/drive.js';
import { openSession, type MakeEngine } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine } from './test-engine.js';

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m3t2-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const WF_GATE = `${FRONT}## model model-b\n\n## gate\nuntil: you approve\n\n## phase one\n> Go.\n`;
const describeB = (_e: string, m: string) => ({ listed: m !== 'nope', label: m === 'model-b' ? 'B' : m, estimate: 0.01 });

/** `first`: another workflow the session runs to its end before the one that detaches. */
async function detachedAtGate(o: { model?: string; text?: string; first?: string } = {}) {
  const store = openStore(':memory:');
  const t = testEngine([{ usage: 1000 }, {}]);
  const makeEngine: MakeEngine = (e) => t.makeEngine(e);
  const dir = tmp();
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code', ...(o.model ? { model: o.model } : {}) });
  const open = (r = row) => openSession({ store, makeEngine, folderTrust: t.folderTrust, dir, describeModel: describeB }, r, true);
  const s = open();
  s.message('first');
  await s.idle();
  const waiting = () => store.readLog('s1').filter((r) => r.type === 'question').map((r) => r.data as Question).filter((q) => !store.readLog('s1').some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
  const start = async (name: string, text: string) => {
    const f = path.join(cwd, name);
    fs.writeFileSync(f, text);
    expect(s.runFile(f)).toEqual({ ok: true });
    await until(() => waiting().some((q) => q.kind === 'trust'));
    s.answer(waiting().find((q) => q.kind === 'trust')!.id, 'y');
    await until(() => waiting().some((q) => q.kind === 'gate'));
  };
  if (o.first) {
    await start('a.reins.md', o.first);
    s.answer(waiting().find((q) => q.kind === 'gate')!.id, 'approve');
    await s.idle();
  }
  await start('w.reins.md', o.text ?? WF_GATE);
  await s.shutdown();
  const rid = store.readLog('s1').filter((r) => r.type === 'run_started').at(-1)!.runId!;
  return { store, rid, reopen: () => open(store.getSession('s1')!), notes: () => store.readLog('s1').filter((r) => r.type === 'note').map((r) => (r.data as { text: string }).text) };
}

const NOTE = "This run's model block chose B; the session is on the default model, so the next steps run on it.";

describe('M3 Task 2: the resume note comes from the host\'s own switch record', () => {
  it('the saved run carries what the model step chose, and the resume says so when the session has moved', async () => {
    const x = await detachedAtGate();
    const snap = x.store.loadRun(x.rid)!.snapshot as unknown as { hostChose?: unknown };
    expect(snap.hostChose).toEqual({ model: 'model-b', label: 'B' });
    x.store.updateSession('s1', { model: null });
    expect(x.reopen().resume(x.rid)).toEqual({ ok: true });
    await until(() => x.notes().includes(NOTE));
  });

  it('no note when the session is still on the model the step chose', async () => {
    const x = await detachedAtGate();
    expect(x.reopen().resume(x.rid)).toEqual({ ok: true });
    await until(() => x.notes().some((n) => n.startsWith('Resumed run')));
    expect(x.notes().filter((n) => n.startsWith("This run's model block"))).toEqual([]);
  });

  it.each([
    ['no record at all (a run saved before this build)', undefined],
    ['a record that is a string', 'model-b'],
    ['a record with a model that is not text', { model: 7, label: 'B' }],
    ['a record with a label that is not text', { model: 'model-b', label: { x: 1 } }],
    ['a record that is null', null],
    ['a record that is a list', ['model-b']],
  ])('%s reads as none: no note, even though the run\'s own events say the model block ran', async (_n, record) => {
    const x = await detachedAtGate();
    const saved = x.store.loadRun(x.rid)!;
    expect(saved.snapshot.events.some((e) => e.type === 'model_switched')).toBe(true);
    const bad = { ...saved.snapshot, events: [] } as Record<string, unknown>;
    if (record === undefined) delete bad.hostChose; else bad.hostChose = record;
    x.store.saveSnapshot(x.rid, bad as never);
    x.store.updateSession('s1', { model: null });
    expect(x.reopen().resume(x.rid)).toEqual({ ok: true });
    await until(() => x.notes().some((n) => n.startsWith('Resumed run')));
    expect(x.notes().filter((n) => n.startsWith("This run's model block"))).toEqual([]);
  });

  it('a step that finds the session already on its model ("same") is recorded too', async () => {
    const x = await detachedAtGate({ model: 'model-b' });
    expect((x.store.loadRun(x.rid)!.snapshot as unknown as { hostChose?: unknown }).hostChose).toEqual({ model: 'model-b', label: 'B' });
    x.store.updateSession('s1', { model: null });
    expect(x.reopen().resume(x.rid)).toEqual({ ok: true });
    await until(() => x.notes().includes(NOTE));
  });

  it('a run with no model step saves no record, and the record of the run before it does not leak into it', async () => {
    const x = await detachedAtGate({ first: WF_GATE, text: `${FRONT}## gate\nuntil: you approve\n\n## phase one\n> Go.\n` });
    expect(x.store.loadRun(x.rid)!.snapshot).not.toHaveProperty('hostChose');
    x.store.updateSession('s1', { model: null });
    expect(x.reopen().resume(x.rid)).toEqual({ ok: true });
    await until(() => x.notes().some((n) => n.startsWith('Resumed run')));
    expect(x.notes().filter((n) => n.startsWith("This run's model block"))).toEqual([]);
  });

  it('a record with a model but no label says the model name', async () => {
    const x = await detachedAtGate();
    const saved = x.store.loadRun(x.rid)!;
    x.store.saveSnapshot(x.rid, { ...saved.snapshot, events: [], hostChose: { model: 'model-b' } } as never);
    x.store.updateSession('s1', { model: null });
    expect(x.reopen().resume(x.rid)).toEqual({ ok: true });
    await until(() => x.notes().some((n) => n.startsWith("This run's model block")));
    expect(x.notes().find((n) => n.startsWith("This run's model block"))).toBe("This run's model block chose model-b; the session is on the default model, so the next steps run on it.");
  });
});
