---
reins: 1
name: upload-retry
task: add retry to the upload endpoint
engine: claude
budget: { turns: 40, minutes: 60, usd: 3.00 }
always:
  - No new dependencies.
  - Keep functions under 40 lines.
---

## recall
knowl: upload, retry

## phase plan
mode: read-only
> Write a plan for adding retry to the upload endpoint.
> Do not write code. Output the plan as a numbered list, then stop.

## gate
until: you approve

## phase implement
guard: migrations/**
note: Explain each change in one line.
> Implement the approved plan. Do not deviate; if you must, stop and say why.

## repeat
until: `npm test` passes
max: 5

### run `npm test`

### phase fix
> Read the error output first. Fix the cause, not the symptom.

## verify
against: plan
on-fail: implement (max 2)

## use review-pass

## store
knowl: decisions

## handoff
to: fresh session
focus: summary for the next agent

## whenever same error twice
nudge: Stop. Read the error before re-running.

## whenever diff > 300 lines
nudge: Split this into smaller steps.
