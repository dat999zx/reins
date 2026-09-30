// Phase 3b exit checks 1, 3, 5 and 6 over HTTP against the REAL claude (plan 15d line 1621). Costs money:
// only with REINS_E2E=1, run by hand, never in CI. Every assertion is on session_log, not on the model's words.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { claudeEngine, probeClaude } from '../src/claude/engine.js';
import { findClaude } from '../src/claude/find.js';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { until } from './helpers.js';
import { askedQuestion, cleanup, request, rowsOf, tmpDir } from './http-helpers.js';

afterEach(cleanup);

const REPO = process.env.REINS_E2E_REPO ?? 'D:/coding/reins-scratch';
const MODEL = process.env.REINS_E2E_MODEL ?? 'sonnet';
const EFFORT = process.env.REINS_E2E_EFFORT ?? 'medium';

describe.skipIf(process.env.REINS_E2E !== '1')('Phase 3b exit checks 1, 3, 5, 6 on the real claude', () => {
  it('a plain turn, #read-only, #gate and a mid-turn steer card, over HTTP', async () => {
    spawnSync('git', ['checkout', '--', '.'], { cwd: REPO });
    spawnSync('git', ['clean', '-fd'], { cwd: REPO });
    const bin = findClaude(process.env)!.path;
    const store = openStore(':memory:');
    const srv = await startServer({
      store, dir: tmpDir(), probe: () => probeClaude(bin),
      makeEngine: ({ model, effort, onApprove, onLive }) =>
        claudeEngine({ bin, ...(model ? { model } : {}), ...(effort ? { effort } : {}), onApprove, onLive }),
    });
    try {
      const open = async () => (await request(srv, 'POST', '/api/sessions', { body: { cwd: REPO, engine: 'claude', model: MODEL, effort: EFFORT } })).json.id as string;
      const say = (id: string, text: string, tags?: unknown) => request(srv, 'POST', `/api/sessions/${id}/message`, { body: { text, ...(tags ? { tags } : {}) } });
      const engine = (id: string) => rowsOf(store, id, 'engine').map((r) => r.data as { type: string; reason?: string; channel?: string });

      const one = await open();                                                                    // check 1
      expect((await say(one, 'Reply with the single word ok. Do not use any tool.')).status).toBe(200);
      await until(() => rowsOf(store, one, 'turn_ended').length === 1, 300_000);
      expect(rowsOf(store, one, 'run_started')).toEqual([]);

      const three = await open();                                                                  // check 3
      await say(three, 'Use the Edit tool to add the line "// hi" at the top of src/upload.mjs.', [{ tag: 'read-only' }]);
      await until(() => rowsOf(store, three, 'receipt').length === 1, 300_000);
      expect(engine(three).some((e) => e.type === 'refusal')).toBe(true);

      const five = await open();                                                                   // check 5
      await say(five, 'Reply with the single word done. Do not use any tool.', [{ tag: 'gate' }]);
      const q = await askedQuestion(store, five, 'gate', 300_000); // the gate appears only after a real turn
      await request(srv, 'POST', `/api/sessions/${five}/answer`, { body: { questionId: q.id, answer: 'approve' } });
      await until(() => rowsOf(store, five, 'run_finished').length === 1, 300_000);

      const six = await open();                                                                    // check 6
      await say(six, 'Read src/upload.mjs, then migrations/0001.sql, then package.json, one file per step, then say what you found.');
      await until(() => engine(six).some((e) => e.type === 'tool_call'), 300_000);
      await request(srv, 'POST', `/api/sessions/${six}/card`, { body: { text: 'End your answer with PINEAPPLE.', kind: 'steer' } });
      await until(() => rowsOf(store, six, 'turn_ended').length === 1, 300_000);
      expect(engine(six).filter((e) => e.type === 'card_delivered' && e.channel === 'mid-turn')).toHaveLength(1);
    } finally {
      await srv.close();
      spawnSync('git', ['checkout', '--', '.'], { cwd: REPO });
      spawnSync('git', ['clean', '-fd'], { cwd: REPO });
    }
  }, 1_800_000);
});
