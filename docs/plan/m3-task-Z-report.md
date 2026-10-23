# M3 Task 7 (group Z) report: `model` and `subagent` move into the default pack

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 1f961eb (after Task 3). Four groups worked in the same tree. Nothing committed, added, stashed, reset, checked out or pushed. `use` is not moved.

Result: both kinds are bundled pack mods (`packages/server/src/mods/{model,subagent}/`, `index.ts` + `mod.json`). Core registers neither. Everything they produce is byte for byte what core produced at HEAD (the pin was recorded at HEAD and passes unchanged), apart from the two listed row differences. At the end of my work, with the other groups' moves in the tree, my tests and the pins I touch are green (numbers at the end). I did not run the whole suite or the build (rule 3).

## What moved

| Old | New |
|---|---|
| `core/src/nodes/{model,subagent}.ts` and `*.view.ts` | deleted. `mods/<kind>/index.ts` calls `api.registerBlock(node)`; the view is JSON under `view` in `mod.json` |
| `nodes/index.ts`: 2 imports, 2 list entries (110, 120), 2 `*Node` exports | removed |
| `views.ts`: 2 imports, 2 entries in `BUILTIN_VIEWS` | removed |
| `declare module '../model.js' { NodeKinds }` | `declare module '@reins/core'` in each mod's `index.ts` |
| `app/src/rows/subagent_started.tsx`, `subagent_result.tsx` | deleted; two `view.rows` templates in the `subagent` manifest |
| `RunEvents.model_switched`, `CORE_EVENTS.model_switched` | removed; the model mod lists it in `provides.events` and merges it into `RunEvents` |

Manifests (`order` = the number the kind has in core's registry today; the view keeps its own order):

| mod | `order` | `provides` | view order | notes |
|---|---|---|---|---|
| `model` | 110 | kinds `model`; attrs `model`, `reasoning`, `usd`; events `model_switched` | 100 | `slice: opens`, `status.model_switched` and `hidden` (the view data Task 2 made) |
| `subagent` | 120 | kinds `subagent`; attrs `model`, `reasoning`, `usd`, `mode` | 110 | `slice: own`, `cards`, `rows` for the two core events |

Both: `"pack": "default"`, not `required`. Exec, validate, compile, heading, `print` are copied unchanged. Receipt numbers, USD slices and pauses are pinned (below) and identical.

### `api.core` additions: none
`subagent` uses `checkMode` (already there). `model` uses nothing from `api.core`: its exec only touches the `ExecCtx` (`switchModel`, `setReasoning`, `slice`, `log`, `pause`, `stop`) that the run hands it.

## Changes outside my two folders (read these)

1. **`core/src/viewShape.ts` (shared, small edits).** (a) `model_switched: 1` removed from `CORE_EVENTS`. (b) New `EVENT_ROW_KIND` (`subagent_started`, `subagent_result` -> `'subagent'`) and `export const mayRow(type, kind)`: a view may carry a row for any non-core event, or for a core event only when `kind` is the kind core names for it. The row check now says `if (mod && !mayRow(type, v.kind))` (the core-event refusal) and `if (mod && !isCoreEvent(type) && !mod.events.includes(type))` (the `provides.events` check is skipped for an owned core event). Why: the plan says the two rows become manifest templates, but the shape check refused a mod's row for any core event and the app ignored them, so the templates would have been dead. Safe because the registry refuses a second `subagent` (as it does `end`), a Customize copy keeps the kind name, and every other core event stays closed. Tested, with mutations.
2. **`core/src/run.ts`**: the line `model_switched: unknown;` removed from `RunEvents` (the mod merges it back).
3. **`app/src/rows.tsx`**: the one check `!isCoreEvent(type)` is now `mayRow(type, v.kind)`.
4. **`app/src/template.ts` (the M2 17a filler): two small additions, needed because the old row files branch.** A hole alternative may now be a quoted word `'text'` (always has text) or `path?'text'` (the text when the data has a finite number or `true` at `path`). So `{resumed?'resumed'|'started'}` and `{label|model|'the session model'}` are one hole each, and `{cost?' ('}{cost:usd}{unknown?' + ?'}{cost?')'}` gives `($0.0641 + ?)`. Old templates parse and fill as before (the 18 old template tests pass untouched). A quoted word holds none of `{ } | : '`; anything else malformed is shown as the template is. The plan said the existing filler was enough; it is not (see "Plan errors").
5. Three shared test files got line edits (`nodes-registry`, `no-kind-branch`, `kinds-route`): see "Existing tests edited".

## Rows: how they look now

Pinned first at HEAD (`m3-task-Z-rows.expected.json`, recorded from a `git archive` of HEAD in a scratch folder because the live tree was mid-move; the folder and its junctions are removed). 13 `subagent_started` cases and 13 `subagent_result` cases (labels, models, resumed, markdown, HTML, a 5000-character text, bad types, null data). The same data draws the same markup, except these differences, all deliberate and written out in a test:
- A result with no text (or empty text) draws a plain row; the row file drew a collapsible with an empty body. This is the filler's contract ("a details template that fills empty draws a plain row").
- Hidden characters and line breaks in the title, label or text are shown as `<U+202E>` / `\n` (every filled value passes `showText`); the row file printed them raw. Better, but a change.
- An empty `label` with a `model` now shows the model (the row file showed nothing after "on").
- Data that does not occur: `cost: Infinity` (JSON cannot carry it) draws no parentheses; `unknown: true` with no cost draws the mark alone (core always logs `cost` with it).

## Tests

New (all green):
- `server/test/m3-task-Z-pin.test.ts` + `.expected.json`: through the real loader, 3 workflows (parse, printed file, diagnostics, validate, program), 9 runs with a fake engine and fixed clock: model switched, no `switchModel` (unsupported), kept (reasoning not set), host says stop, host closes the question (pause), subagent result, subagent over its own USD (budget_warning), subagent past the workflow limit (`usd-budget-used` pause `0.2/0.3`), subagent that cannot open a session (pause, "Resume tries again"). Events, receipt, calls to the host, opens, snapshot counter, the printed `model_switched` line, node attrs, the registry order of the neighbours, the served view order and the two served views. Recorded at HEAD; passes unchanged. The one intended difference (the new `rows`) is compared on its own.
- `server/test/m3-task-Z-moves.test.ts` (5): the events (`model_switched` is the mod's, the other two stay core's); `mayRow` table, including `constructor`, `toString`, `__proto__`; the shape check for a subagent view versus any other kind; a user mod's block cannot draw `subagent_started` and the pack's still does; a Customize copy of `subagent` and of `model` after the restart serves its rows and hides `model_switched`.
- `app/test/m3-task-Z-rows.test.ts` + `.expected.json` (3): the rows pin, its non-empty check, and the deliberate differences.
- `app/test/template.test.ts`: 4 tests for quoted words (fallback, `path?'word'` with a table of falsy and hostile values, `__proto__`, spaces and `?` in a word, `showText`, malformed forms).
- Generic, already there, now cover the two folders: `pack-mods.test.ts` (flat build, Customize from the built folder, switched off -> `Unknown step kind`, order, trust, no problems).

### Red at HEAD
Scratch export of HEAD with my test files copied in: `m3-task-Z-pin` green at HEAD apart from the `rows` line (HEAD has no rows: that assertion is red, by design); `m3-task-Z-moves` 5 of 5 red; `m3-task-Z-rows` first and third test red (the empty-body difference and the new cases; the "not empty" test is green); `template.test.ts` 4 new tests red, the 18 old green.

### Mutation round (rule 4)
Each: replace one string, run the named tests, write the original back, compare SHA-256 (`restored=True` every time; my first `MOD1` run restored wrongly because the new text also occurs elsewhere; I fixed the file by hand, then the script was changed to write back the original bytes, and MOD1 was run again, restored). No git command.

| # | break | first red |
|---|---|---|
| MOD1 | a kept model still sets reasoning | pin |
| MOD2 | model opens no USD slice | pin |
| MOD3 | `how: 'unsupported'` renamed | pin |
| MOD4 | manifest `hidden` emptied | pin (served view) |
| MOD5 | printed "cannot switch models" line changed | pin |
| MOD6 | model manifest `order` 110 -> 75 | pin |
| SUB1 | subagent exec always says `next` | NOT red in the server pin (the run pauses anyway, so it is an equivalent mutant there); red in core `subagent-node` ("false: stay") |
| SUB2 | no `checkMode` | pin |
| SUB3 | no "has no prompt" warning | pin |
| SUB4 | `sendsTurn` removed | pin |
| SUB5 | manifest `order` 120 -> 20 | survived first (the pin only held the view order); I added the registry order, red now |
| SUB6 | started row says `continued` | rows pin |
| SUB7 | result row loses the unknown mark | rows pin (2) |
| SUB8 | result row loses `details` | rows pin (2) |
| H1 | filler: `path?` also true for text | rows pin (the `"NaN"` case) |
| H2 | filler: a quoted word with a path is always empty | rows pin (2) |
| H3 | rows.tsx passes no kind to `mayRow` | rows pin (2); my first H3 was an inverted check and equivalent, replaced |
| H4 | rows.tsx lets every view draw core events | app `m2-fix-25a-a` |
| H5 | `mayRow` ignores the kind | moves (3) |
| H6 | `mayRow` never lets a core event row through | moves (5) |
| H7 | model manifest lists no events | pin (the loader refuses the block) |
| H8 | `model_switched` back in `CORE_EVENTS` | pin (the view is refused) |
| H9 | model mod imports `../loader.js` | `pack-mods` (1) |
| H11 | a folder inside the subagent mod | `pack-mods` (3) |

Per kind: model 6, subagent 8. Shared: H1 to H9 and H11 (10).

## Existing tests edited (with the reason)
- `core/test/nodes-registry.test.ts`: "finds the node files" expected `model.ts`; now `use.ts` (the file that stays in core).
- `core/test/no-kind-branch.test.ts`: `model_switched` removed from `KIND_EVENTS` (the manifest's `provides.events` supplies it), from the `run.ts` allow list and from the `viewShape.ts` allow text. Line edits only; other groups' lines kept.
- `server/test/kinds-route.test.ts`: `toHaveLength(10)` and `toHaveLength(3)` replaced by `BUILTIN_VIEWS.length + pack.length === 13` (each move keeps the sum, so no group has to touch it again) and the "with no mods" list is computed from the pack manifests instead of `['phase','say','end']`.
- `app/test/template.test.ts`: the 4 new tests only.
- No golden, no `*.browser.test.ts`, no config. `m2-fix-25a-a` (server) needed nothing: `RunEvents` and `CORE_EVENTS` stayed equal.

## Plan errors and things to know
1. The plan treats the two row files as plain templates. They are not: they branch on `resumed`, fall back through `label ?? model ?? 'the session model'`, and add a parenthesised cost with the unknown mark. The filler needed the two additions in point 4 above.
2. The plan says `subagent_started` and `subagent_result` "stay readable by name in core", and also that the manifest draws their rows. The shape check and the app both forbade that. `mayRow` is the smallest change that allows exactly these two events for exactly the `subagent` kind.
3. `declare module '@reins/core' { interface RunEvents ... }` does not reach `RunEventType` (`keyof RunEvents`, declared in `run.ts`): the merge compiled in the mod but `ctx.log('model_switched')` and the `print` key were errors. The model mod merges through `declare module '../../../../core/src/run.js'`, the same path gate's mod uses. The Task 3 checklist ("`declare module '@reins/core'`") is wrong for events. A comment in the mod says so.
4. Other groups' state at the time of my runs (not mine, not touched): while X, W and Y were mid-move, `kinds-route`, `m2-fix-25a-a` (server and app), `run-cli-golden`, `m3-task-2-view-events` and `no-kind-branch` were red for their kinds (gates, conditions, the `store` event, the `repeat` mod). They were green again in my last run.
5. Documentation not updated (Task 15): `nodes/README.md` and `mods/README.md` still describe model and subagent as built in.
6. Not run: the whole suite, the build, the browser tests, the live tests. The flat-build rule is checked by `pack-mods` (transpile of the folder), not by a real `tsc` build.

## Last runs (my files and the pins I touch)
- server: `m3-task-Z-pin`, `m3-task-Z-moves`, `pack-mods`, `session-tracks`, `m2-track-sessions`, `m2-track-sessions-fix`, `tracks-loop`, `m3-task-2-session`, `session-usd-room`: 9 files, 159 tests green. `kinds-route` + `m2-fix-25a-a`: 75 green. Earlier in the round also green: `session`, `run-cli`, `run-start-checks`, `store-sessions`, `p-pins`, `models`, `claude-mod`, `m3-task-2-mod-events`, `m3-task-2-moves`, `run-cli-unpriced` (before the other groups' last edits to the shared files).
- core: model-node, model-run, subagent-node, subagent-run, nodes-registry, m1-boundaries, m1-behaviour, m2-pins, m2-sessions: 187 green; `no-kind-branch` 9 green; also green earlier: m2-sessions-fix, m2-tracks, m2-tracks-money, receipt-models, receipt-unpriced, receipt-tracks, p29d-unknown, m3-task-2-receipt.
- app: `m3-task-Z-rows`, `template`, `registry`, `views`, `subagentRows`: 65 green; earlier also `md`, `unknownKind`, `stepStatus`, `runState`, `tracksView`, `canvasKinds`, `viewData`.
- root `tsc --noEmit` and `tsc -p packages/app`: no error that names my files (the other groups' errors were open at the time of the runs); eslint clean on every file I touched.

## `git status --short` (my files)

```
 M packages/app/src/rows.tsx
 D packages/app/src/rows/subagent_result.tsx
 D packages/app/src/rows/subagent_started.tsx
 M packages/app/src/template.ts
 M packages/app/test/template.test.ts
 M packages/core/src/nodes/index.ts          (shared: my 2 imports, 2 list entries, 2 exports)
 D packages/core/src/nodes/model.ts
 D packages/core/src/nodes/model.view.ts
 D packages/core/src/nodes/subagent.ts
 D packages/core/src/nodes/subagent.view.ts
 M packages/core/src/run.ts                  (shared: one RunEvents line)
 M packages/core/src/viewShape.ts            (shared: see "Changes outside")
 M packages/core/src/views.ts                (shared: my 2 imports and 2 entries)
 M packages/core/test/no-kind-branch.test.ts (shared)
 M packages/core/test/nodes-registry.test.ts (shared)
 M packages/server/test/kinds-route.test.ts  (shared)
?? docs/plan/m3-task-Z-report.md
?? packages/app/test/m3-task-Z-rows.expected.json
?? packages/app/test/m3-task-Z-rows.test.ts
?? packages/server/src/mods/model/
?? packages/server/src/mods/subagent/
?? packages/server/test/m3-task-Z-moves.test.ts
?? packages/server/test/m3-task-Z-pin.expected.json
?? packages/server/test/m3-task-Z-pin.test.ts
```

Line endings kept as the files had them (checked by bytes: no mixed endings). New mod files are CRLF like their siblings, new test files LF. No U+2014 in any file I wrote.
