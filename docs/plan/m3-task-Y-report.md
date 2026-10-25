# M3 group Y report: `run`, `verify` and `repeat` move into the default pack (plan Tasks 5 and 6)

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 1f961eb plus the other three groups working in the same tree. Nothing committed, added, stashed, reset, checked out or pushed
(one slip, see "Slip" at the end). The whole suite, the build and the browser tests were NOT run (rule 3).

Result: the three kinds are bundled pack mods under `packages/server/src/mods/{run,verify,repeat}/` (`index.ts` + `mod.json`, CRLF like their siblings). Core registers none of them.
Everything they produce is byte for byte what core produced at HEAD: the pin below was recorded on a `git archive` of HEAD (scratch folder, removed) and passes unchanged now.
Last runs, my files plus the pins the move touches: core 44 files / 570 tests green, server 28 files / 829 green (1 skipped), app 20 files / 526 green; root `tsc --noEmit`, `tsc -p packages/app`
and eslint on every file I touched are clean. Two failures I saw on the way belonged to other groups and went away when they finished their edits (`servedMenus`, `m3-task-2-view-events`, `kinds-route` `gate`).

## READ THIS FIRST: core changes outside my three kinds (each is small, each is tested)

1. **`CompileCtx.loopBody(step, from, exit)` and `OpType.inLoop(instr, loop)`** (`nodes/index.ts`, `compile.ts`, `guard.ts`). This replaces the one thing `repeat` did that a mod cannot: it
   reached back and wrote `repeatCond`, `loopExit` and `onPassJump` into the `RUN` instructions of its body (`ctx.get` hands a mod a frozen copy, on purpose). Now `repeat` calls
   `ctx.loopBody(step, bodyStart, loopExit)`; core hands the loop `{ cond, exit, passes }` to each body instruction whose op has `inLoop` (the `run` block's: it takes those three fields) and returns
   whether one took the condition (then `LOOP_BK` has none to judge). Compiled programs are byte for byte the same (the pin has 15 loop shapes). Safety, all tested (`m3-task-y-loop.test.ts`):
   a hook can only change its OWN instruction (it is only asked for instructions of its own op), never `op`, `step`, `top` or `__proto__`; a guarded (non-pack) hook gets copies, a throw or a patch
   that is not a plain object (text, number, list, null) takes nothing; a mod's compile cannot reach instructions before its own step (`stepFrom` clamp), so a hostile mod cannot patch an earlier step.
   `passes` is core's old name-free test (first kid's op has `ranCommand`, the atom's `sameAsRun`), moved from `repeat.ts` into `loopBody`; a throwing atom is "no".
   **This is the "core helper" the Task 2 report said `repeat` would need as lookups in `api.core`. It is not in `api.core`: no `NODES`/`CONDS` lookup is given to any mod.**
2. **A block of the default pack runs its ops as core's own ops did** (`run.ts`, one line: `if (!mod || mod.pack) await op.exec(instr, this.vm(t))`). Without it the pin goes red: a mod's op is fenced AND
   raced with Stop, so with Stop during a running command the run stopped with the counter on the `RUN` and no `command_result` (at HEAD the run waits for the command, records it, and moves on).
   Resume would then run the command a second time. **This changes the execution path of EVERY pack op, so it touches group X (gate, if, recall, store) as well: their ops now also run unfenced.**
   It only moves them closer to HEAD, but they must know. Only the bundled code gets this (`ModInfo.pack` is set by the loader from a bundled manifest); a Customize copy is an ordinary, fenced mod
   (`m3-task-y-moves.test.ts` runs the pin's scenarios through copies of all three, and of each alone). If this is not wanted, the alternative is a core "wait for a command in flight" rule for ops that `ranCommand`; I did not build it.
3. **A fenced op that says `ranCommand` may log `command_result` for its own step** (`run.ts` `logGate`, a third optional argument). Needed only for a Customize copy of `run` (the pack's own code is unfenced now).
   Not another step's, not for an op without `ranCommand`, no other core event (4 tests in `m3-task-y-fence.test.ts`). `command_result` stays a core event name (`RunEvents`, `CORE_EVENTS`): the app's
   feed, status and hidden lists read it structurally (`feed.ts`, `stepStatus.ts`, `rows/hidden.ts`), so moving it into `run`'s `provides.events` would have put those three app lines on the guard's list.
   The judge gate already lets an op judge the command atoms of its own `cond`/`repeatCond` (`ownConds`, added by group X for `gate`); copies of `run` and `repeat` rely on it.
4. **Root `tsconfig.json`: `packages/*/test/**/*` now comes BEFORE `packages/*/src/**/*` in `include`.** This is not cosmetic and it hits all four groups. TypeScript merges `declare module '@reins/core' { interface Instrs ... }`
   from a mod only if it is processed AFTER every other augmentation of the same interface; core's tests augment `'../src/compile.js'` directly. With src first, every mod's `Instrs` and `RunEvents` merge was lost
   (about 100 errors in root `tsc --noEmit`: `Property 'cmd' does not exist on type 'never'`, `'loop_iteration' is not assignable to keyof RunEvents`); `NodeKinds` merges survive, which is why Task 3 did not see it.
   Reproduced in a 3-file project; the order fixes it; variants with an explicit `export type { Instrs }` do not. The server BUILD (`paths` to core's dist d.ts, no tests in the program) is not affected.
5. **`core/test/no-kind-branch.test.ts`** (shared): (a) the three events leave the reserved-names allowlist (the lines for `run.ts` and `viewShape.ts`); (b) a pack mod's own folder may name its OWN kinds and ops
   (`provides.kinds` / `provides.ops`, new `packNames`), nothing else: `repeat` reads `LOOP_IN` of its own program. A new test pins the rule (`own` exempts only those names). Groups X and Z will meet the same wall for `GATE`, `RECALL`...
   `KIND_EVENTS` in that file still names my three events; it is a union with the manifests' events, so it needed no edit.
6. **Events**: `loop_iteration`, `loop_budget_exceeded`, `verify_result` leave `RunEvents` and `CORE_EVENTS` (`run.ts`, `viewShape.ts`) and are `provides.events` of `repeat` / `verify`, with `declare module '@reins/core' { interface RunEvents ... }`
   in the mod. `m2-fix-25a-a.test.ts` (it pins the two lists equal) passes untouched.
7. **Instructions**: `RUN`, `LOOP_IN`, `LOOP_BK`, `VERIFY` leave `Instrs` in `compile.ts`; each mod merges its own. The op names and the compiled programs are unchanged. `trust.ts` and the program checks name no kind or op (checked).

No other `api.core` addition: **none**. `run`, `verify` and `repeat` use nothing from `api.core` at all.

## What moved

| Old | New |
|---|---|
| `core/src/nodes/{run,verify,repeat}.ts` and `*.view.ts` | deleted. `mods/<kind>/index.ts` (`activate(api)` calls `api.registerBlock`), view as JSON in `mod.json` |
| `nodes/index.ts`: 3 imports, 3 entries in the registry list, 3 `*Node` exports | removed |
| `views.ts`: 3 imports, `BUILTIN_VIEWS` | removed (only `use` is left from my kinds' neighbours) |
| `compile.ts` `Instrs`: `RUN`, `LOOP_IN`, `LOOP_BK`, `VERIFY` | removed, merged in each mod |
| `run.ts` / `viewShape.ts`: 3 event names | removed (see 6) |

| mod | `order` | view order | `provides` | notes |
|---|---|---|---|---|
| `run` | 30 | 30 | kinds `run`, ops `RUN`, attrs `cmd` | `ranCommand`, `inLoop`; the `RUN` shape merged into `Instrs` |
| `repeat` | 50 | 50 | kinds `repeat`, ops `LOOP_IN`, `LOOP_BK`, attrs `max`, events `loop_iteration`, `loop_budget_exceeded` | `allowMore` on `LOOP_BK`; `count` -> `loopAttempts`, print `↻ <step>: attempt <n>` unchanged |
| `verify` | 70 | 70 | kinds `verify`, ops `VERIFY`, attrs `against`, events `verify_result` | `count` -> `verifyResults.passed/failed`, print lines unchanged, `view.status` rule unchanged |

All three: `"pack": "default"`, `"main": "index.js"`, `"kind": "block"`, not `required`. `run.ts` order numbers 30/50/70 are the old registry numbers; the served order of all 13 kinds is in the pin.
`repeat` and `verify` took their `tag`, `statusLine`, `defaultPrompt`, `validate` and `container` along unchanged; `repeat`'s `compile` is the old one with the loop-patch block replaced by `ctx.loopBody`.
The old `repeat.ts` imported `NODES` and `CONDS` from core; the mod imports nothing but types (`packProblems` and the generic flat-build test pass for all three).

## The big risk (tests and tools that parse workflows without the loader)

Nothing new was needed. Every server file that parses these kinds already has `usePack()` (Task 3), loads the pack through `startMods`/`boot`, or reads the served list; app tests load the pack in the setup file;
core tests get it from `setup-pack.ts`. I ran every server and app file that mentions my kinds (lists above) and all pass. Edited for the move: `core/test/registry.test.ts` (imported `runNode`; now
`NODES.get('run')!`), `server/test/m3-task-3-empty-pack.test.ts` ("the ten views that stay in core" listed `run`, `repeat`, `verify` by name; it now compares with `BUILTIN_VIEWS`, whichever kinds have moved, so the other groups need not edit it).
Production entry points: unchanged and already start the loader (Task 3 checked `reins check|run|print|serve|doctor`).

## F11 (the `verify` rule of the fork block)

The tree has no fork mod yet (`mods/` has no `fork`), so there is nothing to add. When it lands, F11 is a `validate.program` member of the NodeType in `mods/verify/index.ts` (it is a mod file now, not
`core/src/nodes/verify.ts`); the plan text that names `nodes/verify.ts` is out of date.

## Tests

New (all green):
- `server/test/m3-task-y-pin.test.ts` + `m3-task-y-pin.expected.json` + `m3-task-y-drive.ts`: THE PIN, recorded at HEAD (`PIN_WRITE=1` on the archive, before any move). Through the real loader: 19 workflows (run with
  on-fail, odd headings, a next link, a step only an on-fail link reaches, the loop shapes (tests pass first/late/failing, a command that is not the run, no command, agent says done, budget held and allowed more,
  nested, `not`, no `max`, empty), verify (flow, budget, held, deep in a repeat, bad targets, a step only on-fail reaches)): parse, printed text, diagnostics, validate, compiled program (full JSON), trust command list and hash, the events,
  receipt, commands run, texts sent and pauses of 25 scripted runs, 3 Stop-while-a-command-runs cases, the chat tags and tag catalogue, the served order and the 3 served views.
- `server/test/m3-task-y-moves.test.ts` (4): the copies are ordinary mods (fenced, no `pack` mark) and the pack's are not; **every scenario of the pin gives the same events, commands, pauses, texts and receipt through
  Customize copies of all three**, and through a copy of each alone beside the pack's other two; a copy is an ordinary mod to Stop (it does not wait for its command). The bundled folder of that test holds only the pack mods the
  workflows use, picked by what their manifest provides.
- `core/test/m3-task-y-loop.test.ts` (14): `loopBody` and `inLoop` (see 1). `core/test/m3-task-y-fence.test.ts` (8): the `command_result` rule and the pack-unfenced rule (see 2, 3).
- `no-kind-branch` +1 (see 5). The generic `pack-mods.test.ts` (Tasks 3's, untouched) now covers my three mods too: manifest, flat source, flat BUILD, within Customize's limits, loads/off/Unknown step kind, Customize from the built folder.

### Red at HEAD
Run on a `git archive` of HEAD (scratch folder removed afterwards):
- `m3-task-y-pin`: green at HEAD (it is the pin; it must be).
- `m3-task-y-loop`: 8 of 14 red (`ctx.loopBody` does not exist). The 6 green ones pin things that did not change or only need the guard (throwing hook, bad compile, no-condition case).
- `m3-task-y-fence`: 3 of 8 red (the `command_result` rule, a pack op unfenced, Stop does not cut a pack op). Green at HEAD by design: the refusals of a fenced op.
- `m3-task-y-moves`: 3 of 3 red (there is no `run` mod folder at HEAD).

## Mutation round (rule 4)
Hand breaks, each one string swapped in, the named files run, swapped back at the same place (checked with a hash of the three mod files before and after; no git command). 38 breaks: run 8, verify 7, repeat 7, shared 16.

| # | break | first red |
|---|---|---|
| R1 | `command_result` carries exit code 0 | pin |
| R2 | `RUN.next` drops the pass and exit jumps | SURVIVED: equivalent (both targets are also reached through `LOOP_BK`'s next) |
| R2b | `RUN.next` drops the on-fail jump | SURVIVED at first: the "never reached" check does not run on a file with an error, and my on-fail workflow had one. Added `runFailTarget`; red as R2b |
| R3 | `commands()` lists nothing | moves (copy: the fence refuses the command), trust list |
| R4 | heading keeps a backtick | pin |
| R5 | `run` loses `ranCommand` | pin |
| R6 | the loop is always left on a pass | pin |
| R7 | on-fail ignores the link budget | pin |
| V1 | fail needs a colon | pin |
| V2 | verify counts swapped | pin, m3-task-2-moves |
| V3 | unknown `against` is a warning | pin |
| V4 | verify turn text always step 1 | pin |
| V5 | verify on-fail never jumps | pin |
| V6 | `VERIFY.next` drops the on-fail jump | SURVIVED at first (same reason as R2b); red with `verifyFailTarget` |
| V7 | `verify_result` always a pass | pin |
| P1 | the loop goes on instead of back | pin |
| P2 | `LOOP_BK` loses `allowMore` | pin |
| P3 | loop budget off by one | pin |
| P4 | the loop always judges its own condition | pin |
| P5 | the loop prints another line | m3-task-2-moves |
| P6 | `max: 0` allowed | pin |
| P7 | `loopAttempts` key wrong | m3-task-2-moves |
| S1 | `passes` for every instruction | loop |
| S2 | `loopBody` reaches earlier steps | loop |
| S3 | a patch may set `__proto__` | loop |
| S4 | the guard lets a list through as a patch | SURVIVED: `compile.ts` refuses it too (two layers). S4b removes the `compile.ts` check: red |
| S13 | a patch may change `op` | loop |
| S5 | the pack is fenced again | pin (Stop cases), fence |
| S6 | `command_result` for any step | fence |
| S7 | every op may log `command_result` | fence |
| S8 | a pack folder may name anything | no-kind-branch (the new test) |
| S9 | `loopBody` with no condition | loop |
| S10 | a throwing atom is "yes" | loop |
| S11 | a throwing hook breaks compile | loop |
| S12 | the exit passed to hooks is off by one | loop |
| S14 | the guard hands the hook the live instruction | SURVIVED at first; a test that writes into the argument added; red |
| S15 | the guard hands the hook the live loop | SURVIVED at first; same test now checks the loop's condition; red |

Survivors left: R2 (equivalent), S4 (defence in depth, the second layer is S4b). An equivalent I did not mutate: `LOOP_BK.next` without its `target` (the body is reached by falling through, so nothing becomes unreachable).
A runner bug cost one round: for four breaks (P2, S6, S7, S9) the swap-back could not find a unique string, so they stayed in the tree while the next breaks ran. I found it from the "restore failed" lines, put the four lines back by hand,
fixed the runner (it now restores at the same place), and RE-RAN every break after P2, with the hashes checked.

## Existing tests edited
`core/test/no-kind-branch.test.ts` (5), `core/test/registry.test.ts` (`runNode`), `server/test/m3-task-3-empty-pack.test.ts` (the 10-view list). Nothing else: no golden, no `vitest.config.ts`, no `*.browser.test.ts`, no lockfile.
Shared source files edited, each with one-string replacements and re-checked after: `nodes/index.ts`, `views.ts`, `viewShape.ts`, `compile.ts`, `run.ts`, `guard.ts`, root `tsconfig.json`.

## What the plan got wrong or left open
1. The plan said `repeat` needs `NODES`/`CONDS` lookups in `api.core` (Task 2 point 3). It needs neither; the hook is the op's (`inLoop`), the lookups stay in core's compile.
2. The plan did not see that a mod's op is raced with Stop and fenced: a plain move changed the Stop behaviour of `run` (the command's result lost, Resume runs it again). Found by the pin; see 2 above.
3. `declare module '@reins/core'` merges of `Instrs` and `RunEvents` need the include order of the root tsconfig (see 4 above). Task 3 only merged `NodeKinds`, which does not show it.
4. `command_result` is logged by the `run` block but is not a "kind event": the app reads it structurally. Left a core name; a later task could move the three app lines to `view.hidden`/`view.status` and let `run` declare it.
5. `core/src/nodes/README.md` and `mods/README.md` do not mention `inLoop`, `loopBody`, the pack's unfenced ops or the `command_result` rule (Task 15 owns docs).
6. The server build compiles with `paths` to core's `dist` d.ts, so core must be built first (it is, in `npm run build`): the mods' use of `ctx.loopBody` and `inLoop` is typed from the rebuilt d.ts. I did not run the build.
7. The `m3-task-y-moves` test depends on the condition mods (`tests`, `cmd`, `done`); it picks pack mods by what their manifest provides, so a rename of a condition mod folder does not break it. It failed once while group W was mid-edit and passes since.

## Slip
While deleting `core/src/nodes/run.ts` I ran `git rm --cached` on it, which staged a deletion. I undid it at once with `git restore --staged packages/core/src/nodes/run.ts`; the index is as it was (`git diff --cached` is empty).

## `git status --short` (my files)

```
 M packages/core/src/compile.ts
 M packages/core/src/guard.ts
 M packages/core/src/nodes/index.ts
 D packages/core/src/nodes/repeat.ts
 D packages/core/src/nodes/repeat.view.ts
 D packages/core/src/nodes/run.ts
 D packages/core/src/nodes/run.view.ts
 D packages/core/src/nodes/verify.ts
 D packages/core/src/nodes/verify.view.ts
 M packages/core/src/run.ts
 M packages/core/src/viewShape.ts
 M packages/core/src/views.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/core/test/registry.test.ts
 M packages/server/test/m3-task-3-empty-pack.test.ts
 M tsconfig.json
?? docs/plan/m3-task-Y-report.md
?? packages/core/test/m3-task-y-fence.test.ts
?? packages/core/test/m3-task-y-loop.test.ts
?? packages/server/src/mods/repeat/
?? packages/server/src/mods/run/
?? packages/server/src/mods/verify/
?? packages/server/test/m3-task-y-drive.ts
?? packages/server/test/m3-task-y-moves.test.ts
?? packages/server/test/m3-task-y-pin.expected.json
?? packages/server/test/m3-task-y-pin.test.ts
```

Line endings: every edited file keeps its own (the edit helper preserved CRLF/LF; `viewShape.ts` is LF); the three new mod folders are CRLF like their siblings, the new test files LF. No U+2014 in any file I touched or wrote.
