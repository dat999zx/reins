// M2 task 10a, fix round: a track's OWN approvals are asked like the main run, but a native child task inside a track (`via`) keeps the
// exception the main run has: under subagentApprovals 'deny' it is denied, even with auto approve on.
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m2tsf-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

async function until(f: () => boolean) {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

const WORKFLOW = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10, usd: 5 }\nalways: []\n---\n\n## split\nnext: a\n\n## phase after\n> after\n\n## end\n\n## phase a\n> a\n\n## end\n';
const OWN = { tool: 'Bash', input: { command: 'ls' }, approve: true };
const CHILD = { tool: 'Bash', input: { command: 'pwd' }, approve: true, via: 'native child' };

describe('a native child task inside a track', () => {
  it('is denied under subagentApprovals deny with auto approve on, as on the main session; the track\'s own request is allowed', async () => {
    const script: TestTurn[] = [{ tools: [OWN, CHILD], text: 'REINS: done' }, { tools: [CHILD], text: 'REINS: done' }];   // the track's turn, then the main line's
    const store = openStore(':memory:');
    const t = testEngine(script);
    const cwd = tmp();
    const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
    store.updateSession('s1', { autoApprove: true });
    store.putSetting('subagentApprovals', 'deny');
    const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp() }, store.getSession('s1') ?? row, true);
    const file = path.join(cwd, 'w.reins.md');
    fs.writeFileSync(file, WORKFLOW);
    expect(s.runFile(file)).toEqual({ ok: true });
    const trust = () => {
      const l = store.readLog('s1');
      return l.filter((r) => r.type === 'question').map((r) => r.data as { id: string; kind: string })
        .find((q) => q.kind === 'trust' && !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId: string }).questionId === q.id));
    };
    await until(() => trust() !== undefined);
    s.answer(trust()!.id, 'y');
    await s.idle();
    expect(t.decisions.map((d) => d.behavior)).toEqual(['allow', 'deny', 'deny']);
    expect(t.decisions[1]).toEqual(t.decisions[2]);   // the track's child gets the main session's answer
    await s.shutdown();
  });
});
