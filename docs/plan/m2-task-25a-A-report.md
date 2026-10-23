# M2 task 25a, group A report

New tests: `packages/server/test/m2-fix-25a-a.test.ts` (57), `packages/app/test/m2-fix-25a-a.test.ts` (23). New code: `packages/core/src/viewShape.ts` (the one shared shape check, exported from core `index.ts`).
After the parked session: no planted break was left (the mutation script restores and compares file hashes; all 28 hashes matched; the whole group-A test set is green: 10 files, 280 tests). Typecheck is clean for my files (the `viewShape.ts(18,14)` error is fixed: `CORE_EVENTS` is a `Record<string, 1>` because other files merge their own names into `RunEvents`; a server test pins the list to the interface in `run.ts`).

Tests were written after the fix for B1, so "red at HEAD" is shown by the mutations that remove each piece (every one goes red), not by a run at the old commit.

## B1: confirmed, fixed
- Shared check `viewShapeProblem(view, { mod?, served? })`: every enum (colour, icon, slice, group, input, check, card section, row className), flags true or absent, `stops` only for the `end` view and never for a mod, fields typed (`key` in `provides.attrs` or title/prompt for a mod), `line` entries a string or `{ field }` naming one of its fields, `sub`, `card`, `fresh` (title, prompt, attrs; `cond` only for core; attrs keys in `provides.attrs`, text values), `rows` (keys in `provides.events` and never a core event), unknown keys refused by name. Enum tables are `Record<Union, 1>` so a new member is a compile error until added.
- Server: `viewProblems` (kinds.ts) calls it after the old checks (size, kind, counts, hidden characters first, so old messages stay); `kinds-view.ts` runs it again on every served view with the mod's own `provides` (a view that got there another way is left out, with a problem line).
- App: `setKinds` drops any entry failing the same check (and keeps the first of two views of one kind); `fieldOf` reads the step's own kind only (`panelEdit.ts`); `newStep` (blocks.ts) spreads `fresh` first and sets id, kind, cards, links after, used by `addStepAt` and the drop in `Workspace.tsx`; `viewRows()` ignores core events, a null-prototype object, first view wins. `BlocksPane.tsx`, `Palette.tsx` and `arrange.ts` need no change: after `setKinds` no entry can hold a null field, line entry or non-text sub, and `capKind` can only find `end`.
- Tests: the review's hostile manifest is refused (and 36 single-rule cases); served anyway (bypassing the server) it is dropped by `servedKinds` and by `setKinds`; with `registerView` (no check at all) `fieldValue` stays `write`, `applyField` still stores `read-only`, `fields: [null]` does not throw, `fresh` cannot set id/kind/cards/links, a core event row is unchanged.
- Mutations (all red): colour enum off (6), line entry text unchecked (2), server skips shape (38), served shape skipped (2), setKinds takes all (14), fieldOf across kinds (2), fresh spread last (1), core events open to rows (1), row events not tied to provides (1), stops allowed for a mod (2), core row names allowed (1), fresh key `kind` allowed (1), fresh attrs not in provides (1, applied by hand), className unchecked (2), `trusted` key accepted (1), duplicate kinds last wins (1).
- Open: a mod's `provides.events` may still list a non-`RunEvents` feed type that has no row file (none exists today). `rows` for a core event is refused on the server and ignored in the app.

## MINOR 2: confirmed, fixed
`CORE_NAMES` (kinds.ts) holds core's condition and card names, read when the module loads. `providesProblems` refuses them (no bundled shadow exists in M2). `kinds-view` serves core's own data for a core name whatever a registry view says. Mutations: refusal off (1), mod view first for a condition (1), for a card (1).
Pins changed: `questions-cards.test.ts` (the "manifest view wins over the built-in's" test now says the built-in's data is served; three tests that used `cmd`/`guard`/`llm` now register their own atom/card with a helper `withMod`), `toy-block-import.test.ts` ("a warning" is now a 400 refusal with words), `servedMenus.test.ts` (`withMod` edits the reply instead of recording a view under a core name). The `clashes` warning in `actions.ts` still serves block kinds.

## MINOR 4: confirmed, fixed
`addsOf` adds `its prompt is "<template>"` (JSON quoted, cut at 300, a hidden character is named, not sent); `SummaryList` shows every line with `showText`. `kinds-view` serves `trusted: false` only for a mod with code (or a mod it cannot find). Mutations: flag back (1), no prompt line (1), uncut (1), no `showText` (1).
Pins changed: `kinds-route.test.ts` (a `trusted` key in a mod view is now refused, not ignored), `unknownKind.test.ts` (its mod mock now has `provides` and `hasCode: true`, as a real mod has), `view-shape.test.ts` (helper `provides.events` lists the event names its rows use).

## MINOR 5: confirmed, fixed in part
`App.tsx`: `readKinds` is also called when Settings closes, and a state bump redraws. Not done: a `generation` in the reply (nothing would read it besides that refetch). The test is a source pin (no DOM harness); mutation: call removed (1). Left open: the trigger itself is not exercised in a browser.

## MINOR 6: confirmed, fixed
`generic.tsx` shows the data through `showText` (`<U+202E>` form). Mutation: removed (1).

## MINOR 10 (names half): confirmed, fixed
`providesProblems` refuses any name in `Object.prototype` and `prototype` for kinds, ops, attrs, events, conditions, cards. Mutations: refusal off (6), only the `in` test (1). The core half (`defaultId`, receipt counts) is group B's.

## M1 (app half): confirmed, fixed
`stepStatus` keeps its map in `Object.create(null)`; test with ids `__proto__`, `constructor`, `toString`. Mutation: plain object (1). The core `validate` half is group B's.

## Notes
- No file outside my list was edited. Group B's `validate`/`receipt` changes are theirs.
- `docs/plan/m2-25a-a-mutate.ps1` is the mutation script I used (28 breaks).
- `git status --short` (my files): `M` App.tsx, ImportSummary.tsx, Workspace.tsx, blocks.ts, canvasKinds.ts, generic.tsx, panelEdit.ts, rows.tsx, stepStatus.ts, core index.ts, server mods actions.ts, kinds-view.ts, kinds.ts; pins in view-shape, kinds-route, questions-cards, toy-block-import, servedMenus, unknownKind tests; `??` viewShape.ts and the two `m2-fix-25a-a.test.ts`.
