---
reins: 1
block: checks
---

## run `npm test -- {{target}}`

## repeat
until: `npm run check -- {{target}}` passes
max: 2

### phase fix
> Fix {{target}}.
