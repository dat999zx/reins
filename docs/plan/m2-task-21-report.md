# M2 Task 21: run view per track and receipt rows

## What I built

- `packages/app/src/stepStatus.ts`: one cursor per track (`data.track`, none = the main line). The shared state holds who owns an active step, the step that started each live group, and the model labels. `step_started` and `turn_started` now close only the steps their own track started. `track_started` and `track_ended` count a group's live tracks, and a step that started tracks is never closed while any track of its group is live. A track's end closes its own steps. A track's `run_resumed` moves only its own steps, and a gate open on any track stays waiting. New export `trackTitle`: at most 40 characters, then `…`, then hidden characters written out with `showText`. The cut comes first, so an escape is never cut in half.
- `packages/app/src/runState.ts`: one `Acc` per track, so `went` and the turn begin/end pairs stay within one track. A track's row folds against that track's own path and leaves the main line's `current` and `endedAt` alone. The slice meter, `sub` and `slice` opening follow the main line only. `RunView.tracks` is new: `{ key, title, paused, ended }`. The pause comes from a tagged `run_paused` and is cleared by a tagged `run_resumed`. The dock line is `Running N at once: A, B (paused), C and N more` while more than one track is live. With 0 or 1 live tracks it is the old line.
- `packages/core/src/receipt.ts`: `tracks?: [{ key, title, usd, turns, ended, unknown? }]`. A row is built from the events tagged with its track (`turn_ended`, `engine_cost`), so its subagents' turns and dollars are in it and also stay in `subagents`. The totals still come only from `engine_cost`. Rows live in a `Map` (a key such as `__proto__` is safe). The field is `usd`, like `models` and `subagents`; the brief said "cost".
- `packages/app/src/rows/receipt.tsx`: a `tracks` line, `Title $0.3000 (2 turns[, not ended]) · ...`, with the same title helper.
- The dock line is not a separate component. It is `PHASE.running.words` in `runState.ts`, so no other file changed.

## Tests (new files only, no existing test edited)

- `packages/core/test/receipt-tracks.test.ts` (6 tests) and `packages/app/test/tracksView.test.ts` (24 tests). Fixtures are the real events of the toy `split` run on the fake engine, recorded in the tests. A few rows are typed by hand: a track's `run_paused` and `run_resumed`, extra `track_started` rows for the "and N more" case, the gate and resume cases, and an unknown-cost case. An interleaving test reorders real rows (the real run never has track a's second step start while track b's turn is open).
- Red at HEAD: 4 of 5 core tests, and 17 of 21 app tests (the first version of the file). Green at HEAD on purpose: the "no tracks" pins and the shape check of the recorded run. Later additions were checked by mutation.
- Existing pins run and green: app `stepStatus`, `runState`, `receipt`, `feed`, `feedThinking`, `subagentRows`, `p29d-unknown`; core `receipt-models`, `receipt-unpriced`, `drift-receipt`.
- `tsc --noEmit` on app and core shows no error in my files.

## Mutations (hand-applied, restored by bytes, hash compared: all equal)

| Break | Red test |
|---|---|
| `mine()` always true | "a track's steps end with the track", "interleaved" |
| one cursor for all tracks | the gate, verify, interleaved, end-with-track tests |
| `track_ended` leaves its steps active | "a track's steps end with the track" |
| group released at the first end | "whatever the main line logs while a group is live" |
| group never live | same test |
| `step_started` ignores `held` | same test (the first version SURVIVED, so I added the test) |
| `finish` ignores `held` | same test |
| `run_resumed` moves all steps | "a track's own resume" (SURVIVED at first; added the test) |
| no title cap | hostile title, receipt title |
| title not made visible | hostile title, receipt title |
| one live track says "at once" | "one track alone" |
| a track's `turn_ended` touches the slice | slice meter test |
| track `subagent_result` clears `sub` | subagent/model test (added after the first round found it untested) |
| track `step_started` closes the slice | same test |
| no "(paused)" | paused test |
| four titles instead of three | "at most 3 titles" |
| one `Acc` for all tracks | went, paused, slice tests |
| main path not restored after a track row | "one track alone" |
| a pause on the main line marks a track | paused test |
| resume does not unpause | paused test |
| receipt rows without turns, without cost | core tests and receipt-row tests |
| receipt row never ended | "still going" and receipt-row tests (the first try was a syntax break; redone as `ended = false`) |
| `unknown` from a track turn dropped | new unknown-cost test (SURVIVED at first) |
| no ", not ended" word | "says which track has not ended" |

## Notes and open points

- `held` is redundant for the real engine order: ownership already protects the step that started the tracks, because the main line is parked. It is the stated rule and it is tested with out-of-order main rows, so I kept it.
- Core `receipt()` still sets `status: 'paused'` for a track's own `run_paused` (it did already). That matters only for a receipt cut while one track is paused and the run goes on. I did not change it: outside the brief.
- A track's subagent does not show on the dock line (`v.sub` is the main line's).
- The plan says "cost" for the row field; I named it `usd` to match `models` and `subagents`. Easy to rename.
- Both new test files import `../../core/src/*` and `../../core/test/*` by relative path (as `toy-kind.test.ts` does). The recorder is copied into both new tests, so no shared helper file was added.
- The tree has many files changed by other people (Task 17a and others). Not mine, not touched. `packages/app/test/zz-tmp.test.ts` showed in a search earlier but is not in git status now.
- Line endings: all four source files and both new tests are CRLF throughout (checked by counting `\r\n` against `\n`), with no BOM and no U+2014.

## git status (my files)

```
 M packages/app/src/rows/receipt.tsx
 M packages/app/src/runState.ts
 M packages/app/src/stepStatus.ts
 M packages/core/src/receipt.ts
?? packages/app/test/tracksView.test.ts
?? packages/core/test/receipt-tracks.test.ts
?? docs/plan/m2-task-21-report.md
```
