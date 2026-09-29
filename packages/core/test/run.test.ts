import { describe, it, expect } from 'vitest';
import { Run } from '../src/run.js';
import { FakeEngine } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';

describe('Task 1.7: The Run Engine against FakeEngine', () => {
  it('Read-only step: a scripted write gets denied, and a refusal is logged', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'readonly-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'plan',
          kind: 'phase',
          title: 'plan',
          attrs: { mode: 'read-only' },
          cards: [],
          links: [],
          prompt: 'Write plan',
        },
      ],
      autos: [],
    };

    const engine = new FakeEngine([
      {
        events: [
          { type: 'tool_call', tool: 'Edit', input: { file_path: 'src/app.ts' } },
        ],
        text: 'REINS: done',
      },
    ]);

    const run = new Run({ workflow: wf, engine });
    await run.step();

    const refusals = run.getEvents().filter((e) => e.type === 'refusal');
    expect(refusals.length).toBe(1);
    expect(refusals[0]!.data.reason).toContain('read-only');
  });

  it('Gate: the run pauses, approve() resumes it, and the next turn gets the implement text', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'gate-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'plan',
          kind: 'phase',
          title: 'plan',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Plan prompt',
        },
        {
          id: 'gate-1',
          kind: 'gate',
          cond: { t: 'approve' },
          attrs: {},
          cards: [],
          links: [],
        },
        {
          id: 'implement',
          kind: 'phase',
          title: 'implement',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Implement prompt',
        },
      ],
      autos: [],
    };

    const engine = new FakeEngine([
      { text: 'Plan finished\nREINS: done' },
      { text: 'Implemented\nREINS: done' },
    ]);

    const run = new Run({ workflow: wf, engine });

    // Step 1: plan
    await run.step();
    expect(run.status).toBe('running');

    // Step 2: gate
    await run.step();
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('gate');

    // Approve
    run.approve();
    expect(run.status).toBe('running');

    // Step 3: implement
    await run.step();
    expect(engine.receivedTexts.length).toBe(2);
    expect(engine.receivedTexts[1]).toContain('Implement prompt');
  });

  it('Loop: fails 5 times, pauses with budget-used, allowMore(2) goes on, passes on attempt 6', async () => {
    let testAttempts = 0;
    const wf: Workflow = {
      version: 1,
      name: 'loop-test',
      budget: { turns: 20, minutes: 20 },
      always: [],
      steps: [
        {
          id: 'repeat-1',
          kind: 'repeat',
          cond: { t: 'cmd', cmd: 'npm test' },
          attrs: { max: '5' },
          cards: [],
          links: [],
          kids: [
            {
              id: 'test',
              kind: 'run',
              attrs: { cmd: 'npm test' },
              cards: [],
              links: [],
            },
            {
              id: 'fix',
              kind: 'phase',
              title: 'fix',
              attrs: {},
              cards: [],
              links: [],
              prompt: 'Fix it',
            },
          ],
        },
      ],
      autos: [],
    };

    const engine = new FakeEngine(
      Array(10).fill({ text: 'Tried to fix\nREINS: done' })
    );

    const commandRunner = async (_cmd: string) => {
      testAttempts++;
      return {
        exitCode: testAttempts >= 6 ? 0 : 1,
        stdout: '',
        stderr: testAttempts >= 6 ? '' : 'test failed',
      };
    };

    const run = new Run({ workflow: wf, engine, commandRunner });

    // Run until paused
    while (run.status === 'running') {
      await run.step();
    }

    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('budget-used');
    expect(testAttempts).toBe(5);

    // Allow 2 more
    run.allowMore(2);
    expect(run.status).toBe('running');

    while ((run.status as string) === 'running') {
      await run.step();
    }

    expect(testAttempts).toBe(6);
    expect(run.status).toBe('done');
  });

  it('on-fail link jumps back and counts towards its link budget. Once the budget is used up it pauses', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'on-fail-test',
      budget: { turns: 20, minutes: 20 },
      always: [],
      steps: [
        {
          id: 'implement',
          kind: 'phase',
          title: 'implement',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Implement',
        },
        {
          id: 'verify-1',
          kind: 'verify',
          attrs: { against: 'implement' },
          cards: [],
          links: [{ kind: 'on-fail', to: 'implement', max: 2 }],
        },
      ],
      autos: [],
    };

    const engine = new FakeEngine([
      { text: 'Done 1\nREINS: done' },
      { text: 'REINS: fail: missing retry' },
      { text: 'Done 2\nREINS: done' },
      { text: 'REINS: fail: still missing' },
      { text: 'Done 3\nREINS: done' },
      { text: 'REINS: fail: still missing again' },
    ]);

    const run = new Run({ workflow: wf, engine });

    while (run.status === 'running') {
      await run.step();
    }

    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('link-budget-used');
  });

  it("Verify quotes the plan step's final output, not its prompt", async () => {
    const wf: Workflow = {
      version: 1,
      name: 'verify-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'plan',
          kind: 'phase',
          title: 'plan',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Write plan for retry',
        },
        {
          id: 'verify-1',
          kind: 'verify',
          attrs: { against: 'plan' },
          cards: [],
          links: [],
        },
      ],
      autos: [],
    };

    const planOutput = '1. First add backoff\n2. Add retry loop\nREINS: done';
    const engine = new FakeEngine([
      { text: planOutput },
      { text: 'REINS: pass' },
    ]);

    const run = new Run({ workflow: wf, engine });
    await run.step(); // plan
    await run.step(); // verify

    expect(engine.receivedTexts.length).toBe(2);
    expect(engine.receivedTexts[1]).toContain(planOutput);
    expect(engine.receivedTexts[1]).not.toContain('Write plan for retry');
  });

  it('A card queued mid-turn gets delivered at the next tool event. One queued after the last tool event gets delivered in the next turn text', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'card-delivery-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'step1',
          kind: 'phase',
          title: 'step1',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Step 1 prompt',
        },
        {
          id: 'step2',
          kind: 'phase',
          title: 'step2',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Step 2 prompt',
        },
      ],
      autos: [],
    };

    const engine = new FakeEngine([
      {
        events: [
          { type: 'tool_call', tool: 'Read', input: { path: 'a.txt' } },
        ],
        text: 'Step 1 done\nREINS: done',
      },
      {
        text: 'Step 2 done\nREINS: done',
      },
    ]);

    const run = new Run({ workflow: wf, engine });

    // Queue a card while turn 1 is in flight (at its first tool call): the engine must deliver
    // it mid-turn, and it must NOT also appear in turn 1's text (that text was already sent).
    engine.onToolCall = () => {
      if (!engine.receivedTexts.some((t) => t.includes('Mid-turn card'))) run.queueCard('Mid-turn card');
      engine.onToolCall = undefined;
    };
    await run.step();

    const deliveredMid = run
      .getEvents()
      .filter((e) => e.type === 'card_delivered' && e.data.channel === 'mid-turn');
    expect(deliveredMid.length).toBe(1);
    expect(deliveredMid[0]!.data.card).toBe('Mid-turn card');
    expect(engine.receivedTexts[0]).not.toContain('Mid-turn card');

    // Queue card after step 1 finished (no tool call): delivered in next turn's text
    run.queueCard('Next-turn card');
    await run.step();

    expect(engine.receivedTexts[1]).toContain('Next-turn card');
  });

  it('An auto card same error twice fires once, re-arms after a pass, and fires again', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'auto-card-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'step1',
          kind: 'phase',
          title: 'step1',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Do step',
        },
      ],
      autos: [
        {
          id: 'auto-1',
          cond: { t: 'same' },
          card: { kind: 'nudge', text: 'same error twice nudge' },
        },
      ],
    };

    const engine = new FakeEngine(
      Array(6).fill({ text: 'Doing work\nREINS: done' })
    );

    const run = new Run({ workflow: wf, engine });

    // Trigger same error twice
    run.recordCommandResult('cmd', 1, 'Error: timeout');
    run.recordCommandResult('cmd', 1, 'Error: timeout');
    run.checkAutoCards();

    let autoFired = run.getEvents().filter((e) => e.type === 'card_queued');
    expect(autoFired.length).toBe(1);

    // Call checkAutoCards again: condition is still true, but card is sleeping (fires once)
    run.checkAutoCards();
    autoFired = run.getEvents().filter((e) => e.type === 'card_queued');
    expect(autoFired.length).toBe(1);

    // Now condition turns false (pass)
    run.recordCommandResult('cmd', 0, 'Success');
    run.checkAutoCards();

    // Now same error happens twice again
    run.recordCommandResult('cmd', 1, 'Error: null pointer');
    run.recordCommandResult('cmd', 1, 'Error: null pointer');
    run.checkAutoCards();

    autoFired = run.getEvents().filter((e) => e.type === 'card_queued');
    expect(autoFired.length).toBe(2);
  });

  it('Live edit: a step added after the current one runs; deleting the current step pauses the run', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'live-edit-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'step1',
          kind: 'phase',
          title: 'step1',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Step 1',
        },
      ],
      autos: [],
    };

    const engine = new FakeEngine([
      { text: 'Step 1 done\nREINS: done' },
      { text: 'Step 2 done\nREINS: done' },
    ]);

    const run = new Run({ workflow: wf, engine });
    await run.step();

    // Add step 2
    const wf2: Workflow = {
      ...wf,
      steps: [
        ...wf.steps,
        {
          id: 'step2',
          kind: 'phase',
          title: 'step2',
          attrs: {},
          cards: [],
          links: [],
          prompt: 'Step 2',
        },
      ],
    };
    run.edit(wf2);
    await run.step();
    expect(engine.receivedTexts.length).toBe(2);
    expect(engine.receivedTexts[1]).toContain('Step 2');

    // Deleting current step pauses run
    const wf3: Workflow = {
      ...wf,
      steps: [],
    };
    run.edit(wf3);
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('step-deleted');
  });

  it('snapshot then restore in the middle of a loop continues with the same counters', async () => {
    let attempts = 0;
    const wf: Workflow = {
      version: 1,
      name: 'snapshot-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        {
          id: 'repeat-1',
          kind: 'repeat',
          cond: { t: 'tests' },
          attrs: { max: '5' },
          cards: [],
          links: [],
          kids: [
            {
              id: 'test',
              kind: 'run',
              attrs: { cmd: 'npm test' },
              cards: [],
              links: [],
            },
          ],
        },
      ],
      autos: [],
    };

    const commandRunner = async () => {
      attempts++;
      return { exitCode: attempts >= 4 ? 0 : 1, stdout: '', stderr: '' };
    };

    const engine = new FakeEngine([]);
    const run = new Run({ workflow: wf, engine, commandRunner });

    // Step 2 iterations
    await run.step();
    await run.step();

    // Snapshot
    const snap = run.snapshot();

    // Restore into a fresh Run
    const restoredRun = Run.restore(snap, { engine, commandRunner });

    while (restoredRun.status === 'running') {
      await restoredRun.step();
    }

    expect(attempts).toBe(4);
    expect(restoredRun.status).toBe('done');
  });

  it('Run budget: the turn limit pauses the run', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'turn-limit-test',
      budget: { turns: 2, minutes: 10 },
      always: [],
      steps: [
        { id: 's1', kind: 'phase', title: 's1', attrs: {}, cards: [], links: [], prompt: '1' },
        { id: 's2', kind: 'phase', title: 's2', attrs: {}, cards: [], links: [], prompt: '2' },
        { id: 's3', kind: 'phase', title: 's3', attrs: {}, cards: [], links: [], prompt: '3' },
      ],
      autos: [],
    };

    const engine = new FakeEngine([
      { text: 'Done 1\nREINS: done' },
      { text: 'Done 2\nREINS: done' },
      { text: 'Done 3\nREINS: done' },
    ]);

    const run = new Run({ workflow: wf, engine });
    await run.step(); // turn 1
    await run.step(); // turn 2 -> budget reached

    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('run-turn-budget-used');
  });

  it('Stop: interrupts the engine, and the receipt is written', async () => {
    const wf: Workflow = {
      version: 1,
      name: 'stop-test',
      budget: { turns: 10, minutes: 10 },
      always: [],
      steps: [
        { id: 's1', kind: 'phase', title: 's1', attrs: {}, cards: [], links: [], prompt: '1' },
      ],
      autos: [],
    };

    const engine = new FakeEngine([]);
    const run = new Run({ workflow: wf, engine });

    await run.step();
    await run.stop();
    expect(run.status).toBe('stopped');
    expect(engine.interrupted).toBe(true);

    const stoppedEvent = run.getEvents().find((e) => e.type === 'run_stopped');
    expect(stoppedEvent).toBeDefined();
  });
});
