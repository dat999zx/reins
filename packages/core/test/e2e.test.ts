import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Run } from '../src/run.js';
import { FakeEngine } from '../src/fake-engine.js';
import { parseWorkflow } from '../src/format/parse.js';
import { receipt } from '../src/receipt.js';
import type { Workflow } from '../src/model.js';

describe('Task 1.9: End-to-End Workflow Runs against FakeEngine', () => {
  const examplesDir = path.resolve(__dirname, '../../../examples');

  const loadWorkflow = (relPath: string): Workflow => {
    const content = fs.readFileSync(path.join(examplesDir, relPath), 'utf8');
    const { workflow, diagnostics } = parseWorkflow(content);
    if (!workflow || diagnostics.length > 0) {
      throw new Error(`Failed to load ${relPath}: ${JSON.stringify(diagnostics)}`);
    }
    return workflow;
  };

  const reviewPass = loadWorkflow('blocks/review-pass.reins.md');
  const resolveBlock = (name: string) => {
    if (name === 'review-pass') return reviewPass;
    return undefined;
  };

  it('runs upload-retry end to end and produces expected receipt', async () => {
    const wf = loadWorkflow('upload-retry.reins.md');

    let testRunCount = 0;
    const commandRunner = async (cmd: string) => {
      if (cmd === 'npm test') {
        testRunCount++;
        // Attempt 1 fails, attempt 2 passes
        return {
          exitCode: testRunCount >= 2 ? 0 : 1,
          stdout: testRunCount >= 2 ? 'All tests pass' : '',
          stderr: testRunCount >= 2 ? '' : '1 failure in retry test',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const script = [
      // 1. plan
      {
        events: [{ type: 'tool_call' as const, tool: 'Read', input: { path: 'src/upload.ts' } }],
        text: 'Plan:\n1. Add backoff\n2. Add retry loop\nREINS: done',
      },
      // 2. implement (tries writing migrations/ -> blocked by guard)
      {
        events: [
          { type: 'tool_call' as const, tool: 'Write', input: { file_path: 'migrations/001.sql' } },
          { type: 'tool_call' as const, tool: 'Write', input: { file_path: 'src/upload.ts' } },
        ],
        text: 'Implemented\nREINS: done',
      },
      // 3. fix (after npm test failure 1)
      {
        text: 'Fixed test failure\nREINS: done',
      },
      // 4. verify
      {
        text: 'Checked all steps against plan\nREINS: pass',
      },
      // Inlined review-pass:
      // 5. review
      {
        text: 'Review done. No issues.\nREINS: done',
      },
      // 6. fix
      {
        text: 'Cleaned up formatting\nREINS: done',
      },
      // 7. store
      {
        text: 'Decided: max 3 retries with backoff\nREINS: done',
      },
      // 8. handoff
      {
        text: 'Handoff: upload retry implemented and tested\nREINS: done',
      },
    ];

    const engine = new FakeEngine(script);
    const run = new Run({
      workflow: wf,
      engine,
      resolveBlock,
      commandRunner,
    });

    // Run until completion or gate pause
    while (run.status !== 'done') {
      if (run.status === 'paused') {
        if (run.pauseReason?.type === 'gate') {
          run.approve();
        } else {
          break;
        }
      }
      await run.step();
    }

    expect(run.status).toBe('done');

    const r = receipt(run.getEvents());
    expect(r.workflow).toBe('upload-retry');
    expect(r.status).toBe('done');
    expect(r.gatesHeld).toBe(2); // main gate until: you approve + review-pass gate until: llm says "no blocking issues left"
    expect(r.guardRefusals).toBe(1);
    expect(r.knowlRecalls).toBe(1);
    expect(r.knowlStores).toBe(1);
    expect(r.verifyResults.passed).toBe(1);
    expect(r.verifyResults.failed).toBe(0);
    // Turn 1: plan (mode: read-only)
    // Turn 2: implement
    // Turn 3: fix (repeat loop after first npm test failure)
    // Turn 4: verify (against plan)
    // Turn 5: review (inlined review-pass)
    // Turn 6: fix (inlined review-pass)
    // Turn 7: store (defect 6: decision summary turn)
    // Turn 8: handoff (defect 8: handoff summary turn)
    expect(r.totalTurns).toBe(8);
  });

  it('runs bug-fix end to end and produces expected receipt', async () => {
    const wf = loadWorkflow('bug-fix.reins.md');

    const commandRunner = async (_cmd: string) => {
      return { exitCode: 0, stdout: 'tests passed', stderr: '' };
    };

    const script = [
      // reproduce
      { text: 'Reproduced bug\nREINS: done' },
      // fix
      { text: 'Fixed bug\nREINS: done' },
      // say (else branch)
      { text: 'Root cause was buffer overflow\nREINS: done' },
    ];

    const engine = new FakeEngine(script);
    const run = new Run({ workflow: wf, engine, commandRunner });

    while (run.status !== 'done') {
      if (run.status === 'paused') {
        if (run.pauseReason?.type === 'gate') {
          run.approve();
        } else {
          break;
        }
      }
      await run.step();
    }

    expect(run.status).toBe('done');
    const r = receipt(run.getEvents());
    expect(r.workflow).toBe('bug-fix');
    expect(r.status).toBe('done');
    expect(r.totalTurns).toBe(4); // reproduce, fix, say, handoff
  });

  it('runs tdd-loop end to end and produces expected receipt', async () => {
    const wf = loadWorkflow('tdd-loop.reins.md');

    let npmTestCalls = 0;
    const commandRunner = async (cmd: string) => {
      if (cmd === 'npm test') {
        npmTestCalls++;
        // red run fails, green run passes
        return {
          exitCode: npmTestCalls % 2 === 1 ? 1 : 0,
          stdout: '',
          stderr: npmTestCalls % 2 === 1 ? 'Failed as expected' : 'Passed',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const script = [
      // red
      { text: 'Wrote failing test\nREINS: done' },
      // green
      { text: 'Made test pass\nREINS: done' },
      // inlined review-pass: review
      { text: 'Review fine\nREINS: done' },
      // inlined review-pass: fix
      { text: 'No fix needed\nREINS: done' },
    ];

    const engine = new FakeEngine(script);
    // The loop's exit is `llm says ... and tests pass`. Plan 7.3: with no judge an LLM
    // condition is "no", so the loop could never exit. Inject a judge that says yes, and
    // record that it was actually consulted.
    const judged: string[] = [];
    const run = new Run({
      workflow: wf,
      engine,
      resolveBlock,
      commandRunner,
      judge: async (c) => { judged.push(c.t); return true; },
    });

    while (run.status !== 'done') {
      if (run.status === 'paused') {
        if (run.pauseReason?.type === 'gate') {
          run.approve();
        } else {
          break;
        }
      }
      await run.step();
    }

    expect(run.status).toBe('done');
    expect(judged).toContain('llm');
    const r = receipt(run.getEvents());
    expect(r.workflow).toBe('tdd-loop');
    expect(r.status).toBe('done');
    expect(r.knowlRecalls).toBe(1);
    expect(r.totalTurns).toBe(5); // red, green, review, fix, handoff
  });

  it('runs safe-refactor end to end and produces expected receipt', async () => {
    const wf = loadWorkflow('safe-refactor.reins.md');

    const commandRunner = async (_cmd: string) => {
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const script = [
      // plan
      { text: 'Move billing.ts to modules/billing\nREINS: done' },
      // refactor
      { text: 'Moved billing code\nREINS: done' },
      // fix
      { text: 'Restored types\nREINS: done' },
      // verify
      { text: 'Verified split\nREINS: pass' },
    ];

    const engine = new FakeEngine(script);
    const run = new Run({
      workflow: wf,
      engine,
      commandRunner,
    });

    while (run.status !== 'done') {
      if (run.status === 'paused') {
        if (run.pauseReason?.type === 'gate') {
          run.approve();
        } else {
          break;
        }
      }
      await run.step();
    }

    expect(run.status).toBe('done');
    const r = receipt(run.getEvents());
    expect(r.workflow).toBe('safe-refactor');
    expect(r.status).toBe('done');
    expect(r.gatesHeld).toBe(1);
    expect(r.verifyResults.passed).toBe(1);
    expect(r.totalTurns).toBe(4); // plan, refactor, verify, handoff
  });
});
