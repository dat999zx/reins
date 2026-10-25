# M3 fix round, group A (engine): review items 1 and 2

Tree: D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD ee8b080 plus the working changes of groups A to D. Nothing committed, added, stashed, reset, checked out or cleaned. No build was run (`npm run typecheck` passes).

## What I changed

| File | Change |
|---|---|
| `packages/server/src/mods/playbook/index.ts` | `ownKey(step)` = `<step>#own`. The own playbook's track starts under it. The result handed back names the playbook's step (`i.step`), not the track key. `validate.program` refuses a step whose id is the playbook's track key. |
| `packages/core/src/run.ts` (only `sliceCap`) | `sliceCap` no longer needs `t.ownSlice && t.openSlice`: every track without a share is capped at `usdRoom(t)` (the smaller of the open slice's room and the workflow's), like a main-line subagent. `ensureTrackSession` already passed `usdRoom: () => this.trackRoom(t)` whenever a cap exists, so the live room comes with it. |
| `packages/server/src/mods/fork/index.ts` | Not changed (the branch key stays the id of its first block; the collision is removed on the playbook side). |
| `packages/core/test/m3-fix-a-engine.test.ts` | New. 19 tests: items 1 and 2. |

## Item 1: a fork branch whose first block is an own playbook

Root cause confirmed in the code: the branch track is keyed by the id of its first instruction (`fork/index.ts:54`), and the own playbook started its track under its own step id (`playbook/index.ts:166`), so with the playbook first in a branch both were `pb`.

Fix chosen: the root-cause one, the playbook's track key is `<step>#own`. Where the key is shown (I checked all of them):
- `track_started` / `track_ended` data and the `track` field of every row the track logs: now `pb#own`.
- `reins run` line: `track playbook-1#own started (Playbook review-pass)` (test in `m3-task-p-playbook.test.ts` edited, see below).
- The USD pause for the playbook's own slice: `block playbook-1#own used its $1 budget` (the slice's step is the key). `onTrack` is the key too.
- The session id and the card title of the track: the title is still `Playbook review-pass`; the session step is the key.
- The text handed back to the next block says `(step <playbook step>)`. It said `(step <track key>)`; I changed it to `i.step` so the model is not shown `#own`. Outputs (`<step>/<name>`) did not use the key and are unchanged.
- The app: `track_started` rows use the key only to find the same track again (`runState.ts trackOf`) and as a DOM id (`FeedView.tsx` replaces every non-word character with `_`, as it already does for `a/b`). The title shown is the event title. Nothing in the app compares the key with a step id.
- Snapshots: `tracks[].key`, `parent` unchanged (`pb`), `usdSpent` key for the slice: `pb#own`. Restore reads keys as plain strings.

The one way left to meet that key is a step that is literally named `<playbook step>#own`. `validate.program` now refuses it in plain words: "playbook `pb` runs as the track `pb#own`, and a step has that id; give the step another id". For a playbook inside an outer playbook's file, the file's own check (`early`, `checkBlock`) finds it with the line number, and the program check is skipped once an error exists (a first version looped over the inner playbooks in the program check; it could never fire, so I took it out).

### Red at HEAD

New tests, run at HEAD (before any fix):
- the review reproduction: `expected 'running' to be 'done'`; the branch is paused alone, as the review says. (`validate` returned `[]`.)
- same playbook in the first branch, own playbook first in one branch and second in another, nested: all `expected 'running' to be 'done'`.
- two own playbooks in two branches, Stop, snapshot/restore: test timeouts (30 s) because the session `pb#own` never opens; at HEAD the track is `pb` and it never gets to open.
- the name clash tests: `expected [] to deeply equal [ Array(1) ]` (no refusal).
- item 2 tests, at HEAD with the old key (a throwaway copy of the file with `#own` taken out, deleted afterwards): 6 failed of 8, e.g. `expected undefined to be 4`, `expected undefined to be 0.5`, `expected undefined to be 2.5`. The two that passed are the controls (no limit at all: no cap; a `usd:` line: as before).

### Tests added for item 1 (all in `m3-fix-a-engine.test.ts`)
1. review reproduction: validate clean, run done, tracks `a`, `pb`, `pb#own`, no `run_paused`, one `fork_done`, one `playbook_done`.
2. the same playbook in the first branch.
3. two own playbooks, one first in each branch, both inner tracks live at the same time (held), four tracks.
4. own playbook first in one branch AND second in another.
5. nested: the outer own playbook is first in a branch and its file has an own playbook (`pb#own`, `pb/playbook-1#own`).
6. Stop while the playbook track works: status `stopped`, no `run_paused`, the track's session interrupted or closed.
7. snapshot while the playbook track works, JSON round trip, restore, finish: one `playbook_started`, one `playbook_done`, one `fork_done`.
8. a step named `pb#own` is refused with the words above.
9. the same inside a file (outer file has an own playbook and a step named like its track): refused with the file's line.

### Goldens
- `golden-m2/runs-pb-end.json`: NOT re-recorded. That run is an inline playbook, so no track is started and no key changes. The test passes on the old record.
- `m3-task-p-pin`: NOT re-recorded. It records workflows without a playbook; it passes.
- S9 and contract-examples goldens: pass unchanged (no own playbook track in them).
So no golden diff to show. A rename in a golden would have shown only `track: "playbook-1"` becoming `track: "playbook-1#own"`.

## Item 2: a track without a share ran with no cap

Fix at the shared point. `sliceCap` is the only place that decides the cap of a track with no share (`ensureTrackSession`: `shareFor(t) ?? sliceCap(t)`). The review suggested exactly this; I checked it against the code and it is right: `usdRoom(t)` already counts the workflow's room even when the track has no slice, so dropping the `ownSlice && openSlice` test is enough. The live room (`usdRoom: () => this.trackRoom(t)`) is added by the same line whenever a cap exists.

Kinds of track I checked:
| Track | Result |
|---|---|
| main-line subagent (`run.ts` ~1040) | already capped at the smaller of slice room, workflow room and its track's share. Unchanged. |
| split / fork branch with a share (`shareFor`) | capped at share less spend or the room if smaller, with the live room. Unchanged (test: `a` and `b` open at `maxUsd 1` of 2). |
| split branch with NO share (toy `split`, any `vm.tracks.start` with no `share` and no `usd`) | was uncapped; now capped at the room with a live room. Test + `m2-money` edit. |
| own playbook with `usd:` | own slice, held to the workflow room, as before (and to the starter's share rest at start). Test with `usd: 1` and `usd: 10` (cap 4). |
| own playbook without `usd:`, main line | was uncapped (the review repro); now `maxUsd 4` and a live room that reads 4 less everything spent. |
| ... with an open `model` slice | the track inherits the slice: cap = the smaller (0.5 with slice 0.5; 4 with slice 9). |
| ... spent before it starts | cap = room left (2.5 after 1.5 spent); rounded up to a millionth (0.666667); 0 when the room is gone, never negative. |
| own playbook in an own playbook, both without `usd:` | both capped. |
| own playbook without `usd:` inside a fork branch (branch has a share) | capped (defined, at most the workflow room). See "not fixed" below. |
| subagent inside a track | same code as the main line: slice room, workflow room, its track's own share. Unchanged. |
| no limit anywhere | still no cap and no room (nothing to hold). Test. |
| a limit crossed by two tracks at once | two split tracks each get `maxUsd 1` and the same live room; both turns (0.7 each) are held and released together; the run pauses once on the USD card (`budget_reached` once), the room reads <= 0. |

Not fixed, found: a track with no share that is started by a track that HAS a share (a fork branch with share 1.00 that runs an own playbook without `usd:`) is capped by the workflow room, not by the branch's share left. Before my change it had no cap at all, so this is better, but the playbook can still spend more than its branch's share. The fix is not a cap line: when the engine stops at the branch's share, `guardUsd` has to choose between a re-share of the branch and the card, and that is a design choice (spec 4.6). The spend is counted up into the branch (`run.ts` 1258) and the between-steps check sees it. I did not change it. Same gap for a shared track started inside a shared track (`startTracks` splits `usdRoom(parent)`, not the parent's share); the shipped blocks cannot do that (a fork may not be inside a branch), only a code mod can.

### Existing tests edited, and why
- `packages/core/test/m2-money.test.ts` ("a plain split is capped by nothing"): it assumed no cap with `usd: 1`. It now expects `maxUsd 1` and `usdRoom() === 1` on both branch sessions. That is the new rule.
- `packages/server/test/m2-track-sessions.test.ts` line 71: `track.usdRoom` was expected undefined ("no room to be debited for the compaction") for a plain split under `usd: 5`. It is now a function. The same test still shows the track's turn is raw (`compacts` is 0 for it), so what it was about still holds.
- `packages/core/test/playbook.test.ts`: 21 lines, the key rename only (`playbook-1` to `playbook-1#own` in session ids, `track`, `step`, `onTrack`, `key`, `openSlice.step`; `pb` to `pb#own` in the branch test). No expectation changed otherwise.
- `packages/server/test/m3-task-p-playbook.test.ts`: 2 lines, the `reins run` track lines now say `track playbook-1#own started` / `ended`.

## Mutation round

Hand-applied, each run against: `m3-fix-a-engine`, `playbook`, `m2-money` (core) and `m3-task-p-playbook` (server). sha256 (first 12) of the file before, mutated, after.

| # | File | Break | Killed by (failed count) | Hash |
|---|---|---|---|---|
| P1 | playbook/index.ts | `ownKey` returns the step id | 28 failed | B2685E4433CC / 57DF1CF4B981 / B2685E4433CC |
| P2 | playbook/index.ts | handback names `r.key` again | 2 (review repro, "with no output") | B2685E4433CC / BFF042F3B31C / B2685E4433CC |
| P3 | playbook/index.ts | clash check switched off | 2 (both refusal tests) | B2685E4433CC / 877D8FB8170A / B2685E4433CC |
| P4 | playbook/index.ts | `exec` starts the track on `i.step` | 22 | B2685E4433CC / A788F7075205 / B2685E4433CC |
| P5 | playbook/index.ts | clash check looks for the wrong id | 2 | B2685E4433CC / 22E721B5101A / B2685E4433CC |
| R1 | run.ts | `sliceCap` returns `undefined` | 10 | B3FA840A4A5C / AFE3514683E9 / B3FA840A4A5C |
| R2 | run.ts | `sliceCap` only with `ownSlice && openSlice` (HEAD) | 7 | B3FA840A4A5C / A0155D1D3DAC / B3FA840A4A5C |
| R3 | run.ts | `sliceCap` reads the main line's room (`usdRoom()`) | 3 | B3FA840A4A5C / A3FFEE4D99D7 / B3FA840A4A5C |
| R4 | run.ts | `sliceCap(t) ?? shareFor(t)` (share and slice swapped) | 7 | B3FA840A4A5C / A5E407EE3988 / B3FA840A4A5C |
| R5 | run.ts | session gets `maxUsd` without the live `usdRoom` | 6 | B3FA840A4A5C / 70FB07F27EF4 / B3FA840A4A5C |
| R6 | run.ts | cap not rounded up (`capOf` removed) | first run: 0 failed = SURVIVOR; test added ("rounded up to a millionth"); second run: 1 | C8FAAC1BDEAE / 3A116D042943 / C8FAAC1BDEAE |
| R7 | run.ts | cap not floored at 0 | first run: 0 = SURVIVOR; test added ("a room that is gone gives a cap of 0"); second run: 1 | C8FAAC1BDEAE / BF0889D35EDD / C8FAAC1BDEAE |

(`run.ts` is also edited by group B, so its "before" hash changes between rounds; each row is before = after within the row, except R1's first attempt, below.)

### An incident I caused, and how it was repaired
My first mutation script restored a mutation by replacing the mutated text with the old text everywhere in the file. R1's mutated text was `return undefined;`, which `run.ts` contains 11 other times, so the restore rewrote those 11 returns into `return room === undefined ? undefined : capOf(Math.max(0, room));`. The hash check caught it (R1 "HASH DIFFERS"); I stopped the script, undid the replacement, compared the file with a copy I had saved just before the round (`fc`: only group B's `cutMods` line differed, which is theirs), and re-ran R1 to R7 with a restore that puts the old text back at the exact position it was taken from and checks it first. `run.ts` was wrong for about 10 minutes; any group that ran core tests in that window may have seen odd failures from it. After repair, the 77 core test files all pass (1041 tests). Group B's lines in `run.ts` were left as they are; one of them (`cutMods`, `mod.builtin` vs `mod.pack`) changed under me during the round, so group B should re-read it.

## Runs

- `npm run typecheck`: clean.
- `packages/core/test` (77 files, `--maxWorkers=1`): 1041 passed.
- 41 neighbour files (server and app: m2*, m3*, playbook, fork, contract, golden, session, drive, run-cli, money, track): 633 of 634 pass. The one red is `packages/app/test/m2-fix-25a-a.test.ts` "B1 in the app: setKinds drops an entry of the wrong shape": not mine (the app's kinds are another group's files).
- A single run of the whole `packages/server/test` folder (and of 215 files at once) crashes the vitest runner with `ERR_IPC_CHANNEL_CLOSED` ("Channel closed"); it did so before any failing test and is not about a test. I ran the 41-file neighbour set instead. Unconfirmed: the whole server folder in one go.
- Earlier in the round, with other groups half-way through their edits, these were red and are not mine: `m3-task-Z-pin`, `m3-task-4-pin`, `m3-task-y-pin`, `m3-task-3-pin` (`pack: true` in the records), `m3-task-3-moves`, `m3-task-y-moves`, `registry.test.ts`, `no-kind-branch.test.ts`. They were green again in the last run.

## Unconfirmed
- A real provider run of a fork with an own playbook first in a branch (the live test `live-m3-fork-playbook.real.test.ts` is untracked and was left alone).
- The USD pause card text with `#own` in it ("block playbook-1#own used its $1 budget") was read from the code, not seen in the app.
- `run.ts` has two writers (A and B) in this tree; the final bytes are the union of both.

## git status --short (my files)
```
 M packages/core/src/run.ts                       (sliceCap only; the rest of the diff is group B's)
 M packages/server/src/mods/playbook/index.ts     (ownKey, exec key, handback step, program check)
 M packages/core/test/playbook.test.ts            (key rename, 21 lines)
 M packages/core/test/m2-money.test.ts            (plain split now capped)
 M packages/server/test/m3-task-p-playbook.test.ts (2 lines)
 M packages/server/test/m2-track-sessions.test.ts (1 line)
?? packages/core/test/m3-fix-a-engine.test.ts
?? docs/plan/m3-fix-a-report.md
```
Line endings: `run.ts` and `playbook/index.ts` stay CRLF (2013 and 324 lines, no bare LF); the test files were LF and stay LF. No U+2014 in any file I touched.
