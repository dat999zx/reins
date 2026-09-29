import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileProgram, compileTurn } from '../src/compile.js';
import { parseWorkflow } from '../src/format/parse.js';
import type { Workflow } from '../src/model.js';

describe('Task 1.6: The Compiler', () => {
  const examplesDir = path.resolve(__dirname, '../../../examples');
  const goldenDir = path.resolve(__dirname, 'golden');

  const uploadRetryContent = fs.readFileSync(
    path.join(examplesDir, 'upload-retry.reins.md'),
    'utf8'
  );
  const reviewPassContent = fs.readFileSync(
    path.join(examplesDir, 'blocks/review-pass.reins.md'),
    'utf8'
  );

  const { workflow: uploadRetry } = parseWorkflow(uploadRetryContent);
  const { workflow: reviewPass } = parseWorkflow(reviewPassContent);

  const blocks: Record<string, Workflow> = {
    'review-pass': reviewPass!,
  };

  it("The instruction list for upload-retry matches §6.1's listing", () => {
    const instrs = compileProgram(uploadRetry!, (name) => blocks[name]);

    // Expected sequence according to §6.1:
    // 0  RECALL   topics=[upload, retry]
    // 1  TURN     step=plan      policy=read-only
    // 2  GATE     step=gate-1    cond=you approve
    // 3  TURN     step=implement policy=write guards=[migrations/**]
    // 4  LOOP_IN  step=repeat-1  max=5
    // 5  RUN      step=run-1     cmd="npm test"   → on pass: JUMP 8
    // 6  TURN     step=fix       policy=write
    // 7  LOOP_BK  step=repeat-1  → 5
    // 8  VERIFY   step=verify-1  against=plan  → on fail: JUMP 3 (link max 2)
    // 9  USE ...  (inlined review-pass: review, fix, gate-1)
    // 12 STORE    step=store-1
    // 13 HANDOFF  step=handoff-1
    // 14 END

    expect(instrs[0]).toMatchObject({
      op: 'RECALL',
      step: 'recall-1',
      topics: ['upload', 'retry'],
    });

    expect(instrs[1]).toMatchObject({
      op: 'TURN',
      step: 'plan',
      policy: { mode: 'read-only' },
    });

    expect(instrs[2]).toMatchObject({
      op: 'GATE',
      step: 'gate-1',
      cond: { t: 'approve' },
    });

    expect(instrs[3]).toMatchObject({
      op: 'TURN',
      step: 'implement',
      policy: { mode: 'write', guards: ['migrations/**'] },
    });

    expect(instrs[4]).toMatchObject({
      op: 'LOOP_IN',
      step: 'repeat-1',
      max: 5,
    });

    expect(instrs[5]).toMatchObject({
      op: 'RUN',
      step: 'run-1',
      cmd: 'npm test',
      onPassJump: 8,
    });

    expect(instrs[6]).toMatchObject({
      op: 'TURN',
      step: 'fix',
      policy: { mode: 'write' },
    });

    expect(instrs[7]).toMatchObject({
      op: 'LOOP_BK',
      step: 'repeat-1',
      target: 5,
    });

    expect(instrs[8]).toMatchObject({
      op: 'VERIFY',
      step: 'verify-1',
      against: 'plan',
      onFailJump: 3,
      linkMax: 2,
    });

    // Inlined review-pass with prefixed IDs:
    expect(instrs[9]).toMatchObject({
      op: 'TURN',
      step: 'review-pass/review',
      policy: { mode: 'write' },
    });

    expect(instrs[10]).toMatchObject({
      op: 'TURN',
      step: 'review-pass/fix',
      policy: { mode: 'write' },
    });

    expect(instrs[11]).toMatchObject({
      op: 'GATE',
      step: 'review-pass/gate-1',
      cond: { t: 'llm', q: 'no blocking issues left' },
    });

    expect(instrs[12]).toMatchObject({
      op: 'STORE',
      step: 'store-1',
      what: 'decisions',
    });

    expect(instrs[13]).toMatchObject({
      op: 'HANDOFF',
      step: 'handoff-1',
      to: 'fresh session',
    });

    expect(instrs[14]).toMatchObject({
      op: 'END',
    });
  });

  it('use inlines the block with prefixed ids', () => {
    const instrs = compileProgram(uploadRetry!, (name) => blocks[name]);
    const inlinedSteps = instrs
      .filter((i) => 'step' in i && typeof i.step === 'string' && i.step.startsWith('review-pass/'))
      .map((i: any) => i.step);

    expect(inlinedSteps).toEqual([
      'review-pass/review',
      'review-pass/fix',
      'review-pass/gate-1',
    ]);
  });

  it('matches the golden text for each step of upload-retry', () => {
    // 1. plan
    const planStep = uploadRetry!.steps.find((s) => s.id === 'plan')!;
    const planText = compileTurn(planStep, {
      workflowName: uploadRetry!.name,
      stepNumber: 2,
      totalSteps: 9,
      always: uploadRetry!.always,
      recallContext: [
        'Uploads go through S3 multipart (src/s3.ts).',
        'Decision a91: retries use exponential backoff; never retry 4xx.',
      ],
    });
    const expectedPlan = fs
      .readFileSync(path.join(goldenDir, 'upload-retry-plan.txt'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    expect(planText.trim()).toBe(expectedPlan);

    // 2. implement
    const implementStep = uploadRetry!.steps.find((s) => s.id === 'implement')!;
    const implementText = compileTurn(implementStep, {
      workflowName: uploadRetry!.name,
      stepNumber: 3,
      totalSteps: 9,
      always: uploadRetry!.always,
    });
    const expectedImplement = fs
      .readFileSync(path.join(goldenDir, 'upload-retry-implement.txt'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    expect(implementText.trim()).toBe(expectedImplement);

    // 3. fix
    const repeatStep = uploadRetry!.steps.find((s) => s.id === 'repeat-1')!;
    const fixStep = repeatStep.kids!.find((s) => s.id === 'fix')!;
    const fixText = compileTurn(fixStep, {
      workflowName: uploadRetry!.name,
      stepNumber: 5,
      totalSteps: 9,
      always: uploadRetry!.always,
    });
    const expectedFix = fs
      .readFileSync(path.join(goldenDir, 'upload-retry-fix.txt'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    expect(fixText.trim()).toBe(expectedFix);

    // 4. verify
    const verifyStep = uploadRetry!.steps.find((s) => s.id === 'verify-1')!;
    const verifyText = compileTurn(verifyStep, {
      workflowName: uploadRetry!.name,
      stepNumber: 6,
      totalSteps: 9,
      always: uploadRetry!.always,
    });
    const expectedVerify = fs
      .readFileSync(path.join(goldenDir, 'upload-retry-verify.txt'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    expect(verifyText.trim()).toBe(expectedVerify);
  });

  it("The user's prompt appears unchanged inside the output", () => {
    const rawPrompt = 'Do NOT change this special line: 123 *&^%!\nKeep this intact.';
    const step = {
      id: 'custom-step',
      kind: 'phase' as const,
      title: 'custom',
      prompt: rawPrompt,
      attrs: {},
      cards: [],
      links: [],
    };
    const compiled = compileTurn(step, {
      workflowName: 'test',
      stepNumber: 1,
      totalSteps: 1,
    });
    expect(compiled).toContain(rawPrompt);
  });

  it('An enforced guard says "(Enforced…)"', () => {
    const step = {
      id: 'step1',
      kind: 'phase' as const,
      title: 'test',
      prompt: 'Do work',
      attrs: {},
      cards: [{ kind: 'guard' as const, text: 'migrations/**' }],
      links: [],
    };
    const compiled = compileTurn(step, {
      workflowName: 'test',
      stepNumber: 1,
      totalSteps: 1,
    });
    expect(compiled).toContain('Do not touch migrations/**. (Enforced: edits there are blocked.)');
  });

  it('The status-line instruction is always the last line', () => {
    const step = {
      id: 'step1',
      kind: 'phase' as const,
      title: 'test',
      prompt: 'Do work',
      attrs: {},
      cards: [],
      links: [],
    };
    const compiled = compileTurn(step, {
      workflowName: 'test',
      stepNumber: 1,
      totalSteps: 1,
    });
    const lines = compiled.trim().split('\n');
    expect(lines.at(-1)).toBe('REINS: done | blocked: <reason>');

    const verifyStep = {
      id: 'verify1',
      kind: 'verify' as const,
      attrs: { against: 'plan' },
      cards: [],
      links: [],
    };
    const verifyCompiled = compileTurn(verifyStep, {
      workflowName: 'test',
      stepNumber: 2,
      totalSteps: 2,
    });
    const verifyLines = verifyCompiled.trim().split('\n');
    expect(verifyLines.at(-1)).toBe('REINS: pass | fail: <what is missing>');
  });
});
