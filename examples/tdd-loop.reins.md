---
reins: 1
name: tdd-loop
task: add CSV export to reports
budget: { turns: 120, minutes: 60, usd: 6.00 }
always:
  - One test at a time.
---

## recall
knowl: reports, csv

## repeat
until: llm says "every requirement has a test" and tests pass
max: 8

### phase red
note: one failing test
> Write exactly one failing test for the next requirement.

### run `npm test`

### phase green
note: make it pass
> Write the least code that makes the new test pass.

### run `npm test`

## use review-pass

## handoff
to: fresh session
focus: summary

## whenever attempts > 3
checkpoint: what did you verify?
