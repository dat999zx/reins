# M3 Task 4 (group X) report: `gate`, `if`, `recall` and `store` move into the default pack

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook. Nothing committed, added, stashed, reset, checked out or pushed. No build and no full suite run (the brief says the gate is yours).

Result: the four kinds are bundled pack mods under `packages/server/src/mods/{gate,if,recall,store}/` (`index.ts` + `mod.json`). Core registers none of them. What they produce is byte for byte what core produced at HEAD: the pin was recorded at HEAD (before any move) and passes unchanged.

## What moved

| Old | New |
|---|---|
| `core/src/nodes/{gate,if,recall,store}.ts` and `*.view.ts` | deleted; each is a mod folder, the view is JSON under `view` in `mod.json` |
| `nodes/index.ts`: 4 imports, 4 list entries, 4 `*Node` exports | removed |
| `views.ts`: 4 imports and entries in `BUILTIN_VIEWS` | removed |
| `Instrs.GATE/IF/RECALL/STORE` (`compile.ts`), `RunEvents.gate_paused/recall/store` (`run.ts`), those three in `CORE_EVENTS` (`viewShape.ts`) | removed; the mods declare them (see "New in core", point 1) |
| `no-kind-branch.test.ts`: `gate_paused` in the run.ts list, `gate_paused: 1,` and `recall: 1, store: 1,` in the two viewShape allowlist texts | removed |

Manifests (`order` = the number in core's registry at HEAD; the view keeps its own `order`):

| mod | `order` | view order | `provides` |
|---|---|---|---|
| `gate` | 40 | 40 | kinds `gate`, ops `GATE`, events `gate_paused` |
| `if` | 60 | 60 | kinds `if`, ops `IF` |
| `recall` | 90 | 80 | kinds `recall`, attrs `knowl`, ops `RECALL`, events `recall` |
| `store` | 100 | 90 | kinds `store`, attrs `knowl`, ops `STORE`, events `store` |

All: `"pack": "default"`, no `required`, `"main": "index.js"`, `"kind": "block"`. Files are CRLF like their siblings. The `count`/`print`/`view.status` hooks Task 2 put in the four files moved with them unchanged (receipt numbers and printed lines are identical: the pin and `m3-task-2-moves` are green). The gate's question card and its `gate` pause type stay core's.

## `api.core` additions: two, both for `if`

`parseCond` and `printCond` (frozen with the rest). `if` reads a condition from its heading and prints it back; a mod cannot import core. Both are pure text functions (a string in, a condition or a string out; no registry write). Touched: `loader.ts` (the import and the frozen object), `types.ts` (`ModApi.core`), `core/test/pack.ts` (core's own copy of the object), `toy-block.test.ts` (the test that pins the exact list), `mods/README.md` (the line that said "exactly three"). Group W also added names to the same object (`driftFound`, `globMatcher`, ...); my two are still in it. Group Y's `repeat` will need the same two: read them from the list as it stands.

## New in core and the loader (LOUD: outside my four kinds; each is small and tested)

1. **`ModInstrs` and `ModEvents` (core `index.ts`, used by `compile.ts` and `run.ts`).** `declare module '@reins/core' { interface Instrs {...} }` does NOT reach `Instr`, and `interface RunEvents` does not reach `RunEventType`: both interfaces reach `@reins/core` through `export *`, and TypeScript merges the augmentation into a copy of the symbol that core's own derived types never see (I tested this with a scratch file: `Extract<Instr, {op:'ZZ4'}>` stays `never`, `'zz4ev'` is not a `RunEventType`; `NodeKinds`, `Policy`, `ExecCtx` do merge). So core now declares two empty interfaces in `index.ts` itself, the module a mod augments: `Instr` is built from `Instrs & ModInstrs`, `RunEventType = keyof RunEvents | keyof ModEvents`. A pack mod writes `declare module '@reins/core' { interface ModInstrs { GATE: {...} } interface ModEvents { gate_paused: unknown } }`. **Groups Y and Z hit the same wall for `RUN`/`LOOP_IN`/`VERIFY` and their events** (their mods currently say `interface Instrs`/`RunEvents` in the `@reins/core` block, which typechecks to `never`): they need `ModInstrs`/`ModEvents`. The plan's `declare module '@reins/core'` for instructions and events does not work as written.
2. **The fence now lets a mod op judge the conditions of its own instruction.** `run.ts` `modVm.judge`: a command-judged atom is allowed when it is in the instruction's `cond` or `repeatCond` (the fields `server/trust.ts` `commandsOf` already counts in the trust hash) even if the op's `commands()` does not list it. Without it a Customize COPY of `gate` or `if` (a mod, so fenced) could not run `until: tests pass`: "may not run ... its commands() does not list it" (my first pin run showed it). I considered `commands: (i) => condCommands(i.cond)` in the mods plus a new `api.core` helper; it would list the same command twice in `commandsOf` and so change every trust hash, so I did not. Pack mods themselves are not fenced at all since group Y's change (`run.ts` ~1875: `if (!mod || mod.pack) await op.exec(instr, this.vm(t))`); the rule matters for copies. Tested with a fenced copy (below).
3. **Question names: `questionRefusal(key, name, builtin = false)`.** `gate` is both a question card and a block kind. The old exemption read `BUILTIN_VIEWS` ("a `kinds` entry that is a built-in block is left to the block rules"); `gate` left that list. Now the exemption is `builtin`: the manifest is a bundled mod's, or a user mod that has the id and kind of one (a Customize copy). `validateMod` computes it (`ctx.builtin`: `source === 'bundled' || bundledKinds.get(id) === raw.kind`), `providesProblems`/`viewProblems` in `kinds.ts` take it, the loader's `has()` passes `raw.pack === 'default' || may('block-view', name)`. A user mod named something else that provides the kind `gate` is now refused with the question-card words (before: the registry's "already registered"). Existing test `questions-cards.test.ts` edited for that (below).
4. **`view.fresh.cond` for the pack.** `viewShape.ts`: `ViewScope.mod` gets `pack?: true`; a mod view may start with a condition only when it is the pack's or a copy of one (`gate`, `if` use `fresh: { cond: { t: 'approve' } }`). `kinds.ts` and `kinds-view.ts` (`take`) pass the flag the same way, so the served-list check agrees with the manifest check. Any other mod still gets "title, a prompt and attributes only".

## THE BIG RISK for these kinds

Same as Task 3: a kind exists only while the pack is loaded. Production entry points all call `startMods` (verified by Task 3). Tests: core has `setup-pack.ts`, the app setup loads the pack, server files that parse or run these kinds without a loader needed `usePack()`. I scanned every server test file that names `## gate/if/recall/store` and ran them; the only one that needed it is `toy-block-hostile.test.ts` ("the trust list" describe, `usePack()` scoped there; the file's other describes load their own mods).

## Tests

New (green):
- `server/test/m3-task-4-pin.test.ts` + `m3-task-4-pin.expected.json`: recorded at HEAD with `PIN_WRITE=1` before the move. Through the real loader: parse, printed round trip, diagnostics, validate, full compiled program for 4 workflows (recall/store with a topic list, empty `knowl`; gates of three kinds; ifs with else, without, with no condition; a file full of errors: bad condition, gate with no `until`, attributes on recall/store); events and receipts of 5 runs (with and without the host's recall/store functions, so `knowlRecalls`, `knowlStores`, `knowlSkipped` all move; the functions' calls are recorded; gates held and approved, a judged gate, a command gate that holds; if true branch, if false branch with else); chat tags for every catalogue entry and the four names; the catalogue; the served kind order; the 4 served views.
- `server/test/m3-task-4-moves.test.ts` (6): the four are in core with their mod mark, declared events and pack mark; each kind's `attrs`, `tag`, `container` and op names (the union of all attribute lists hides a missing one); a gate and an if judge `tests pass` (run, command run once, both branches of the if); a fenced copy of a gate (a non-pack mod) judges the command condition of its own instruction and is refused another command; a failing gate holds the run and logs `gate_paused` once; `fresh.cond` only with the pack flag.
- The generic `pack-mods.test.ts` (110 tests, written once in Task 3) now covers the four: manifest, flat source, flat BUILD, no import that leaves the folder, bundled/trusted/enabled/no problem/in core at its manifest order, switched off gives "Unknown step kind", **Customize from the built folder** (copy, restart, runs from `mod-cache`; this is what exercises `builtin` in `validateMod` for `gate`'s question name and `fresh.cond`).

### Red at HEAD
I did not export HEAD to a scratch folder (the tree is shared with three other groups). The pin was recorded at HEAD itself and passed unchanged after the move; its first run after the move was red ("Unknown step kind", then the gate fence) and went green only with the fixes in "New in core" 2 to 4. `m3-task-4-moves` was written after the move; at HEAD its pack-mark test (`mod.pack` on the four) and its `fresh.cond` test (`ViewScope.mod.pack` does not exist) would fail, the fenced-copy test passes only with "New in core" 2; the other three describe behaviour that did not change and would pass.

## Mutation round (27, each by replacing one string, running the named files, writing the original bytes back and comparing SHA-256: `restored=true` every time; no git command)

| # | break | first red test |
|---|---|---|
| G1 | gate never judges (`if (false)` for non-approve) | moves (gate and if judge) |
| G2 | gate counts into `loopAttempts` | pin |
| G3 | gate tag words | pin (tags) |
| G4 | gate drops its `until` error | pin (bad) |
| I1 | if's else branch goes on instead of jumping | pin |
| I2 | if prints no condition | pin |
| I3 | if's default condition `approve` instead of `done` | pin |
| I4 | if `container` `kids` | pin |
| R1 | recall keeps empty topics | pin |
| R2 | recall "skipped" counted as a recall | pin |
| R3 | recall print words | m3-task-2-moves |
| R4 | recall `attrs: []` | SURVIVED first with a duplicate-name break (an equivalent mutant); with `attrs: []` it survived the pin too, because `store` lists `knowl` and attributes are read as a union. Now red in moves ("each block's attribute list") |
| S1 | store default `what` | pin |
| S2 | store keeps `REINS:` lines in the summary | pin |
| S3 | store "skipped" counted as a store | pin |
| S4 | store print words | m3-task-2-moves |
| X1 | gate manifest `order` 40 to 55 | core `kind-order` |
| X2 | `if` manifest lacks op `IF` | pin (the loader refuses the block) |
| X3 | `recall` manifest lacks event `recall` | pin |
| X4 | gate view loses `fresh.cond` | pin (served view) |
| X5 | `viewShape`: the pack flag ignored (`fresh.cond` refused for the pack too) | moves |
| X6 | `questionRefusal` never exempts | questions-cards |
| X7 | `questionRefusal` always exempts `kinds` | questions-cards |
| X8 | `builtin` true for every user mod | questions-cards (the shadow-gate mod must be refused) |
| X9 | `builtin` never | pin (the pack does not load) |
| X10 | fence: own-instruction exemption removed | moves (fenced copy) |
| X11 | served-list check ignores `builtin` | pin |

Per kind: gate 4 (+X1, X4), if 4, recall 4, store 4; shared 11. One survivor class: R4 as first written (equivalent), fixed by the new test. Not mutated: `ModInstrs`/`ModEvents` (a type-level change; `tsc` is the test: removing them gives `never` errors, shown with the scratch file).

## Existing tests edited (with the reason)
- `core/test/no-kind-branch.test.ts`: the three allowlist texts lose the moved events (the brief).
- `core/test/pack.ts` (not a test: core's copy of `api.core`): two names added.
- `server/test/toy-block.test.ts`: the pinned `api.core` member list (+ `parseCond`, `printCond`).
- `server/test/questions-cards.test.ts`: `questionRefusal('kinds','gate')` was `undefined` because `gate` was a built-in view; now `true` as third argument gives `undefined` and without it the refusal; the "shadow-gate" user mod is refused with the question words.
- `server/test/kinds-route.test.ts`: "a mod view cannot take the place of a built-in kind" used `gate` as the core kind; it uses `use` now (the one kind that stays in core).
- `server/test/toy-block-hostile.test.ts`: `usePack()` in "the trust list" (workflows with `## gate`).
- `app/test/m3-task-2-view-events.test.ts`: the two restores (`setKinds(servedKinds().kinds)`) use the pack's list (`served()` from `app-pack.ts`); the built-in gate test needs the pack kinds. (The file's `setConds(servedKinds().conds)` line is group W's.)
- `app/test/m2-fix-25a-a.test.ts`: the "core event" probe used `store`, which is no longer a core event; it uses `link_budget_exceeded`.
- Not mine, seen red while others were mid-move: `nodes-registry.test.ts` ("finds the node files" expects `model.ts`), `kinds-route` counts, `toy-block` `api.core` list (group W added names), app `standInCond` test (conditions). All green or not mine when I last ran my set.

## What the plan got wrong or left open
1. `declare module '@reins/core'` cannot merge into `Instrs` or `RunEvents` (point 1 above). Task 3's report said it worked for `NodeKinds` only because that is the one that merges.
2. `questionRefusal`'s "built-in block" exemption read `BUILTIN_VIEWS`; the plan did not list it (Task 3's report point 5 foresaw it).
3. `view.fresh.cond` was refused for every mod; `gate`/`if` need it.
4. A fenced mod op that judges a command condition needs either `commands()` or the own-instruction rule; a plain move of `gate` breaks Customize copies silently (a built-in pack mod is unfenced since group Y's `mod.pack` line, so the pack itself would not show it).
5. Build: `tsconfig.build.json` maps `@reins/core` to `../core/dist/index.d.ts`; the mods typecheck there only after core is rebuilt (normal order, `npm run build -w @reins/core` first). I did not run the build.
6. Docs not updated (Task 15 owns them): `mods/README.md` should mention `ModInstrs`/`ModEvents` and `builtin`; `core/src/nodes/README.md` still has the "two-file" recipe for built-ins.

## Checks
- `tsc --noEmit -p .` and `-p packages/app`: clean at my last run (after the other groups' states settled). eslint clean on every file I touched.
- Last runs: server (m3-task-4*, pack-mods, questions-cards, kinds-route, m2-fix-25a-a, m3-task-2*, run-cli*, drive, toy-block-hostile, mod-contain, cli, trust, workflow-files, exit, tags, store, recover, m2-fix-c, session-tracks): green; core (m1-*, golden, m2-pins, m3-task-2*, no-kind-branch, kind-order, nodes-registry, registry): green; app (m2-fix-25a-a, m3-task-2*, views, stepStatus, feed, canvasKinds): green.
- Line endings: kept per file (checked by bytes; the four mod folders are CRLF, the new test files LF). No U+2014.

## `git status --short` (my files; the other groups' are not listed)

```
 M packages/app/test/m2-fix-25a-a.test.ts
 M packages/app/test/m3-task-2-view-events.test.ts
 M packages/core/src/compile.ts
 M packages/core/src/index.ts
 D packages/core/src/nodes/gate.ts
 D packages/core/src/nodes/gate.view.ts
 D packages/core/src/nodes/if.ts
 D packages/core/src/nodes/if.view.ts
 M packages/core/src/nodes/index.ts
 D packages/core/src/nodes/recall.ts
 D packages/core/src/nodes/recall.view.ts
 D packages/core/src/nodes/store.ts
 D packages/core/src/nodes/store.view.ts
 M packages/core/src/run.ts
 M packages/core/src/viewShape.ts
 M packages/core/src/views.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/core/test/pack.ts
 M packages/server/src/mods/README.md
 M packages/server/src/mods/kinds-view.ts
 M packages/server/src/mods/kinds.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/mods/types.ts
 M packages/server/src/questions/index.ts
 M packages/server/test/kinds-route.test.ts
 M packages/server/test/questions-cards.test.ts
 M packages/server/test/toy-block-hostile.test.ts
 M packages/server/test/toy-block.test.ts
?? docs/plan/m3-task-X-report.md
?? packages/server/src/mods/gate/
?? packages/server/src/mods/if/
?? packages/server/src/mods/recall/
?? packages/server/src/mods/store/
?? packages/server/test/m3-task-4-moves.test.ts
?? packages/server/test/m3-task-4-pin.expected.json
?? packages/server/test/m3-task-4-pin.test.ts
```

Shared files other groups also edited in the same tree (my edits there are the lines named above): `core/src/nodes/index.ts`, `views.ts`, `compile.ts`, `run.ts`, `viewShape.ts`, `loader.ts`, `types.ts`, `core/test/pack.ts`, `no-kind-branch.test.ts`, `toy-block.test.ts`, `kinds-route.test.ts`, the two app tests.
