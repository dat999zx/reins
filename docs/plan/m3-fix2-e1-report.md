# M3 fix round 2, group E1 (engine): N1, N3, N4

Files I changed: `packages/core/src/run.ts`, `packages/core/test/pack.ts`, `vitest.config.ts`, `packages/server/src/session.ts` (the shutdown wait only), tests `packages/core/test/m3-fix2-e1-share.test.ts`, `m3-fix2-e1-copy.test.ts`, `packages/server/test/m3-fix2-e1-stop.test.ts`. Three existing tests edited (list at the end). `setup-pack.ts` is unchanged (the env switch is read in `pack.ts`).

How I proved things: red at HEAD and the mutation round ran in a temp copy of the tree (`D:/coding/e1-tree`: `packages/core` and `packages/server` copied, `node_modules` junctions), so the other groups' tests never saw a broken `run.ts`. Saved bytes: `D:/coding/e1-save/*.orig`. After every mutation the file was written back from the bytes read before it, and the sha256 after equals the sha256 before (table below). The worktree `run.ts` and the temp `run.ts` have the same sha256 (`59969805D86D...`).

## N1 (money): a track started by a track with a share is held to that share

The reviewer's two-line fix works for the two scenarios, but it is not the whole class. What it misses, and what I did instead:

1. A track started by a track with a share AND with its own `usd:` was held to the starter's rest at start only; two such tracks in one group could each take all of it. Now every track a track with a share starts gets a share: an equal part of `startRoom(parent)` = the smaller of the room and what the starter's share has left (`startTracks`). One rule, no "has no usd" test. A starter without a share keeps the old rule (only a track that asks for a share, `share: true`, gets one).
2. `held` (what the other live tracks hold, used by a re-share and an Allow on one track): the reviewer's "skip a parked track" would also drop the hold of a parked starter whose children carry no share. I did not skip; a track's hold is its rest less the rest of the tracks it started that have a share (`sharers`), so the money a branch and its playbook hold is counted once. It is exact because a child's spend is counted up into every track above it (`countCost`).
3. A child's re-share (`reshare`) and an Allow (`regrow`) could leave a starter with less rest than the child: its next capped reply would then read as "used its share" and send CARRY_ON for a reply that was fine. New `lift(t)`: every track above `t` that has a share keeps at least what `t` has left. Called from `reshare` and `regrow`, up the whole chain (3-deep tested).
4. `regrow` (workflow Allow) shared the new room among all tracks with a share, a starter and its child both. Now only the tracks that spend (no sharing children) are shared out; the starters are lifted.
5. A process-capped session of the starter (`cap: 'process'`) kept the cap it opened with while its children spent from the same share. `takeTracks` now calls `dropProcess(parent)` when the group ends and the parent has a share, so the next use reopens under `share - spent`.
6. Restore of a snapshot: shares are saved and checked already (`share` field); nothing is derived from "parked", so nothing to change. Tested: the snapshot taken mid-way holds the playbook track's share, and a restored run has the same shares on the branch and the playbook.
7. A branch with no share (no limit in the workflow): no room, no share, nothing changes (`startRoom` returns undefined; the existing no-limit tests stay green).

Red at HEAD (`m3-fix2-e1-share.test.ts`, run against the HEAD `run.ts` in the temp copy): 11 of the then 13 tests red, among them: the reviewer's scenario 1 (`maxUsd` of both playbooks is 2, not 1), a live room of the sibling that grew from 1 to 1.25 when the other spent 0.75, the cut that was silent (scenario 2: no warning, no card), the 3-deep nesting (`maxUsd` 2 at every level), the restore. Green at HEAD on purpose: an own `usd:` held to the share, and the receipt adds up (guards).

Tests (17 in the file now): scenario 1 and 2 of the reviewer, the live-room check while the other spends, 3-deep nesting and the inner track's cap, a re-share that lifts the whole chain, an Allow (the leaf shares and the lifted branches, to the cent), a branch that ended gives its unused part free, a live branch is held once (the third branch ended), an overspent live track adds nothing to the free room, a limit crossed by two tracks at once (one card, both replies kept), a playbook started when the room is less than the branch's rest, the group-end reopen at `share - spent`, the receipt adds up, restore.

`m3-fix-a-engine.test.ts:272-273` is NOT changed: it says `maxUsd <= 2`, which 1 still satisfies. The new tests say the exact figure.

## N3 (Customize copy): `builtin` is routed like `pack`

Verified against the code: the three fence points and the op pause path are all behind `mod.pack`. `ModInfo.builtin` is set by the loader only (`nodeCopy`: `pack || builtin`; `builtin` = `may('block-view', kind)`, i.e. a user mod with the id AND the kind of a bundled one, `validateMod` `copy`), and by `guardNode` for `pack`. A user mod that only names a built-in kind has neither flag and stays fenced (tested: `{}` flags, other mod, still paused/refused).

Changes in `run.ts`:
- op route: `!mod` runs as core's op; `mod.builtin` runs unfenced (`holdStop`); any other mod: `modRun` (fenced) as before.
- NODE `exec`: same three ways.
- the "stay" pause of a NODE and the "did not move on" check only for a non-`builtin` mod.
- `modPause` is reached only through `modVm`, i.e. only for a fenced mod. It was not touched: a copy no longer goes through it, so a copy of `gate` pauses with its own condition, title and track, as the built-in does. A hostile mod's pause keeps being rebuilt (tested: no condition, no title, text cut, a reason not in the list is refused).
- Item 8's special case in `cutMods` (`stopping && mod.builtin` spared) is gone as a special case: `cutMods()` takes no argument now. It is not dead: it became the N4 grace (below).

Proof (both ways, as asked): `vitest.config.ts` has a second core project `core-copy` (same files, same setup, env `REINS_PACK_MARK=copy`); `packages/core/test/pack.ts` then marks every block `{ id, events, builtin: true }` without `pack`, as `nodeCopy` does for a copy. Conditions are marked `pack` for a copy in the loader too (`pack || may('cond-view')`), so they are unchanged.
- At HEAD `run.ts`, `core-copy` was red in 18 places in the reviewer's run; in my temp copy at HEAD (without the `examples` folder, so about 10 of the 30 reds are that artifact: parse/compile/example tests) the behaviour reds were X5, X6, the change-request retry per track (3 tests), the capped-reply group (4 and 5, loop branch, bound 11, S6), the track pauses (2), Q9, P1a, P1b, S9 and the fix-B tests that said "a copy stays fenced".
- Now: `core` 79 files / 1068 tests green, `core-copy` 79 files / 1068 tests green.
- Tests that differed between the two modes before my fix and what I did: the 17 behaviour ones above went green by the routing; `m3-fix-b-guard` "every pack kind is the guarded copy with the mod mark" expects `pack`: it now checks `builtin` and no `pack` in copy mode (not skipped; it asserts the copy mark); `receipt-tracks` "a track still going is not ended" differed for a different reason (below); `m3-fix-b-stop` item 7/8 tests encoded "a copy stays fenced" (below).
- `m3-fix2-e1-copy.test.ts` (8 tests): the pack and a copy keep the pause as raised (condition, title, a 500-character text); another mod's pause is rebuilt and a disallowed reason is refused; a copy that forgets `vm.next()` is not paused for it, another mod is.

A real behaviour change I could not avoid and you should know: the pack's own ops now run through `holdStop` (a `Promise.race` with an end that Stop and close can pull), so they take a few more microtask ticks. `receipt-tracks` "a track still going is not ended" asserted that track `a` ends before track `b`; that order was luck of tick counts (it flipped in both projects, not only in copy mode). I made that test order-independent (see the list). No other test felt it.

## N4: a builtin op that never settles

`cutMods()` now: a non-`builtin` mod is cut at once (as before); a `builtin` op (pack or copy) gets `setTimeout(end, BUILTIN_GRACE_MS).unref()`, `BUILTIN_GRACE_MS = 11 * 60_000` (one constant: a little over the 10 minutes the built-in's command is given in `commands.ts`, so a copy that does what the built-in does is never cut early). Both Stop and close use it. `holdStop` is the only place that registers a builtin op in `aborts`.
Known limit (`ponytail:` comment in `holdStop`): the cut op is left behind, not killed, and a late call of it is not refused (it was not fenced before the cut either).

Server: `session.ts` `endSession` and `shutdown` waited with `await worker`. New `workerEnded()`: waits for the worker, or `WORKER_WAIT_MS = 12 * 60_000` (more than the command's 10 and the op's 11), then goes on to `live.close()` (that ends a turn in flight). The timer is `unref`'d and cleared. One optional dep `workerWaitMs` (tests only) so the test does not need 12 minutes. The stuck work is not killed, only not waited for.

Tests: core `m3-fix2-e1-copy.test.ts` with fake timers: Stop on a builtin op ends `stop()` at once and the step at the grace (not at GRACE minus 1 s); close the same; the pack's own op the same; another mod's op is cut at once; an op that settles before the cut is not cut later. Server `m3-fix2-e1-stop.test.ts`: a session running a block whose op never settles: `shutdown()` and `close()` return after the wait (150 ms in the test), and a non-builtin op is cut at once so close returns fast. Red at HEAD `session.ts`: shutdown and close "did not end in 5000 ms".

## Mutations

Each: hand-applied string change in the temp copy; sha256 (first 12) before / mutated / after; "after" always equals "before" (restored from the saved bytes). Tests run: the e1 file(s) of the item, plus for N3 the `core-copy` files m1-snapshots, m2-pins, m2-pauses, m2-money, m2-tracks-fix, m2-boundaries, m3-fix-b-stop. File `run.ts` before = `59969805D86D`; `session.ts` before = `BF8D5FC8695A`.

| # | Mutation | result |
|---|---|---|
| M1 | no inherited share (`sharing` counts only `s.share`) | killed (10 failed) |
| M1b | child takes the share only if it asks | killed (10 failed) |
| M2 | `held` counts a starter and its child both | survived the first 13 tests; I added "a live branch holds its share once" (third branch ended) -> killed |
| M3 | `lift` is a no-op | killed (2 failed) |
| M4 | `regrow` shares the starters too | killed (1) |
| M5 | no reopen of the starter's process at group end | killed (1) |
| M6 | `startRoom` ignores the starter's share | killed (10) |
| M7 / M7b | no `lift` in `reshare` / in `regrow` | killed (2 / 1) |
| M7c | `lift` only the direct parent | survived; I added the 3-deep re-share test -> killed (1) |
| M7d | `startRoom` ignores the room (only the share) | survived (the cap is `min(room, rest)` anyway); I added the check of the track's `share` value in "room less than the branch's rest" -> killed (1) |
| M7e | `held` without `max(0, ...)` for an overspent track | survived; I added "a live track that spent past its share does not add to the free room" -> killed (1) |
| M8 | a copy's ops fenced again (`mod.builtin` -> `mod.pack` at the op route) | killed (17 failed in `core-copy`) |
| M9 | a copy's NODE exec fenced again | killed (1) |
| M10 | a copy's NODE "stay" pauses again | killed (1) |
| M11 / M11b | every mod unfenced (containment break), op / NODE | killed (3 / 1) |
| M12 | a builtin op is never cut | killed (4) |
| M13 | a builtin op is cut at once (no grace) | killed (4) |
| M14 | grace 5 min instead of 11 | killed (3) |
| M15 | `holdStop` does not register the end | killed (4) |
| M16 | `close()` does not call `cutMods()` | killed (2) |
| M17 | `shutdown` waits for ever again | killed (1) |
| M18 | `/close` waits for ever again | killed (1) |
| M19 | wait limit ignores `workerWaitMs` | killed (2) |

No survivors left. Equivalent-looking: none kept. Not mutated: the `unref()` and the `clearTimeout` of the session timer (they change only whether the process can exit, no test can see it).

## Whole-project runs (worktree, `--maxWorkers=1`)

- `core`: 79 files, 1068 tests, green. `core-copy`: 79 files, 1068 tests, green.
- `server`, the neighbours of what I touched (files matching `m3-`, `m2-`, `session`, `drive`, `run-`; no `live/`, no `*.browser`): 43 files, 636 tests, green (this includes the other groups' in-flight `m3-fix2-e2/e3` files as they were at that moment).
- The whole `server` project did not finish for me: the run died with `ERR_IPC_CHANNEL_CLOSED` after about 8 minutes. Before it died it showed three reds: `smoke.browser.test.ts` (needs a browser), `loop-tools.test.ts` "an interrupt during a long Grep ends the turn within 1 s" (76 s; a Windows process test, nothing in it touches the run's money or ops), and `kinds-route.test.ts` (mine: it checks the project list of `vitest.config.ts`; fixed below). A first run of `live/live-m2-tracks.real.test.ts` also had 2 timeouts of 30 s (restore after the server process was killed). I did not run the browser, loop-tools or live files against HEAD, so whether those are old is unconfirmed.
- `npm run typecheck`: 90 errors, all in `packages/app` and `packages/server/src/mods/*` (`'x' is not assignable to keyof NodeKinds`, the pack kinds merged through `ModEvents`; the app tests). None in a file I touched. I did not run it at HEAD to compare, so whether they are old is unconfirmed (it looks like the stale `dist` that the orchestrator builds).

## Existing tests I edited, and why

1. `packages/core/test/m3-fix-b-stop.test.ts` (group B's item 8 tests said a copy stays fenced; the decision for this round is that it runs like the built-in):
   - header comment;
   - item 7 "a pack block's exec is not fenced ...": now loops the pack AND a copy as unfenced (`done`), and only `{}` (another mod) is refused;
   - item 8 "a copy stays fenced: it may not log an event ..." became "a copy is not fenced, as the built-in is" (run is `done`);
   - item 8 "a copy that never settles does not hold Stop, and close cuts it" became "does not hold `stop()` itself" (still asserts `stop()` returns and status is `stopped`), and releases the op at the end so the run can close; the grace and the close are in `m3-fix2-e1-copy.test.ts`. Not weakened: the old claim (close cuts it at once) is the one the decision reverses; the new claim is tested with fake timers.
2. `packages/core/test/m3-fix-b-guard.test.ts`: header comment (no flag unfences an op -> `builtin` does); the mark assertion is conditional on `REINS_PACK_MARK=copy` (copy mode asserts `builtin` true and `pack` undefined; pack mode unchanged).
3. `packages/core/test/receipt-tracks.test.ts` "a track still going is not ended": cut at the second `track_ended` of a/b, whichever track it is, and expect the first one ended and the other not, and that the two ends are different tracks. Why: the old test needed `a` to end before `b`, which depends on microtask counts (the pack's ops take a few more ticks now). Same claim (a running track is not ended, an ended one is), less luck.

4. `packages/server/test/kinds-route.test.ts` "vitest.config.ts: the app project has the kinds setup ...": it lists the projects of `vitest.config.ts`; the second core project makes the list `['core', 'core-copy', 'server', 'app']` with the pack setup file for both core ones. Same claim (only core has the pack setup, the server none, the app its own), one more entry.

Not edited: `m3-fix-a-engine.test.ts` (see N1).

## Unconfirmed / for the orchestrator

- PACK.md line 36 already tells the copy runs like the built-in; it could add one sentence: an op of a copy that never settles is left 11 minutes after Stop (then cut) and the session stops waiting after 12. Not my file.
- `drive.ts` (N4 named `drive.ts:87` and `:113`) was not changed by me; the cut is in the run, so `step()` ends and `close()` follows.
- A starter with a share and a group of children where one child asks `share: true` and another does not: now both get an equal part (the old split counted only the askers). No existing test depended on it.
- Every default `vitest run` now runs the core tests twice (about 50 s more). `--project core` alone is unchanged.

## `git status --short` (my files)

```
 M packages/core/src/run.ts
 M packages/core/test/m3-fix-b-guard.test.ts
 M packages/core/test/m3-fix-b-stop.test.ts
 M packages/core/test/pack.ts
 M packages/core/test/receipt-tracks.test.ts
 M packages/server/src/session.ts
 M packages/server/test/kinds-route.test.ts
 M vitest.config.ts
?? packages/core/test/m3-fix2-e1-copy.test.ts
?? packages/core/test/m3-fix2-e1-share.test.ts
?? packages/server/test/m3-fix2-e1-stop.test.ts
```

(`session.ts` also carries E2's edits; `git status` shows other groups' files too, not listed here.)
