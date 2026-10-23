# M2 Task 25b: live checks of tracks

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD cc731e3. Nothing committed, added, stashed, reset, checked out or pushed.

## Result in one paragraph

All four rows are built, each with a dry version (scripted fake provider; five tests, green, 42 s together) and a real version. **Only row 2 ran for real.** The key file `$LOCALAPPDATA/Temp/live/keys.env` does not exist on this machine (the folder holds the old logs and `run-live.sh` only) and no `REINS_LIVE_*` variable or `ANTHROPIC_API_KEY` is set. I did not look for keys anywhere else. So rows 1, 3 and 4 (API versions) are **not confirmed against a real provider**. The dry runs found one product bug (fixed with one line, see below).

## What ran

| Row | Dry (fake provider) | Real |
|---|---|---|
| 1 two branches, two engines | PASS (fake + fake: a TURN on one provider, a `subagent` step on a second) | NOT RUN: no API key |
| 2 Stop with a tool approval open | PASS | PASS on the claude CLI (Haiku 5.5), see below |
| 3 USD limit, one re-share | PASS | NOT RUN: no API key |
| 4a restore mid-split after a hard server kill | PASS | NOT RUN: no API key. A CLI variant (`REINS_M2_ROW4=cli`) is built but its run was refused by the permission layer, so it did not run |
| 4b restore after the mod's version changed | PASS | NOT RUN: no API key |

Real row 2 (from `docs/plan/m2-real-checks.md`): session on `claude-code` (Haiku 5.5), the split mod started two tracks, each asked to run a web request through the shell tool; both approval cards were open; Stop sent. Result: `toolCardsOpenAtStop=2`, `stopToEndMs=1640`, run ended `run_stopped`, no question left open, 4 claude-related processes during the run and **none left** (process list by pid, before and after, polled up to 15 s, descendants of the test process included), key sweep 0 hits. Cost: no turn had ended, so the receipt has no CLI dollars; the three earlier attempts (below) cost $0.0103, $0.0104, $0.0104 by their receipts. About $0.04 for the whole task. Far under the $1.50 cap.

## What each row proves (dry) and what it would prove (real)

- **Row 1.** The test mod `split` is written into the temp home at run time (`mod.json`, `index.js`) and trusted with the hash the trust file holds; it loads through the real loader (the harness throws if a user mod has problems). Its op starts two tracks and joins. Asserted: `track_started` x2, `track_ended` x2, `split_started`/`split_done` once, A's reply `ALPHA` and never `BRAVO`, B's subagent reply `BRAVO` and never `ALPHA`, `receipt.tracks` has two rows, both ended, their dollars add to `totalCostUsd`, the Budget's own count of the conversation files agrees, no process left. **Note for the plan:** in M2 a track's own session always opens on the session's engine (`ensureTrackSession` passes no model). A second engine per branch is only possible with a `subagent` step carrying `provider:model`, which is what row 1 does (real mode: `claude-code:claude-haiku-5-5`). The brief said "each run one TURN"; one branch is a TURN, the other a SUBAGENT turn. A per-track engine is an M3 matter (fork).
- **Row 2.** Both branch cards open, Stop, end within 5 s (dry) / 30 s (real) bound, cards closed, nothing left. The real run is above.
- **Row 3.** Workflow `usd: 0.03`, the split says `share: yes`, so each branch has $0.015. Branch A (fast spender) is cut at its slice; B is slow to answer so it still holds its share; the run raises exactly **one** USD question and one `budget_reached` row, tagged `track: a`; `allow 0.02` is answered only after a second branch had time to be cut; A goes on and the run finishes; total $0.0301 against cap $0.03 + $0.02 allowance. Also asserted: never two USD cards open at once, one card per pause row, total <= limit + allowance + 2 x the biggest call.
- **Row 4.** The server is a **separate process**: `node packages/server/dist/cli.js serve --port 0` on a temp home (`REINS_HOME`), killed with `taskkill /F /T` (a hard kill, no close) while both branches had a tool card open. A second process on the same home: recovery logs `run_detached`, the cards are closed, `POST /resume` restores. Asserted: `a1/a1` and `b1/b1` (finished before the kill) have exactly one `turn_ended`; `a1/a2` and `b1/b2` (in flight) exactly one after the resume; exactly 2 `track_started` and 2 `track_ended` over the whole log; dry: 4 provider requests after the resume (the two in-flight steps again and their answers, none for the finished steps); money: receipt total = sum of every turn's cost = the Budget's own count of the conversation files = sum of the track rows (dry $0.0101 each), so nothing was billed twice and nothing lost. **4b:** `mod.json` version changed 1.0.0 -> 1.0.1 (trust rewritten) between kill and restore: resume pauses with "This run was saved with other blocks (split); Stop it, or Resume to run it with the blocks you have now.", no turn runs, no provider request is sent, then Stop ends it.

## Task 25a's kind versions in production wiring

Confirmed by reading and by 4b through the built binary: `server.ts:240` builds `deps = { kinds: () => kindVersions(mods), ... }`; `session.ts:783` passes `deps.kinds()` into every run start and resume; `cli.ts:203` passes `kinds: kindVersions(mods)` to `startRunCli` (`reins run`). `reins serve` (`cli.ts` -> `serve.ts` -> `startServer`) reaches the same `server.ts` deps. Row 4b ran through `dist/cli.js serve`, so the claim is about the shipped path, not a test double. Not tested: `reins run --resume` with a changed version (read only).

## Bugs found

1. **PRODUCT BUG, fixed (one line): `packages/core/src/run.ts:1885`.** `if (this.alive(t) && t.pc === from) this.pauseForStop(... "did not move on" ...)`. The comment above it says `alive` is false for a parked track, but `alive` (`run.ts:812`) is `status === 'running' && (main || state === 'running')`, no parking test. So a block **mod** op that calls `vm.tracks.start` and returns (the parking pattern the toy `split` uses) was paused at once with "The block "split" did not move on; Resume tries again", the tracks started and then the run asked the user. Repro: row 1 dry before the fix. No test caught it because the core fixture `split` is registered without the loader's `mod` mark and so skips the mod path. Fix: `&& !this.parked(t)`. **Loud:** this is a change to product code, made because it is one line and obvious. Test: new `packages/core/test/m2-mod-park.test.ts` (registers the toy split with a `mod` mark): red without the line (`run_paused` present), green with it. The built `packages/core/dist` was out of date for the child server process, so I rebuilt core's dist only (`tsc -p packages/core/tsconfig.build.json`, exit 0; dist is git-ignored).
2. **Not a bug, but the plan's premise was wrong (tests changed, not the product):** the claude CLI engine runs `--permission-mode acceptEdits` (`engine.ts:107`), so a branch's `Write` of a file and a read-only `Write-Output` through PowerShell run with **no approval card** (first three real attempts of row 2: both branches finished, `run_finished`). The "shell or file tool needing approval" of the brief only opens a card on the CLI for something not covered, such as a web request. Rows 2 and 4 use `Invoke-WebRequest` on the CLI (nothing is sent, the card is never answered in row 2). The loop engine (API) does ask for shell commands (dry).
3. **Minor, existing:** `receipt.totalCostUsd` is rounded to 4 decimals (`receipt.ts:179`) while a track's dollars are rounded to 6, so the total can differ from the sum of the tracks by up to $0.00005 (seen: 0.0016 vs 0.00165). Not a double count. The checks use a tolerance of 5.1e-5 for exactly this reason; I did not weaken any other figure.

## Anything unconfirmed

- Rows 1, 3, 4 (and 4b) against a real API: not run (no key). Specifically unconfirmed for real: a Haiku API branch beside a CLI branch (row 1); how the real model's call sizes behave under a $0.03 limit (row 3, where the thresholds are scripted in dry: the real test uses `read` instructions and the same assertions, which may need a second tuning run); the real resume of a cut Anthropic conversation with an unanswered tool call (row 4; the dry fake in strict-pairs mode accepted it).
- CLI variant of row 4a: built (`REINS_M2_ROW4=cli`, kills only the server pid so that orphaned claude processes show up, then cleans them), never run. Whether a hard kill of the server leaves claude processes behind is therefore **unknown**.
- Row 2 real shows the stop path on the CLI; it does not show Stop while a track's approval is open on the API loop engine for real (dry only).
- The dry row 4 takes about 15 to 19 s per test (child server start included) against the dry test timeout of 30 s (`LONG`); on a very busy machine it could flake. Row 4 is skipped when `packages/server/dist/cli.js` does not exist, and it runs the BUILT server: after any src change the dist must be rebuilt first (I rebuilt core's only).
- Time: the dry file runs in the normal suite (about 42 s, five tests), because it sets `REINS_LIVE_DRY=1` itself (via `vi.hoisted`) when `REINS_LIVE` is not `1`. Real mode needs `REINS_LIVE=1` and the key, as in `run-live.sh` (I could not use that script: no keys file).

## Files

```
 M packages/core/src/run.ts                         (the one line, CRLF kept)
 M packages/server/test/live/live-harness.ts        (+4 lines: WorldOptions.prepare, called before the mods load; the only append, needed to write the test mod before startMods)
?? packages/core/test/m2-mod-park.test.ts           (new, 1 test)
?? packages/server/test/live/live-m2-tracks.real.test.ts   (new, 5 tests)
```
`docs/` is ignored, so `docs/plan/m2-real-checks.md` (real evidence + status) and this report do not show in git status. Dry evidence goes to `docs/plan/p-real-checks-dry.md` (ignored). CRLF counted with node: run.ts 1991/1991, live-harness.ts 532/532, `live-m2-tracks.real.test.ts` 621/621, `m2-mod-park.test.ts` 31/31; no U+2014 in any of them. No existing test edited.

## Commands and outcomes

- Dry, all five: `vitest run packages/server/test/live/live-m2-tracks.real.test.ts --maxWorkers=1`: 5 passed.
- `m2-mod-park.test.ts`: red without the line (1 failed, `run_paused` present), green with it.
- `packages/core` whole: 66 files, 874 passed. Server `toy-block, toy-block-hostile, m2-fix-c, tracks-loop, session-tracks`: 5 files, 121 passed.
- `tsc --noEmit` exit 0; `eslint` on the four touched files exit 0.
- Real row 2: three runs failed by premise (no card, see bug 2; two of them timed out waiting for a card after 180 s and 60 s), the fourth passed (41 s).
- A background file search for a keys file was started once to see whether a key existed and timed out; it only listed names.

## git status --short

```
 M packages/core/src/run.ts
 M packages/server/test/live/live-harness.ts
?? packages/core/test/m2-mod-park.test.ts
?? packages/server/test/live/live-m2-tracks.real.test.ts
```
