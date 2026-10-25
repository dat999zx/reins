// M2 task 10a (S15): a track's session is opened through `openSubagent` as a raw turn. It asks like the main run (a card titled with `asks`, whatever
// the subagent approvals setting says), has no auto-compress and no room debit, and `asks` never reaches `engine.open`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { register } from '@reins/core';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { split } from '../../core/test/fixtures/split.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m2ts-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

async function until(f: () => boolean) {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

// The main line's turn after the split follows the track's; the track asks about one tool.
const WORKFLOW = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: 5 }\nalways: []\n---\n\n## split\nnext: a\n\n## phase after\n> after\n\n## end\n\n## phase a\n> a\n\n## end\n';
const ASK: TestTurn = { tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }], text: 'REINS: done' };

function setup(script: TestTurn[], settings: Record<string, unknown> = {}) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  store.putSetting('autoCompressAt', 0.5);
  for (const [k, v] of Object.entries(settings)) store.putSetting(k, v);
  const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp() }, row, true);
  const asked = (kind: string) => {
    const l = store.readLog('s1');
    return l.filter((r) => r.type === 'question').map((r) => r.data as { id: string; kind: string; title?: string })
      .filter((q) => q.kind === kind && !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
  };
  const question = async (kind: string) => { await until(() => asked(kind).length > 0); return asked(kind)[0]!; };
  const go = async () => {
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, WORKFLOW);
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await question('trust')).id, 'y');
  };
  return { store, t, s, asked, question, go };
}

describe('a track session opened through the host', () => {
  it('asks on a card titled with `asks`; asks, step and title never reach engine.open; no compaction, no room', async () => {
    const x = setup([{ usage: 600_000 }, ASK, {}, {}]);   // plain chat (the context is over half the window), the track's turn, the compaction, the main reply
    x.s.message('one');
    await x.s.idle();
    await x.go();
    const q = await x.question('tool');
    expect(q.title).toBe('Split split-1');
    expect(x.t.compacts).toBe(0);   // the track's turn was sent with the context over the threshold: a raw turn
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.compacts).toBe(1);   // the main line's next turn did compress
    expect(x.t.opens).toHaveLength(2);
    const [main, track] = x.t.opens as unknown as [Record<string, unknown>, Record<string, unknown>];
    for (const o of [main, track]) for (const k of ['asks', 'step', 'title']) expect(k in o).toBe(false);
    expect(typeof main.usdRoom).toBe('function');
    expect(typeof track.usdRoom).toBe('function');   // the workflow has usd 5, so a track with no share holds the live room too (m3 fix A item 2); the turn above is still raw
    expect(typeof track.policy).toBe('function');
    expect(x.t.turnsBy.map((b) => b.session === (x.t.turnsBy[0]!.session) ? 'main' : 'track')).toEqual(['main', 'track', 'main']);
    await x.s.shutdown();
  });

  it('a track asks even when the subagent approvals setting says deny', async () => {
    const x = setup([ASK, {}], { subagentApprovals: 'deny' });
    await x.go();
    const q = await x.question('tool');
    expect(q.title).toBe('Split split-1');
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }]);
    await x.s.shutdown();
  });
});
