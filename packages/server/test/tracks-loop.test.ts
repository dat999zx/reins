// M2 task 10b (P): a branch of a split runs its own session on the API loop engine. A 429 on one branch is retried inside that branch only;
// a Stop with a branch's tool call unanswered leaves its conversation to the loop's pairing, which answers the call with the stub on the next turn.
// Driven as the app drives a run: openSession, a real workflow file, the fake provider, a fake key, temp folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { register, type EngineSession, type OpenOptions } from '@reins/core';
import { loopEngine } from '../src/loop/engine.js';
import { openSession } from '../src/session.js';
import { openStore, type Store } from '../src/store.js';
import { split } from '../../core/test/fixtures/split.js';
import { askedQuestion } from './http-helpers.js';
import { WIRES, rig, toolResults, type Rig, type WireId } from './loop-harness.js';

const INTERRUPTED = 'Interrupted; the tool did not finish.';
const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n';
const AFTER = '## phase after\n> after\n\n## end\n\n';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

let tmp = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-tracks-loop-')));
  fs.mkdirSync(path.join(tmp, 'proj'));
  fs.mkdirSync(path.join(tmp, 'outside'));
});
const rigs: Rig[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const s of stores.splice(0)) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });

async function boot(wire: WireId) {
  const r = await rig(wire, { strictPairs: true });
  rigs.push(r);
  const store = openStore(':memory:');
  stores.push(store);
  const cwd = path.join(tmp, 'proj');
  const row = store.createSession({ id: 's1', cwd, engine: 'p' });
  const opens: Array<{ o: OpenOptions; session?: EngineSession }> = [];
  const slept: number[] = [];
  const s = openSession({
    store, dir: r.host.home,
    makeEngine: ({ onApprove, onLive, settings }) => {
      const e = loopEngine(r.p, r.wire, { ...r.host, onApprove, onLive, ...(settings ? { settings } : {}) }, { sleep: async (ms) => void slept.push(ms), random: () => 0 });
      return { ...e, open: async (x) => { const rec: (typeof opens)[number] = { o: x }; opens.push(rec); return (rec.session = await e.open(x)); } };
    },
  }, row, true);
  const x = {
    r, store, s, cwd, opens, slept,
    /** The sessions of the branches: only the main line's has a USD room. */
    branches: () => opens.filter((p) => !p.o.usdRoom),
    async go(body: string) {
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, FRONT + body);
      expect(s.runFile(file)).toEqual({ ok: true });
      s.answer((await askedQuestion(store, 's1', 'trust')).id, 'y');
    },
    rows: (type: string) => store.readLog('s1').filter((q) => q.type === type),
    sent: () => r.fake.requests.length,
  };
  return x;
}

describe.each(WIRES)('a split of loop-engine branches (%s)', (wire) => {
  it('a 429 on one branch is retried inside that branch: both finish, nothing pauses, the other branch is not slowed', async () => {
    const x = await boot(wire);
    x.r.push({ status: 429, body: 'slow down', headers: { 'retry-after': '1' } }, { text: 'A-WORDS\nREINS: done' }, { text: 'B-WORDS\nREINS: done' }, { text: 'REINS: done' });
    await x.go('## split\nnext: a\nnext: b\n\n' + AFTER + '## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n');
    await x.s.idle();
    expect(x.rows('run_finished')).toHaveLength(1);
    expect(x.rows('run_paused')).toEqual([]);
    expect(x.sent()).toBe(4);   // the 429, one try again, the other branch, the main line
    expect(x.slept).toEqual([1000]);   // one wait, the server's Retry-After, and only one branch waited
    expect(x.branches()).toHaveLength(2);
    const ended = x.rows('track_ended').map((q) => (q.data as { track: string; text: string }));
    expect(ended.map((e) => e.track).sort()).toEqual(['a', 'b']);
    expect(ended.map((e) => e.text).sort()).toEqual(['A-WORDS', 'B-WORDS']);
    // the main line's request carries both results, once each
    const last = JSON.stringify(x.r.fake.requests[3]!.body);
    expect(last).toContain('A-WORDS');
    expect(last).toContain('B-WORDS');
  }, 60_000);

  it('Stop with a branch\'s tool call unanswered: its conversation is answered with the stub on the next turn, paired, and the other lines are not touched', async () => {
    const x = await boot(wire);
    const far = path.join(tmp, 'outside', 'far.txt');
    fs.writeFileSync(far, 'FAR-BODY');
    x.r.push({ toolCalls: [call('a', 'Read', { file_path: far })] });
    await x.go('## split\nnext: a\n\n' + AFTER + '## phase a\n> a\n\n## end\n');
    const q = await askedQuestion(x.store, 's1', 'tool');
    expect(q.title).toBe('Split split-1');   // the branch's own question, still open
    expect(x.sent()).toBe(1);
    const [branch] = x.branches();
    await x.s.close();
    expect(x.rows('run_stopped')).toHaveLength(1);
    expect(x.sent()).toBe(1);   // nothing else went to the provider
    // the branch's conversation, opened again: the call has no result in the file, and the loop answers it with the stub
    x.r.push({ text: 'again ok' });
    const res = await (await x.r.open({ cwd: x.cwd, sessionId: branch!.session!.sessionId })).turn('go on');
    expect(res.text).toBe('again ok');
    expect(toolResults(x.r.fake.requests[1]!.body)).toEqual([{ id: 'a', content: INTERRUPTED }]);
  }, 60_000);
});
