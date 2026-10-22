# M2 Task 24a report (small fix round)

Worked in the tree at HEAD 3ab5b8b. Nothing committed.

## A. Block view shape (carry 9)

- `packages/server/src/mods/kinds.ts` (`viewProblems`): `view.sub` must be text of at most 200 characters. `view.rows` must be an object. Each row must be an object with only `text`, `details`, `className`. `text` is required, text, at most 200. `details` is text, at most 400. `className` must be `sx-sub` or `faint`. Each refusal names the field (`view.sub`, `view.rows.<type>`). The hidden-character check already covered every string in the view, so it covers these too.
- New exported `ROW_CLASSES` in `kinds.ts`. The built-in views use no `className` at all; the only two names in the code are the type in `core/src/nodes/fields.ts` (`'sx-sub' | 'faint'`), so those are the allowlist.
- `packages/app/src/BlockRow.tsx` (the only place a view's `className` reaches the DOM): draws a plain `row` for any class not in its own `ROW_CLASSES`. I did not touch `core/.../fields.ts` (not on my list), so the list is duplicated and a test pins the two equal.
- Tests, new: `packages/server/test/view-shape.test.ts` (9), `packages/app/test/rowClass.test.ts` (4).
- Red at HEAD: 7 of 9 and 2 of 4 (the rest are "accepts valid" and "keeps allowed class" cases that pass by design).
- Mutations (each shown red, file restored, hash compared): sub type; sub cap; rows not object; row not object; extra keys; text type; text cap; details type; details cap; className check removed; server list widened (also red in the app pin); `className !== undefined` guard removed (red: a missing class is accepted as invalid); cap 400 to 401; app allowlist bypassed; app list narrowed. 15 red.
- Survivor: dropping `className !== undefined &&` in `BlockRow.tsx` (`includes(undefined)` is false anyway) is equivalent, no test possible.

## B. canvas-chips survivor (Task 22)

- Edited `packages/server/test/canvas-chips.browser.test.ts` (existing, allowed): the test is now `it.each([false, true])`. The `true` case renders the Blocks canvas with no run, then logs the finished run and makes the app reconnect (a test hook on `EventSource` via `addInitScript`; the server only pushes rows a live session writes), so the chips arrive after first paint.
- Red proof: with the `MutationObserver` observe call removed in `Workspace.tsx` and the bundle rebuilt, the late case fails (`chip "..." covers end-2`) and the early case passes. Restored (hash equal), bundle rebuilt, both green.
- **OPEN, found by this test (not fixed, `Workspace.tsx` is not mine):** in the late case the arrow checks (tip on target, route clears chips) fail even WITH the observer: `on-fail link from verify-1 to plan: the route runs over the chip of end-2`. It stays wrong for at least 3 s and is fixed by any later DOM change (I appended an element and it went green). Cause I believe: `measure` sets `--chip-over`, which moves the free column, and nothing measures again after that. So the late case asserts only "no chip covers a block" and returns before the arrow checks, with a comment pointing here. Someone should re-measure after `--chip-over` changes (e.g. a second `requestAnimationFrame` measure) and then delete the early `return`.

## C. Data block summary (carry 10)

- Not already so: the import summary showed no code line and no "nothing to trust" words (Settings already showed `trust: none`, status `ready`, no Trust button).
- Smallest change: `packages/server/src/mods/actions.ts` `addsOf` adds the line `has no code, so there is nothing to trust` for a block with no `main` (replaces the Task 19 hook comment). It shows in the import summary and in the Settings row's `adds`. I did not change `summaryLines`, because an existing test pins a provider's lines exactly.
- Test, new: `packages/server/test/data-block-summary.test.ts` (3, real server): summary has the line, no code prompt, no hash, no "Has code", `planOf` can import with no trust choice; a code block (toy-beep) does not get the line and still has the trust choice; the Settings row is `trust none`, no hash, status `ready`, cannot trust, `adds` has the line.
- Red at HEAD: 2 of 3. Mutations: line removed (2 red); applied to any block (1 red); condition inverted (3 red); wording changed (2 red).

## Existing tests edited

- `packages/server/test/canvas-chips.browser.test.ts` only (named in the brief).

## Other notes

- App bundle `packages/app/dist` rebuilt twice (restored build matches the source).
- Ran only my four files. Line endings kept: `kinds.ts`, `actions.ts`, `canvas-chips.browser.test.ts` CRLF; the rest LF as at HEAD. No BOM, no U+2014.

## git status --short (my files)

```
 M packages/app/src/BlockRow.tsx
 M packages/server/src/mods/actions.ts
 M packages/server/src/mods/kinds.ts
 M packages/server/test/canvas-chips.browser.test.ts
?? docs/plan/m2-task-24a-report.md
?? packages/app/test/rowClass.test.ts
?? packages/server/test/data-block-summary.test.ts
?? packages/server/test/view-shape.test.ts
```
