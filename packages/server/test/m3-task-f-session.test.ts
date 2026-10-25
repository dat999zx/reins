// M3 Task 9 (group F): a fork run through the server's session (the app and `reins serve` path). The branches are tracks with sessions of their own: a tool
// approval asked by one is a card titled with the branch, the answers go to the branch that asked, and Stop closes every branch's session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack();

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-f-ses-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

const WORKFLOW = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: 5 }\nalways: []\n---\n\n## phase plan\n> plan\n\n## fork\nnext: a\nnext: b\n\n## phase after\n> after\n\n## end\n\n## phase API research\nid: a\n> a\n\n## end\n\n## phase DB research\nid: b\n> b\n\n## end\n';
const ASK: TestTurn = { tools: [{ tool: 'Bash', input: { command: 'ls' }, approve: true }], text: 'REINS: done' };

function setup(script: TestTurn[], text = WORKFLOW) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp() }, row, true);
  const asked = (kind: string) => {
    const l = store.readLog('s1');
    return l.filter((r) => r.type === 'question').map((r) => r.data as { id: string; kind: string; title?: string })
      .filter((q) => q.kind === kind && !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
  };
  const question = async (kind: string) => { await until(() => asked(kind).length > 0); return asked(kind)[0]!; };
  const go = async () => {
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, text);
    expect(s.runFile(file)).toEqual({ ok: true });
    s.answer((await question('trust')).id, 'y');
  };
  return { store, t, s, asked, question, go };
}

describe('a fork through the session', () => {
  it('a branch\'s tool approval is a card titled with the branch; the answer lets that branch go on; the run finishes with the fork done once', async () => {
    const x = setup([{}, ASK, {}, {}, {}]);   // the plan turn, the first branch asks, the second branch, the build turn
    await x.go();
    const q = await x.question('tool');
    expect(q.title).toMatch(/^Branch (API|DB) research$/);
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }]);
    const rows = x.store.readLog('s1');
    expect(rows.filter((r) => r.type === 'fork_started')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'fork_done')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'track_ended')).toHaveLength(2);
    expect(rows.some((r) => r.type === 'run_finished')).toBe(true);
    // the plan turn and the build turn ran on the main session; each branch had its own
    const sessions = new Set(x.t.turnsBy.map((b) => b.session));
    expect(sessions.size).toBe(3);
    await x.s.shutdown();
  });

  it('a fork asks even when the subagent approvals setting says deny (a branch is not a subagent)', async () => {
    const x = setup([{}, ASK, {}, {}, {}]);
    x.store.putSetting('subagentApprovals', 'deny');
    await x.go();
    const q = await x.question('tool');
    expect(q.title).toMatch(/^Branch /);
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }]);
    await x.s.shutdown();
  });

  it('Stop on a branch\'s card closes every open card and the sessions, and the fork never finishes', async () => {
    const gates = WORKFLOW.replace('## phase API research\nid: a\n> a\n', '## phase API research\nid: a\n> a\n\n## gate\nid: ga\nuntil: you approve\n').replace('## phase DB research\nid: b\n> b\n', '## phase DB research\nid: b\n> b\n\n## gate\nid: gb\nuntil: you approve\n');
    const x = setup([], gates);
    await x.go();
    await until(() => x.asked('gate').length === 2);
    expect(x.asked('gate').map((q) => q.title).sort()).toEqual(['Branch API research', 'Branch DB research']);
    x.s.answer(x.asked('gate')[0]!.id, 'stop');
    await x.s.idle();
    const rows = x.store.readLog('s1');
    expect(rows.filter((r) => r.type === 'run_stopped')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'fork_done')).toHaveLength(0);
    expect(rows.some((r) => r.type === 'run_finished')).toBe(false);
    expect(x.asked('gate')).toEqual([]);   // the other card was closed with the run
    await x.s.shutdown();
  });
});