import { describe, it, expect } from 'vitest';
import {
  repeatedAction,
  stagnation,
  editBeforePlan,
  skipValidation,
  sameError,
} from '../src/drift.js';
import { receipt } from '../src/receipt.js';
import type { RunEventRecord } from '../src/run.js';

describe('Task 1.8: Drift Rules and Receipt', () => {
  describe('Drift rules', () => {
    it('repeatedAction fires on 3 identical tool calls in one step and stays quiet on clean trace', () => {
      const badTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'turn_started', data: { step: 's1' } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { tool: 'Read', input: { path: 'a.ts' } } },
        { id: '3', timestamp: 3, type: 'tool_call', data: { tool: 'Read', input: { path: 'a.ts' } } },
        { id: '4', timestamp: 4, type: 'tool_call', data: { tool: 'Read', input: { path: 'a.ts' } } },
      ];
      const findingBad = repeatedAction(badTrace, 3);
      expect(findingBad).not.toBeNull();
      expect(findingBad?.card).toContain("run the same thing 3 times");

      const cleanTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'turn_started', data: { step: 's1' } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { tool: 'Read', input: { path: 'a.ts' } } },
        { id: '3', timestamp: 3, type: 'tool_call', data: { tool: 'Read', input: { path: 'b.ts' } } },
      ];
      expect(repeatedAction(cleanTrace, 3)).toBeNull();
    });

    it('stagnation fires on >25 tool calls with no file change and stays quiet on clean trace', () => {
      const badEvents: RunEventRecord[] = [
        { id: 'start', timestamp: 0, type: 'turn_started', data: { step: 's1' } },
      ];
      for (let i = 1; i <= 26; i++) {
        badEvents.push({
          id: `${i}`,
          timestamp: i,
          type: 'tool_call',
          data: { tool: 'Read', input: { path: `file${i}.ts` } },
        });
      }
      const finding = stagnation(badEvents, 25);
      expect(finding).not.toBeNull();
      expect(finding?.card).toContain('25 steps with no change');

      const cleanEvents: RunEventRecord[] = [
        { id: 'start', timestamp: 0, type: 'turn_started', data: { step: 's1' } },
        { id: '1', timestamp: 1, type: 'tool_call', data: { tool: 'Read', input: { path: 'a.ts' } } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { tool: 'Edit', input: { path: 'a.ts' } } },
      ];
      expect(stagnation(cleanEvents, 25)).toBeNull();
    });

    it('editBeforePlan fires on write attempt in read-only step and stays quiet on clean trace', () => {
      const badTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'turn_started', data: { step: 'plan', mode: 'read-only' } },
        { id: '2', timestamp: 2, type: 'refusal', data: { reason: 'Blocked by Reins: step is read-only.' } },
      ];
      expect(editBeforePlan(badTrace)).not.toBeNull();

      const cleanTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'turn_started', data: { step: 'plan', mode: 'read-only' } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { tool: 'Read', input: { path: 'a.ts' } } },
      ];
      expect(editBeforePlan(cleanTrace)).toBeNull();
    });

    it('skipValidation fires when a step saying to test ends without running tests and stays quiet when tests run', () => {
      const badTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'turn_started', data: { step: 'test-step', prompt: 'Run the tests now' } },
        { id: '2', timestamp: 2, type: 'turn_ended', data: { step: 'test-step' } },
      ];
      const finding = skipValidation(badTrace, 'Run the tests now');
      expect(finding).not.toBeNull();
      expect(finding?.card).toContain("haven't run the tests");

      const cleanTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'turn_started', data: { step: 'test-step', prompt: 'Run the tests now' } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { tool: 'Bash', input: { command: 'npm test' } } },
        { id: '3', timestamp: 3, type: 'turn_ended', data: { step: 'test-step' } },
      ];
      expect(skipValidation(cleanTrace, 'Run the tests now')).toBeNull();
    });

    it('sameError fires on two identical failed command outputs and stays quiet on pass or different errors', () => {
      const badTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'tool_call', data: { tool: 'Bash', input: { command: 'npm test' } } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { exitCode: 1, output: 'Error 404 at /path/1: timeout' } },
        { id: '3', timestamp: 3, type: 'tool_call', data: { exitCode: 1, output: 'Error 404 at /path/2: timeout' } },
      ];
      const finding = sameError(badTrace);
      expect(finding).not.toBeNull();
      expect(finding?.card).toContain('Same error again');

      const cleanTrace: RunEventRecord[] = [
        { id: '1', timestamp: 1, type: 'tool_call', data: { exitCode: 1, output: 'Error: timeout' } },
        { id: '2', timestamp: 2, type: 'tool_call', data: { exitCode: 0, output: 'Success' } },
      ];
      expect(sameError(cleanTrace)).toBeNull();
    });
  });

  describe('The receipt', () => {
    it('counts match a hand-counted event log for the full upload-retry run', () => {
      const events: RunEventRecord[] = [
        { id: '1', timestamp: 1000, type: 'run_started', data: { workflow: 'upload-retry' } },
        { id: '2', timestamp: 1100, type: 'recall', data: { topics: ['upload', 'retry'] } },
        { id: '3', timestamp: 1200, type: 'turn_started', data: { step: 'plan' } },
        { id: '4', timestamp: 1300, type: 'refusal', data: { reason: 'Blocked by Reins: step is read-only.' } },
        { id: '5', timestamp: 1400, type: 'turn_ended', data: { step: 'plan' } },
        { id: '6', timestamp: 1500, type: 'gate_paused', data: { step: 'gate-1' } },
        { id: '7', timestamp: 1600, type: 'gate_approved', data: {} },
        { id: '8', timestamp: 1700, type: 'turn_started', data: { step: 'implement' } },
        { id: '9', timestamp: 1800, type: 'refusal', data: { reason: 'Blocked by Reins: migrations/** is guarded.' } },
        { id: '10', timestamp: 1900, type: 'card_delivered', data: { card: 'nudge 1', channel: 'mid-turn' } },
        { id: '11', timestamp: 2000, type: 'turn_ended', data: { step: 'implement' } },
        { id: '12', timestamp: 2100, type: 'loop_iteration', data: { step: 'repeat-1', attempt: 1 } },
        { id: '13', timestamp: 2200, type: 'loop_iteration', data: { step: 'repeat-1', attempt: 2 } },
        { id: '14', timestamp: 2300, type: 'turn_started', data: { step: 'fix' } },
        { id: '15', timestamp: 2400, type: 'turn_ended', data: { step: 'fix' } },
        { id: '16', timestamp: 2500, type: 'turn_started', data: { step: 'verify' } },
        { id: '17', timestamp: 2600, type: 'turn_ended', data: { step: 'verify' } },
        { id: '18', timestamp: 2700, type: 'verify_result', data: { pass: true } },
        { id: '19', timestamp: 2800, type: 'card_queued', data: { card: 'same error auto' } },
        { id: '20', timestamp: 2900, type: 'store', data: { what: 'decisions' } },
        { id: '21', timestamp: 3000, type: 'engine_cost', data: { usd: 0.15 } },
        { id: '22', timestamp: 3100, type: 'run_finished', data: {} },
      ];

      const r = receipt(events);

      expect(r.workflow).toBe('upload-retry');
      expect(r.status).toBe('done');
      expect(r.gatesHeld).toBe(1);
      expect(r.guardRefusals).toBe(1);
      expect(r.readOnlyRefusals).toBe(1);
      expect(r.totalRefusals).toBe(2);
      expect(r.loopAttempts).toBe(2);
      expect(r.liveCardsDelivered).toBe(1);
      expect(r.autoCardsFired).toBe(1);
      expect(r.verifyResults).toEqual({ passed: 1, failed: 0 });
      expect(r.knowlRecalls).toBe(1);
      expect(r.knowlStores).toBe(1);
      expect(r.totalTurns).toBe(4);
      expect(r.totalCostUsd).toBe(0.15);
      expect(r.totalTimeMs).toBe(2100);
    });
  });
});
