# M3 demo slice, group F report: `fork` (Task 9), canvas chains (Task 12), the fork-only `next` handle (Task 13)

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 058a0f0, groups P and E working in the same tree. Nothing committed, added, stashed, reset, checked out or pushed.
No core source file changed: `fork` needed nothing new in core or in `api.core` (it uses nothing from `api.core`). Whole suites and the build were not run (rule 3); I ran my own tests and the pins my kind touches.

Last runs in the real tree: server 52 new tests green (fork 18, run 27, cli 4, session 3), app 22 new tests green (view 9, canvas +5, arrows +3, arrange +5) plus the 7 existing app files I edited (179 tests in the 8 files, green),
core `no-kind-branch`, `kind-order`, `m2-pins`, `nodes-registry`, `setup-pack` green, server `pack-mods` (261 tests, the generic pack test now covers `fork`: manifest, flat source, flat build, Customize from the built folder) green,
`kinds-route` and the four M3 pin files green (P has put `playbook` in them as well). eslint clean on every file I touched. `tsc -p packages/app` and root `tsc --noEmit` were clean when I last ran them with P and E quiet;
while they were mid-edit they showed errors in `actions.ts` (E) and the `use` removal (P), none in my files. The smoke browser test: see "Smoke" below (read it).

## Task 9: the `fork` block

`packages/server/src/mods/fork/` (`index.ts` + `mod.json`, CRLF like its siblings). Manifest: `order` 135, `"pack": "default"`, not required, `provides`: kind `fork`, op `FORK`, events `fork_started`, `fork_done`, no attrs. `declare module '@reins/core'` merges `NodeKinds`, `ModInstrs.FORK`, `ModEvents`.

- Node: `attrs: []`, `manyNext`. Compile: one `FORK { step, targets }`, a target per `next` link in wire order through `ctx.linkTo`. Op: `next: [at + 1, ...targets]`, `starts: targets` (as the toy `split` does).
- Run: the first time it reaches `FORK` it starts a track per branch (key = the step id at the target, `fork-<n>@<index>` when the target is not a step; title `Branch <title of the first block, else its id>`, cut at 80; `share: true`),
  seeds each with the last reply before the fork quoted as data (naming the step that gave it), logs `fork_started { step, branches, words }` and parks. When every branch ended it hands each result to the main line, quoted, in wire order, and
  **moves the counter (`vm.next()`) BEFORE it logs `fork_done`** (carry item 7), so a snapshot taken inside the done row restores to the block under the fork with the group already taken. A fork with no target (a file the validator refuses) is passed over.
- Quotes: fenced with one backtick more than the longest backtick run (three at least), the last 8,000 characters kept with `[the first N characters were cut]` before the fence, never half of a surrogate pair; a branch with no reply says `<title> finished without a reply.`
  Words of the v3 table for the seed and the result heads.
- `count`: `fork_started` -> `forks`. `print`: `· fork <step>: 2 branches started` ("1 branch" for one), `· fork <step>: every branch finished`.
- Validation (all at the fork step's position): F2 error, F3 warning, F4 error (once per doubled target), prompt/cards warning (early); F9, F10, W1, W2 (program, so only on a file with no error). F5 to F8 are core's R1 to R3 (not changed).
  F10 reaches a model block in any track a branch starts itself (`members(start, true)`; tested with the toy `split` inside a branch). W1 counts a TURN with write policy, a NODE (subagent) without `mode: read-only`, or any instruction that carries a `cmd` (the `run` block's), and says it once about the first two writers.
- F11 is a `validate.program` member of the **`verify` pack mod** (`mods/verify/index.ts`, not `core/src/nodes/verify.ts` as the plan says): a verify in one branch whose `against` runs in another branch gets the warning; a verify on the main line, or against the main line, does not.
- View (JSON in the manifest): `order` 135, colour `loop`, `manyNext`, `line: ["fork", "sub"]`, `sub: "runs {links.length} at once"`, palette card `fork` in Flow, `fresh: {}`, feed rows for both events (`Fork fork-1: 2 branches started.` / `Fork fork-1: every branch finished.`). No fields, no cards.
- The no-kind-branch guard now knows `fork` and `FORK` (`KINDS`/`OPS` in `core/test/no-kind-branch.test.ts`); the fork's own folder is exempt (own kinds and ops), nothing else may branch on it. Plan mutation (a `kind === 'fork'` branch in `app/src/blocks.ts`): guard red, reverted.

### Pinned (tests, in this order)
- `m3-task-f-fork.test.ts` (18): the spec 4.1 example parses, prints back byte for byte, compiles to one FORK with both targets, validates with no error and the one W1 warning; wire order through print and compile; every word of 4.3: F2, F3, F4 (twice, once per target), missing target, prompt/cards, R1, R2, R3 (the backward-link error first, then R3 once the link has a `max`; also `on-fail`), F9, a fork in a loop (clean), F10 (in the branch, deeper in it, in a track the branch starts, none before the fork), F11 (4 cases), W1 (8 cases), W2; the manifest.
- `m3-task-f-run.test.ts` (27): events in order and both branches in flight at once; fresh conversations, seed quoted, the block under the fork gets both results quoted in wire order (finish order does not matter), nothing counted twice; receipt `forks 1` and one `tracks` row per branch; a branch with a gate and a chain; the card titled `Branch <title>`; fences (3, 4, 5 backticks, a hostile reply that holds a fence), cap at 8,000 and exactly 8,000, the surrogate cut, no-reply, title cap, one branch, no branch, a fork in a loop (fresh branches each pass, 2 forks counted),
  Stop (both sessions interrupted and closed, no `fork_done`), a branch that throws (pauses alone, the other ends, the fork waits, Resume finishes it; or Stop), snapshots inside `fork_done` (**restores to the block under the fork and the fork does not run again; the build turn runs once with both results**), `fork_started`, the first `track_ended`, a branch's `turn_ended` (its session resumes), the old backward `next` on a plain block (still runs, goes back by its `max`), money per branch.
- `m3-task-f-cli.test.ts` (4): `reins run` prints the fork lines around the track lines and `forks 1`; "1 branch"; two branch gates ask at once titled with their branch, the fork waits for both; Stop answers every waiting branch.
- `m3-task-f-session.test.ts` (3): through the server session: a branch's tool approval is a card titled `Branch ...`, three sessions (main plus one per branch), fork done once; the subagent-approvals setting `deny` does not apply to a branch; Stop on a branch card closes the other card.
- app `m3-task-f-view.test.ts` (9): view in the served list (after `end`), the only block with the `next` handle, face and chip (`runs 2 at once`, `runs 0 at once` for an unwired fork, a hostile target does not change the chip), palette card, feed rows, `stepStatus` keeps the fork and both branch blocks active until the last branch ends.

### Money per branch (what the code does; it differs from the spec's numbers)
`share: true` splits the room (`workflow room`, or the open slice) equally. Core rounds the share UP to a **millionth of a dollar** (`capOf`), not to a cent as spec 4.6 says: $1.00 over 3 branches gives 0.333334 each (spec: 0.34), a model block's 0.50 over 3 gives 0.166667 (spec: 0.17). Pinned as the code does it; core unchanged (M2 code wins). Two branches of $1.00 get 0.5 each; no budget anywhere gives no cap; each branch's spend lands on its own `tracks` row and once in the total.

## Task 12: canvas chains
- `canvas.ts`: the `next` writer appends for a `manyNext` view and refuses a duplicate target (the same workflow object comes back, so nothing changes); other blocks and `on-fail` still replace. A fork wire gets no `max`.
- `arrange.ts`: `fallsThrough(step)` (a free block runs on into the one under it unless it stops or has a `next` link; **a fork runs on though it has `next` wires**) and `chains(tail, placed)`. `BlocksPane.tsx` draws each chain in one `.sx-chain` (the blocks stay `.sx-free` each, so the smoke counts are unchanged); `app.css` joins the blocks with the stack's notch. A block with a place of its own stands alone.
- `arrows.ts`: `linksToDraw(w, wires, chained?)` draws no `then` arrow between two blocks of one drawn chain (no third argument: as before). `Workspace.tsx` passes the unplaced free blocks.
- Detach: **`detachApart`** (new, used by the menu in `Workspace.tsx`) puts an `end` in front of the detached block when the free block above would run on into it. `detach` itself is unchanged: see "Plan errors", point 4.
- Smoke: no `.sx-free` count went red (counts 1, 1, 0, 1 hold), so that piece was not stopped.

## Task 13: the `next` handle only on the fork
`wiresOf` lists `next` only for a `manyNext` view (`canvasKinds.ts`). Handle title of `next` now says "Starts a branch at the block you drag this to." (it was "Runs next when this block finishes", wrong for the fork). Two CSS rules place `on-fail` and `against` on a two-handle block (a verify has two now).
Old files: a `next:` line on a plain block still parses, validates, draws a gray arrow, can be deleted (tested in app `canvas.test.ts`) and runs (tested in `m3-task-f-run.test.ts`).

### The open canvas item: a backward loop from a plain block can no longer be drawn
Read the old milestone note and the planner brief (`m2-planner-brief.md` line 20): the decision is "keep it, say it in the changelog words". What I did: nothing new in the product, because the plan wants exactly this: `setLink` no longer gets a `next` call from a plain block (no handle), so nothing writes a backward `next` any more; old files that have one load, draw, delete and run (pinned both ways); `repeat until` is the way to go back. A fork wire never points backward, so it never gets a `max`.
For Task 15 (not mine): the changelog sentence is already in the v3 plan ("The gray next handle is now only on the fork. To go back and try again, use repeat until. Files with a next line on any block still load, draw and run.").

## Smoke (steps 8e.5 and 8e.7, APPROVED edits)
8e.5 now adds a fork after `build` (palette card, with `build` selected), draws the wire from the fork's gray handle to `ship` (forward, so `## fork\nnext: ship\n`, no `max`), deletes it from its menu, draws it again, selects the arrow and presses Delete, then removes the fork so the file is back to `textBeforeHat`. 8e.7 pastes the loose copy as before, adds a fork, drags the fork's handle onto the loose copy, checks `## fork\nnext: phase-N`, undoes, and removes both. Nothing else in the file changed except one point: `arrowAt` now reads the point 14 px along the arrow (not the middle): the fork's arrow runs beside the `build` and `plan` arrows and its middle is under their hit area, so the right click chose `plan/0`.
Result: in a scratch copy of the tree (my files plus the shared state of P and E, without the `playbook` folder, app rebuilt) the smoke test passed 3 times out of 3 once it was past step 8d.10.
**8d.10 is flaky and not mine.** `card('phase').dragTo([data-body="if-1/else"])` aims at the middle of the else body, which sits 10 px below the bottom edge of the workspace (body 629.9 to 655.9, workspace bottom 632.5, window 720 px high; I logged this). On a pristine export of HEAD it failed 2 times out of 9; with the fork present it failed in most of my runs (roughly two thirds), so I measured the geometry in both and it is identical (same numbers); removing the fork's palette card did not change that. The difference I can show is only how often; the cause I can show is the geometry. I did not touch that step (not approved). In the real tree itself the test stopped at 8d.10 in 2 of 2 runs, so I have no green full run of the real tree. The orchestrator should run it alone, and expect to repeat it until 8d.10 passes.

## Red at HEAD
A `git archive` of HEAD in a scratch folder (removed after), my new and edited test files copied in:
- server: `m3-task-f-fork` (the file does not run at all, no test of it executes), `-run` 26 of 27 red (the old-file loop test is green by design: behaviour did not change), `-cli` 4 of 4, `-session` 3 of 3.
- app: `m3-task-f-view` 8 of 9 red, `canvas` 2 (the new fork writer), `arrows` 2, `arrange` 5, `blocksFace` 3, `unknownKind` 3 (the handles).

## Mutations (hand breaks, one string each, in a scratch copy of the tree, tests run, original restored and compared; restored=true each time)
61 breaks: 60 in a table plus the guard mutation. Per rule: F2 3, F3 3, F4 3, F9 3, F10 4, F11 4, W1 4, W2 2, prompt 1, compile 2, op 2, carry 7 1, money 1, seed 2, quote 6, result 2, title 1, count 1, print 2, writer 3, handle 2, chain 4, detach 2, then 2, guard 1. (Rules below three are single-point rules, W2 has two.)
All red except:
- `Run-seed-step` (take the first, not the last, output that equals the last reply) SURVIVED at first: the test had one output. Added a test where an earlier step said the same words; red now.
- `Quote-min3` (the fence is four, not three, when no backtick) SURVIVED: `toContain` of a three-fence is also found inside a four-fence. The tests now match the whole line; red now.
- `Quote-pair` (no half-pair cut) SURVIVED: my emoji text cut on a pair boundary. A text that cuts inside a pair now; red.
- `Result-noreply` (`r.text.trim()` instead of `r.text`) SURVIVES: equivalent today, core already trims a reply, so a blank reply arrives as `''` either way. I left the defensive `trim` in.
Examples of what the first red test was: carry 7 (done row before `next()`): "snapshots inside the fork's own rows"; F10 without `nested`: the toy-split case; F11 without the track tests: the main-line case; `share` removed: the money test; fence one too short: the backtick tests; `wiresOf` for all: blocksFace; the writer replacing on a fork: `setLink on a fork`; chains ignoring `placed`/`fork`/`stops`: the chain tests; detach never/always inserting: the two detachApart tests.

## Existing tests edited (and why)
Because a 14th kind exists: `core/test/kind-order.test.ts` and `core/test/m2-pins.test.ts` (kind lists) and `golden-m2/pin-q14-registry.json` (one entry, `FORK` op; P added `playbook` after it); `server/test/kinds-route.test.ts` (`BUILT_IN_ORDER`, the order list, two counts 13 to 14); the served-order list in the four pin files `m3-task-3-pin`, `m3-task-4-pin`, `m3-task-y-pin`, `m3-task-Z-pin` (`.expected.json`, one added line each, nothing re-recorded); `core/test/no-kind-branch.test.ts` (`fork`, `FORK` in the two lists, as the plan says);
app `unknownKind.test.ts` (kind count 13 to 14), `viewData.test.ts` (`HEAD_FRESH` gains `fork: {}`, title 12 to 13), `canvasKinds.test.ts` (the generic "fresh block reads back with no errors" accepts the fork's one error, "has no branches", for a fork that has no wire yet).
Because of Task 13 (approved): `blocksFace.test.ts` (the handles test, the class test, and "the two handles say what they do", which the plan did not list), smoke 8e.5 and 8e.7 as above. **Not on the plan's list, caused by it:** `unknownKind.test.ts` "the unknown block has only `next`" and `wiresOf('say')` with no kinds served: both now `[]`.
No other test, no golden recorded, no `vitest.config.ts`, no lockfile.

## Plan and spec: what they got wrong or left open
1. Spec 4.1's example says `## run npm test`; the printer writes ``## run `npm test` ``. The two parse to the same workflow; "prints back byte for byte" holds only for the backtick form (the test pins both).
2. Spec 4.6's "rounded up to a cent" is a millionth in the code (above).
3. The failed-branch words in the v3 table ("`<title> stopped before it answered (<why>); Resume runs it on`") are not what core says: `Branch A work failed: boom; Resume tries again` (pause type `stop`). Pinned as is. The terminal words of the table (`· <title> started`) are also not core's (`track a started (Branch Alpha)`, pinned by existing tests); I left both.
4. v3 Task 17 asks `detach` to put the `end` in, with no existing test changes; `arrange.test.ts` ("detach moves a stack step behind the end", `withEnd` has a free block with no link above the one it detaches) says the opposite. I kept `detach` and added `detachApart` for the menu. If the orchestrator wants `detach` itself to do it, that one existing test changes its expected list.
5. **F9's "inside an inline playbook" cannot be done by the fork.** The fork's `validate.program` runs for the steps of the outer workflow; the steps of a playbook file are not among them. It must be the playbook's own file check (`checkBlock`/its compile) that refuses a `fork` (or any block that starts tracks) in a playbook file. P's `playbook` mod has nothing about it yet. F10 "model inside an own playbook in a branch" works by `members(start, true)` once the playbook compiles its steps into the program with step ids (not tested here, no playbook block when I wrote it).
6. F10 and W1 have to look at other blocks: F10 names the kind `model` (a one-line `NO_BRANCH` set, written so the no-kind-branch guard does not call it a branch on a kind; it is a coupling, said here), W1 treats an instruction with a `cmd` as a command. A Customize copy of `model` or `run` keeps both rules; a block that runs a command under another field name would not count.
7. The plan's task lists did not see: the registry and order lists in 11 existing test files that a new kind changes (above), `unknownKind`'s `next` asserts, the handle title test in `blocksFace`, the smoke arrow-overlap, and that a fork's `next` wires must not count as "leaves the chain" in the chain rule.
8. A new fork block from the palette has an error mark at once (F2, "has no branches"): per the spec. If the demo should not open with a red block, F2 would have to be a warning; I did not change the spec's word.
9. Docs not updated (Task 15 owns them): `nodes/README.md` (`manyNext`, `starts`, `vm.tracks`, `handBack`, `lastReply`, `validate.program` are all there; no section "Blocks that start tracks"), the mods guide (`ModInstrs`, `ModEvents`), CHANGELOG (the words of the v3 table).

## `git status --short` (my files; P's and E's are not listed)
```
 M packages/app/src/BlocksPane.tsx
 M packages/app/src/Workspace.tsx
 M packages/app/src/app.css
 M packages/app/src/arrange.ts
 M packages/app/src/arrows.ts
 M packages/app/src/canvas.ts
 M packages/app/src/canvasKinds.ts
 M packages/app/test/arrange.test.ts
 M packages/app/test/arrows.test.ts
 M packages/app/test/blocksFace.test.ts
 M packages/app/test/canvas.test.ts
 M packages/app/test/canvasKinds.test.ts
 M packages/app/test/unknownKind.test.ts
 M packages/app/test/viewData.test.ts
 M packages/core/test/golden-m2/pin-q14-registry.json
 M packages/core/test/kind-order.test.ts
 M packages/core/test/m2-pins.test.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/server/src/mods/verify/index.ts
 M packages/server/test/kinds-route.test.ts
 M packages/server/test/m3-task-3-pin.expected.json
 M packages/server/test/m3-task-4-pin.expected.json
 M packages/server/test/m3-task-Z-pin.expected.json
 M packages/server/test/m3-task-y-pin.expected.json
 M packages/server/test/smoke.browser.test.ts
?? docs/plan/m3-task-F-report.md
?? packages/app/test/m3-task-f-view.test.ts
?? packages/server/src/mods/fork/
?? packages/server/test/m3-task-f-cli.test.ts
?? packages/server/test/m3-task-f-fork.test.ts
?? packages/server/test/m3-task-f-run.test.ts
?? packages/server/test/m3-task-f-session.test.ts
```
Files P or E also edit (shared lists): `kind-order.test.ts`, `m2-pins.test.ts`, `pin-q14-registry.json`, `kinds-route.test.ts`, the four pin files, `canvasKinds.test.ts`, `viewData.test.ts`, `no-kind-branch.test.ts`: my edits there are one string each; P's `playbook` entries stand beside them.
Line endings: every file keeps its own (checked by bytes; the fork mod folder is CRLF like its siblings, the new test files LF, the JSON pins LF as they were). No U+2014 in any file I touched. The app bundle `packages/app/dist` was rebuilt (ignored by git). Scratch copies and scripts I made outside the repo, and my files in `spike/tmp`, are deleted.

## For the orchestrator: how the fork looks and behaves (user-facing)

**On the canvas.** The palette has a `fork` card in the Flow section (after `end`). A fork block is orange (the loop colour) and reads `fork` with a small chip, `runs 2 at once`. It is the only block with a gray dot on its right: drag it to a block to draw a wire, drag again for the next branch; a second wire to the same block does nothing. Wires go to free blocks behind the `end`; a free block and the free blocks under it with no wire form a chain drawn together, joined like the stack, and an `end` closes it. Detaching a block from the stack puts an `end` between it and the chain above. Red (`on-fail`) and blue (`against`) handles stay on run and verify; plain blocks no longer have the gray one, and an old file with a `next:` line still shows its gray arrow and can delete it.
A new fork is marked as an error until it has a wire ("fork `fork-1` has no branches; drag a wire from it to the first block of each branch"); with one wire it warns ("it runs nothing in parallel"); when two branches can both write it warns ("branches `a` and `b` can both edit files in the same folder at once"); a model block inside a branch, a fork inside a branch, or a branch that leads back into the stack are errors in plain words.

**In a run.** The fork parks the main line, starts every branch at once, each in its own conversation that begins with the last reply before the fork (quoted as data, so it cannot give instructions). Each branch has its own title on the canvas and its own card (`Branch API research`), its own money share of the workflow's (or the open block's) USD budget, its own Stop. A branch that fails or says it is blocked pauses on its own card while the others keep going and the fork waits; Stop on any card stops them all and closes every open question. When the last branch ends, the block under the fork gets every branch's last reply, quoted, in the order of the wires. The Chat feed says `Fork fork-1: 2 branches started.` and `Fork fork-1: every branch finished.`; `reins run` prints `· fork fork-1: 2 branches started`, a line when each branch starts and ends (with its cost), and `forks 1` in the receipt, which also lists what each branch cost. A fork inside `repeat` starts fresh branches on every pass.
