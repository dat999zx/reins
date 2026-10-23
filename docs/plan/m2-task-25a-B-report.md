# M2 task 25a, group B report (core engine)

Test file (new): `packages/core/test/m2-fix-25a-b.test.ts` (38 tests, green). Source files changed: `run.ts`, `validate.ts`, `compile.ts`, `parse.ts`, `receipt.ts`, `nodes/index.ts`. `guard.ts` and `cond.ts` not touched. No existing test edited.

"Red at HEAD" was shown by breaking each fix by hand (the new tests could not be run against a clean HEAD without stash or checkout, which the rules forbid). 25 hand mutations, each turned the new test file red, each file restored and its hash compared (equal every time).

## M2 (op or block that does not move on; cap on vm.log): done, confirmed
- Fix: after a mod op returns, if the track is still `alive` (alive is false for paused, stopped, parked) and `t.pc` is unchanged, `pauseForStop` with `The block "<id>" did not move on; Resume tries again`. Same for a mod NODE answering `'stay'` while alive. `logGate(mod, cut)` counts calls per instruction; the 101st calls `cut` (pause with words). `LOG_MAX = 100` in `run.ts`.
- Tests: one per path (op, NODE), a moving op, goto, an op or NODE that paused itself keeps its pause, log cap for op and NODE, exactly 100 allowed, limit is per instruction.
- Mutations (all red): check off, inverted, ignoring alive; NODE check off; log cap off, off by one, value 1000.

## M1 core half and MINOR 10 (objects half): done, confirmed
- `validate.ts`: error `"<id>" cannot be a step id: it is a name every object already has. Pick another id` for any `id in Object.prototype` plus `prototype`.
- `run.ts` `subagents`: null-prototype table, also after `restore`. `nodes/index.ts` `defaultId`: `Object.hasOwn` before reading the counter. `parse.ts` counters: null-prototype. `receipt.ts` counts: a `Map`, turned into an object at the end.
- Tests: 7 ids refused, ordinary id fine, subagent step `constructor` and `__proto__` (snapshot, restore, table prototype), `defaultId` 1,2,3 for `constructor`, parsing a kind `constructor`, receipt count keys `constructor`, `toString`, `hasOwnProperty`.
- Mutations (all red): validate member check off, `prototype` off, subagents plain object, restore plain object, `defaultId` without hasOwn, receipt count wrong, receipt counts dropped.
- Survivor, equivalent: the null-prototype `counters` in `parse.ts` alone is covered by the `defaultId` hasOwn fix (either one passes the parse test). Kept as a second guard.
- Left open, not my file: `format/print.ts:69-82` still uses a plain `{}` and `{ ...counters }`. With the `defaultId` fix it is correct for `constructor`; a kind literally named `__proto__` would still repeat ids there. Group owner of `print.ts`: none listed.
- `guard.ts:163` (`__proto__` count key refused) kept; now redundant but harmless.

## MINOR 1 (modVm pause and takeLink): done, confirmed
- `modPause()` rebuilds the pause: `type` must be one of gate, budget-used, link-budget-used, agent-blocked, stop (else `cut` with words); `stepId`, `reason`, `text`, `linkKey` go through `tame` (cap 200); `limit`, `spent` only if finite; `to` only if a place in the program. `track`, `title`, `cond`, functions and nested objects are dropped. Consequence: a mod gate pause loses its `cond` (brief said no object fields).
- `takeLink` gate runs `place(to)`: NaN, Infinity, negative, fraction, string, undefined, past the end are refused with `...which is not a place in the program; Resume tries again`.
- Tests: track/title/function dropped and `structuredClone(snapshot)` works, `pauses()` has no track key; six bad types and three non-objects refused; tame and cap (BIDI shown as `<U+202E>`); NaN/Infinity dropped; `to` kept only when sound; takeLink bad targets, a good one, and a budget pause carrying `to`.
- Mutations (all red): type unchecked, track/title kept, text not tamed, number not finite, `to` unchecked, takeLink gate off, pause gate off.
- Note: `tame` keeps a line break as is (the existing helper); I did not change it.

## MINOR 7 (edit checks the program): done, confirmed
- `edit()` now compiles into locals, calls `programProblem(program, false)`, and on a problem keeps the old workflow and program and pauses `step-deleted`. Tests: bad `next` after an edit keeps the old program (same object) and workflow; a good edit installs. Mutation: check off (red).

## MINOR 8 code half (compile get): done; push-copy half NOT confirmed
- `compile.ts`: a mod node's compile gets a context whose `get` returns a frozen clone (core nodes still get the real one; `repeat` needs it). Tests: it cannot rewrite an earlier TURN (program equals the plain one), the copy is frozen, `get(50)` is undefined. Mutations (all red): core ctx for mods, clone not frozen, real instruction returned.
- `push` copy: not changed. The review says `push` keeps the mod's reference past the program check. It does not: the instructions of a mod node are replaced by frozen clones at the end of `compileProgram`, before any check (`compile.ts`, `modSpans`), and the existing test `what a mod compiles is a frozen copy: a handle the mod kept changes nothing` pins it. Copying in `push` would also change the pinned `holds more than plain data` message and break fixtures that mutate the value `push` returns.
- GUIDE sentences are group C's.

## Checks
- Core tests run (36 files, 575 tests, all green) before the last change of the test file's line endings; after that my file and `mod-contain.test.ts`: 104 green. Server mod tests: `mods-keys.test.ts` green; the other server mod files were started when the session stopped and were NOT confirmed, so run them in the gate.
- `tsc --noEmit` in core: only group A's `src/viewShape.ts(18,14)`. My files are clean.
- CRLF kept in all six source files and the new test file; no U+2014.
- M3 (host feeds `kinds`) and MINOR 9 etc. are other groups'/owners'.
