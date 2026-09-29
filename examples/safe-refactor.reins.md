---
reins: 1
name: safe-refactor
task: split billing.ts into modules
budget: { turns: 60, minutes: 60, usd: 3.00 }
always:
  - Behaviour must not change.
  - No public API changes.
---

## run `npm test`

## phase plan
note: list moves, no code
> List every move you will make. No code yet.

## gate
until: you approve

## phase refactor
guard: src/api/**
note: move code, change nothing else
> Move code as planned. Do not change behaviour.

## repeat
until: tests pass and `npm run typecheck` passes
max: 3

### run `npm test`

### phase fix
note: restore behaviour
> Restore the old behaviour. Do not change the tests.

## verify
against: plan

## handoff
to: fresh session
focus: summary

## whenever diff > 400 lines
nudge: too big. split the refactor.
