---
reins: 1
block: review-pass
---

## phase review
note: as a harsh reviewer
> Review the full diff as a harsh reviewer. List real problems only.

## phase fix
note: only the real problems
> Fix the problems from the review. Nothing else.

## gate
until: llm says "no blocking issues left"
