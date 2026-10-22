# M2 Task 22: canvas cost chips and the arrow tip (report)

Brief: v5-1 "M2 Task 22", v3 Task 19. Branch feat/fork-playbook, HEAD 4a17220 plus other sessions' uncommitted work (Task 17a and others). Nothing committed, staged, stashed or reset.

## What I built

1. **A new browser test first**: `packages/server/test/canvas-chips.browser.test.ts`. It starts a real server, seeds a finished run in the log (`run_started` with the file's step list, then `step_started` and `turn_ended` with a cost for each step, then `run_finished`), opens the workflow in Text, then shows Blocks. It asserts three things:
   - (1) no cost chip covers a block. A chip of a block inside a loop is not checked against that loop's frame (see "open" below).
   - (2) every arrow's tip lies on the border of the block its label names as the target (within 2 px), and inside no other block (a block that wraps the target is skipped).
   - (3) no arrow's route runs over the cost chip of a block that is neither its source nor its target.
   The workflow: a loop with a phase inside (`repeat-1`, `fix`), a phase `plan` with `next: end-1`, a command `run-1`, the stack's `end-1`, then a free `verify-1` (`against: plan`, `on-fail: plan (max 2)`) and its `end-2`.
2. **The fix** (smallest I found):
   - `Workspace.tsx` `measure`: each block records `cr`, the right edge of its own chips (script coordinates). The stack's widest chip overhang is written to `--chip-over` on the script. A `MutationObserver` on the view calls `measure` when chip text arrives (a chip is text, not a size change of the script).
   - `app.css` `.sx-autofree`: `margin-left: calc(80px + var(--chip-over, 0px))`. With no chips the overhang is 0 and the offset is the old 80px.
   - `arrows.ts` `geo`: the bracket lane `out` is `max(x1, x2, from.cr, to.cr) + 24 + 10 * lane`. With no chips `cr` is absent and `-Infinity` is used, so the value equals the old one exactly (a plain `0` would have clamped negative coordinates).
   - `Workspace.tsx` `world` carries `cr` into the arrow rects; the `rects` state type gained `cr`.

## Red at HEAD (before the fix)

Run at the HEAD source (both the CSS and the lane reverted by hand, bundle rebuilt):

- (1) RED: `chip "✓ · on claude-haiku-5-5 · $0.0123" covers end-2`. This is the reported bug: the loop's chip sits on the free `end-2`.
- (2) GREEN at HEAD for every layout I could build. The arrow-tip part of the hypothesis did NOT reproduce. Tips always landed on the target border in these layouts. I could not find a layout that puts a tip on `end`. Only the route (3) and the column (1) reproduce.
- (3) RED with the lane alone reverted (CSS fix kept): three arrows run over chips of `run-1`, `end-2` (twice). At full HEAD (3) was not reached in the same run because (1) throws first; its red at HEAD follows from this run.

## Mutations (hand-applied, restored by editing back, hashes compared)

| # | Break | Result |
|---|---|---|
| M0 | Both fixes reverted (HEAD behaviour) | (1) red: chip covers `end-2` |
| M1 | `.sx-autofree` offset back to `80px` (chip offset removed) | (1) red: chip covers `end-2` |
| M2 | `out` ignores `cr` (lane offset removed) | (3) red: 3 arrows run over chips of `run-1` and `end-2` |
| M3 | tip row taken from the source block (`y2` from `from`) | (2) red: tips not on the border of `plan`, `end-1` |
| M4 | tip computed against the source block (`geo(from, from, ...)`) | (2) red: tips not on the border of the target |
| M5 | `MutationObserver` removed (chips not re-measured) | SURVIVED: the test passes (see open) |
| M6 | last chip decides `over` (not the widest) | (1) red: chip covers `end-2` |

Six breaks red (M0, M1, M2, M3, M4, M6), one survivor (M5). After all mutations the four touched files were compared with the recorded fixed-state hashes: identical.

## Green after the fix (final source)

- `canvas-chips.browser.test.ts`: passes.
- `packages/app/test/arrows.test.ts`: 28 of 28 pass.
- `smoke.browser.test.ts`: 2 of 2 pass (canvas, no chips in most steps).
- `live.browser.test.ts`: 1 of 1 pass (canvas and run state).
- App typecheck (`tsc -p packages/app --noEmit`): 0 errors (after fixing my own `rects` type).

## Open (for you to decide)

1. **A chip of a block inside a loop sits in the loop frame.** When the child is narrower than the loop, the child's chip (for example `fix`) lies inside `repeat-1`'s box. The test does not count a block's own ancestors for chips (`wraps` / `up` rule), and I did not change loop layout (a fix there changes runs with no chips). Decide if this is in scope.
2. **The arrow-tip hypothesis is not reproduced.** Tips always land on the target border in my layouts. The route through chips (3) is what the lane fix addresses. If the user's `end` tip is real, I need the user's workflow file.
3. **M5 survived.** Chips are present at mount in this test (the run is seeded before load), so the browser test cannot show the observer's effect. A live run's chip grows with cost while no layout dependency changes, so the observer is needed there. Equivalence proof: none. A test needs a status-only change in the page (a live row over SSE). `store.appendLog` does not reach the page (SSE rows come from `onRow` in the session path), so the harness cannot produce one without an engine.
4. **Arrow lanes and labels move.** Bracket arrows now run past the widest chip, so with chips they sit further right than before. No change without chips.

## Learned about the harness (for the plan)

- `next:` to a free block is an error ("Link target not found"); `on-fail:` into a loop body is an error ("wire jumps into the body").
- In my first attempts a workflow with an error diagnostic showed no chips at all. I did not isolate the exact cause; the test's workflow has no errors (one warning: `verify-1` is never reached).
- The seeded `run_started` carries the file's step list (`{id, kind}` in file order), as a real run does. I did not test whether the list is required.

## Existing tests edited

None. The new file is the only test change.

## Files

- `packages/app/src/Workspace.tsx`: `measure` area, the new observer effect, the `world` line, the `rects` type. Other hunks in this file belong to other sessions (Task 17a and others) and I did not touch them.
- `packages/app/src/app.css`: line 236 (`.sx-autofree`).
- `packages/app/src/arrows.ts`: `geo` and `arrowPath` signatures and the `out` value. The line-15 change (`KINDS[s.kind]?.stops`) belongs to another session, not to me.
- `packages/server/test/canvas-chips.browser.test.ts`: new, CRLF.
- `docs/plan/m2-task-22-report.md`: this file, new.

No U+2014 in my files. CRLF in all touched and new files (verified by byte count). The app bundle was rebuilt several times; the last build is from the final source.

## git status (my files)

```
 M packages/app/src/Workspace.tsx
 M packages/app/src/app.css
 M packages/app/src/arrows.ts
?? packages/server/test/canvas-chips.browser.test.ts
?? docs/plan/m2-task-22-report.md
```

(`Workspace.tsx` and `arrows.ts` also carry other sessions' uncommitted hunks; they are not part of this task.)
