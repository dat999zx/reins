---
reins: 1
name: bug-fix
task: "fix: uploads over 5 GB fail"
budget: { turns: 80, minutes: 60, usd: 4.00 }
always:
  - Reproduce the bug before changing code.
---

## phase reproduce
note: write a failing test first
> Write a test that reproduces the bug. It must fail for the right reason.

## gate
until: not tests pass

## repeat
until: tests pass
max: 4

### phase fix
note: smallest change that works
> Make the smallest change that makes the test pass.

### run `npm test`

## if diff > 300 lines or touches src/core/**

### gate
until: you approve

### else

### say
> Small fix. Explain the root cause in two sentences.

## handoff
to: fresh session
focus: what broke and why
