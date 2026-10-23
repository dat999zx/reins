// M2 Task 25b (found by the live checks): a block MOD whose op starts tracks parks its own track on the op until they end. The check "the op did not
// move on" (Task 25a) must not take that parking for an op that forgot `vm.next()`: it paused the run at once with "The block ... did not move on".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { register } from '../src/nodes/index.js';
import { Run } from '../src/run.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
// The toy split, as a mod's node (the loader's mark): its op goes through the mod path of the run.
beforeAll(() => { disposers.push(register({ ...split, mod: { id: 'splitmod', events: ['split_started', 'split_done'] } })); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const body = '---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n## split\nnext: a\n\n## end\n\n## phase a\n> a\n\n## end\n';

describe('a mod op that starts tracks and parks', () => {
  it('is not paused for "did not move on"; the track runs, the op runs again, moves on, and the run is done', async () => {
    const h = m2harness('P1');
    h.script('P1-sub-a', { text: 'alpha\nREINS: done' });
    const run = new Run({ workflow: parseWorkflow(body).workflow!, engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step();
    const types = run.getEvents().map((e) => e.type);
    expect(types).not.toContain('run_paused');
    expect(run.status).toBe('done');
    expect(types.filter((t) => t === 'track_started')).toHaveLength(1);
    expect(types.filter((t) => t === 'track_ended')).toHaveLength(1);
    expect(types).toContain('split_done');
    await run.close();
  });
});
