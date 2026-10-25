# M3 fix round, group B: Customize and test fidelity (items 3, 8, 7)

Worktree `D:/coding/reins-wt-fork`, branch `feat/fork-playbook`, HEAD `ee8b080`. Nothing committed, staged, stashed or reset.

## The flag (items 3 and 8)

`ModInfo` got a second flag, `builtin?: true` ("the pack's block, or a Customize copy of one"). `pack` stays "set from a bundled manifest".

- `guard.ts` derives `builtin` from the mark: `pack === true || builtin === true`. So a pack mark alone is enough (core tests, the loader).
- `loader.ts` `nodeCopy` sets `builtin` when `pack` is set, or when the mod replaces a bundled one and holds the kind of the built-in it replaces (`may('block-view', kind)`, the same test `put` already uses for `chatTurn` and conditions use for `cond-view`). A user mod that only names a built-in kind is refused by the registry; a user mod with a kind of its own gets no flag.

### Decision per read of the old `pack` flag

| Read | Flag now | Why |
|---|---|---|
| `guard.ts` `fit` (heading text, default id) | `builtin` | what the block PRINTS; a copy must print what the built-in did |
| `guard.ts` `count` / `print` lines (`tame`, 40 and 300) | unchanged, always capped | the built-in's lines are capped too; not a pack read |
| ops fence (`modOfOp`, `modVm`, log gate, commands, trust, `FAULT_OP` wrappers) | unchanged, `info` still carries `pack` only for the pack | a copy stays fenced and trusted as a mod |
| `run.ts` op route (`!mod \|\| mod.pack`) | unchanged | a copy still takes `modRun` (fenced). Only Stop's treatment changed |
| `run.ts` NODE route | `mod.pack` (new, see item 7) | the pack's own code, as its ops |
| `viewShape` `ViewScope.pack` | unchanged | already set from `builtin` (pack or copy) in kinds-view/kinds.ts |

## Item 3: Customize changes what a block prints

- Red at HEAD (`packages/server/test/m3-fix-b-customize.test.ts`, real loader path: the built pack folders in a temp bundled dir, `customizeMod` with trust for `run`, `phase`, `if`, `gate`, `playbook`, restart): 2 of 4 failed. The copied file printed the 250-char `run` command and the 210-char title cut to `...`, the `if` condition cut, the playbook name cut, and the default id of a 120-char title ended in `...` (so a `next:` naming it would not resolve).
- Fix: `ModInfo.builtin`, `guard.ts` `fit`, `loader.ts` `nodeCopy` + `Door.copy` signature + the call in `buildApi`.
- Now: bytes unchanged round trip with all five customized (equal to the built-in's print), tab kept, no `<U+`, no `...`; a `next:` naming the long default id (over 80 chars) resolves and validates clean.
- Foreign still cut: a trusted user mod with its own kind `zork` prints `zork zzz...` cut to 200 chars plus `...`, and a tab is shown (`\t`), not kept. A user mod naming `phase` is refused and the built-in `phase` (`pack: true`) stays in force.
- Core half (`packages/core/test/m3-fix-b-guard.test.ts`): `guardNode` with `builtin` or `pack` keeps text and id; neither cuts to 203 / 83; `modOfOp` of a copy's op is still a mod's (`pack` undefined, `builtin` true).
- Class sweep: other readers of the flag were `run.ts:1897` (item 8) and the NODE route (item 7); `viewShape` was already right.
- Not done: the `gate` and `playbook` kinds have no `defaultId`; only `phase` has one, so only `phase` exercises the id path.

## Item 8: Stop and a copy of a block with ops (confirmed)

- Confirmed by a test (`packages/core/test/m3-fix-b-stop.test.ts`): an op marked `builtin` without `pack` returned at once on Stop with the counter at 0, the pack's waited (counter 1). Red at HEAD: 1 of 5 failed.
- The copy is "the same block, tweaked". But I did NOT unfence it at `run.ts:1897`: that would run a user-edited, imported file's ops with the full unfenced `vm`, which weakens containment of a hostile mod that is a loader-made copy (an imported mod with a bundled id is a copy too). Instead the fence stays and only the Stop cut changed: `aborts` is now a `Map<end, ModInfo>`, and `cutMods(stopping)` skips a `builtin` mod's end when called from `stop()`. `close()` still cuts every one.
- Trade-off, said plainly: a copy whose op never settles no longer ends `step()` on Stop (`stop()` itself returns and the run is `stopped`); `close()` cuts it. Tested (`a copy that never settles does not hold Stop, and close cuts it`). Another mod's op is still raced with Stop (test kept).
- Existing test edited: `packages/server/test/m3-task-y-moves.test.ts` "a copy is an ordinary mod to Stop" pinned the old behaviour (copy: no `command_result`, counter 0). Now it expects the pack's pin (`command_result` recorded, same counter).
- Existing test edited: `packages/server/test/m3-task-3-moves.test.ts` line 128-130 pinned the item 3 bug (a copy of `phase` prints a 60-word title cut). Now `toContain(long)`.

## Item 7: core tests run the pack as production does

- `packages/core/test/pack.ts` registers each block with `mod: { id, events: provides.events, pack: true, builtin: true }` (conditions already had `pack: true`). `register` then stores the guarded node, as the loader's copy does. `setup-pack.ts` needed no change (its comment is now true).
- Tests that went red once the pack was marked, and why:
  1. `registry.test.ts` "a shadowing copy of an op-bearing kind registers..." and "the exemption is only for the ops of the kind it shadows": identity asserts (`toBe(copy)`, `toBe(runNode)`). `register` now stores a guarded copy of a marked node, and the second test only failed as a cascade of the first (the shadow was never disposed). SETUP fix: the test's own `copy` node carries `mod: undefined` (the test is about registry order and shadowing, not guarding). Edited test, assertions unchanged.
  2. `m2-tracks-fix.test.ts` test 3 (`close()` on a track with a subagent step) and `receipt-tracks.test.ts` "a track still going is not ended": a REAL ENGINE BUG in production. `run.ts` NODE route (`case 'NODE'`) fenced every mod's `exec` via `modRun`, the pack's included. With the pack marked, `subagent` (a NODE block) was raced with Stop/close, so `close()` left the track paused with "The block "subagent" did not move on; Resume tries again" (the saved run would reopen paused instead of running), and track end order changed. Unmarked, the core tests hid it. Fix (small, two single-line edits in `run.ts`, group A works elsewhere in the file): the pack's NODE `exec` runs unfenced as its ops do (`!mod || mod.pack`), and a `stay` answer from a pack block does not pause (`mod && !mod.pack`). Both tests pass unchanged.
  3. `no-kind-branch.test.ts` and `playbook.test.ts` / `m2-money.test.ts` / `m3-fix-a-engine.test.ts` were red for a while in between: they belong to group A (money cap, item 1 and 2 in the middle of their work) or to a scan of the other groups' new files. All green in the final whole-core run.
- Final whole core project (`vitest run packages/core --maxWorkers=2`): 77 files, 1041 tests, all green. `npm run typecheck` clean.
- Pins for this: `m3-fix-b-guard.test.ts` (every pack kind is the frozen guarded copy with `{ id, pack, builtin }`), `m3-fix-b-stop.test.ts` (pack NODE exec is unfenced: it can log an unlisted event, the same exec from a copy or another mod is refused; `stay` pauses only a non-pack mod; Stop waits for the NODE exec of a pack block and of a copy, and races another mod's).

## Mutations (hand-applied, sha256 of the file checked before and after, restored from the saved bytes; a file group A changed meanwhile was restored by reverse edit at the same index)

My first round used a restore that replaced the FIRST match of the mutated text and damaged `guard.ts` and `loader.ts` (and the splat of a one-string test list ran the whole server project). I repaired by single-line edits, confirmed with `git diff` and typecheck, and redid every mutation with a unique-match, saved-bytes restore. The hashes in the table are the second round.

| # | File | Break | Result |
|---|---|---|---|
| M1 | guard.ts | `fit` reads `pack` again | killed (4 red: customize print, `next:`, guard test) |
| M2 | guard.ts | `builtin` not derived from the input mark | killed (7 red) |
| M3 | loader.ts | copy gets no `builtin` | killed (2 red) |
| M4 | loader.ts | every block gets `builtin` | SURVIVED the first foreign test (a user mod named `phase` is refused, so it never printed); added the `zork` test; now killed (1 red) |
| M5 | guard.ts | default id cut with `tame` for a builtin | killed (3 red) |
| R1 | run.ts | `cutMods` always cuts | killed (15 red) |
| R2 | run.ts | `stop()` cuts everything | killed (15 red) |
| R3 | run.ts | `close()` spares a copy | killed (14 red) |
| R6 | run.ts | spare test reads `pack` instead of `builtin` | killed (15 red) |
| R4 | run.ts | NODE of the pack fenced again | first only `receipt-tracks` died; added the "not fenced: logs an unlisted event" test; now killed |
| R5 | run.ts | `stay` of a pack block pauses | killed (2 red) |
| R7 | pack.ts | no mod mark | killed (1 red) |
| R8 | pack.ts | mark without `builtin` | SURVIVED, equivalent: `guard.ts` derives `builtin` from `pack` (M2 covers that derivation) |
| R9 | pack.ts | mark without `pack` | killed (4 red) |
| R10 | pack.ts | `events: []` | SURVIVED: the pack's ops are unfenced, so no core test reads `events`. Kept as in the loader |

Hashes (second round) before == after for guard.ts `DBA3DDEB4BB0`, loader.ts `C7803E728A8C`, pack.ts `F46DE43588D3`. `run.ts` changed under me because of group A, so the check is by reverse edit; the final `run.ts` has exactly my 6 touched lines (verified by grep after the last mutation).

## Not mine, red in the neighbour runs (server)

- `m3-task-3-moves.test.ts` "a block that is not end cannot say stops": expects the old `view.stops` text; the text now says "only for a block of the default pack (its `end`)". Group D's `viewShape` change.
- `pack-mods.test.ts` "a pack mod that is not required can be switched off": the test's `unknownKind` helper compares the exact message `Unknown step kind "fork"`; another group's `ABSENT_KINDS` now appends where the kind comes from.

## Unconfirmed

- The `Stop` change was tested with fake engine ops and a fake NODE exec, not with a real shell command through a copy of `run` in the live app. The server pin (`m3-task-y-moves`) does run the real copy of `run` and records `command_result`.
- `may('block-view', kind)` is true for a copy of ANY bundled block mod, not only a pack one. Today every bundled block mod is in the pack.

## Files

```
 M packages/core/src/guard.ts            (builtin derived; fit reads it)
 M packages/core/src/nodes/index.ts      (ModInfo.builtin; one line, shared with others)
 M packages/core/src/run.ts              (aborts map + cutMods(stopping), stop(); NODE route 2 lines; shared with group A)
 M packages/server/src/mods/loader.ts    (nodeCopy, Door.copy, buildApi call; shared)
 M packages/core/test/pack.ts
 M packages/core/test/registry.test.ts   (edited test setup, see item 7)
 M packages/server/test/m3-task-3-moves.test.ts   (edited, see item 8)
 M packages/server/test/m3-task-y-moves.test.ts   (edited, see item 8)
?? packages/core/test/m3-fix-b-guard.test.ts
?? packages/core/test/m3-fix-b-stop.test.ts
?? packages/server/test/m3-fix-b-customize.test.ts
```
