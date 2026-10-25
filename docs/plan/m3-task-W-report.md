# M3 Task 8 (group W) report: the 11 conditions and the 3 cards move into the default pack

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 1f961eb plus the other three groups' work in the same tree. Nothing committed, added, stashed, reset, checked out or pushed. Group W touches only the files listed at the end.

Result: the 11 conditions and the 3 cards are pack mods, one folder each, under `packages/server/src/mods/cond-<t>/` and `card-<kind>/` (`index.ts` + `mod.json`). Core registers none of them; `core/src/conds/` and `core/src/cards/` hold only their registry. Everything they do is byte for byte what core did at HEAD: the pin was recorded from an export of HEAD and passes unchanged on the moved code. Not run by me (rule 3): the whole suite, the real build, the browser and live tests. Run by me and green: the core, server and app files named below, root `tsc --noEmit`, `tsc -p packages/app`, eslint on every file I touched.

## What moved

| Old | New |
|---|---|
| `core/src/conds/{approve,tests,cmd,llm,review,done,diff,touches,attempts,same,drift}.ts` | deleted. `mods/cond-<t>/index.ts` calls `api.registerCondition(atom)`; the editor data is `view.<t>` in `mod.json` |
| `core/src/cards/{guard,now,stop}.ts` | deleted. `mods/card-<kind>/index.ts` calls `api.registerCard(card)`; `guard` has `view.guard` (section, add); `now` and `stop` have no view, as before |
| `conds/index.ts`: 11 imports, the order list, the `BUILT_IN` set, `builtinCondView`, 11 re-exports | the registry only (`CONDS`, `registerCondition`, `isModCond`) |
| `cards/index.ts`: 3 imports, the order list, `builtinCardView`, 3 re-exports | the registry only (`CARDS`, `registerCard`, `CardType`, `CardView`) |
| `declare module '../model.js' { interface CondAtoms ... CardKinds ... }` in each file | `declare module '@reins/core'` in each mod's `index.ts` (root and app typecheck still see the names) |

Manifests: `order` is the number each had in core's registry (conditions: approve 10, tests 20, cmd 30, llm 40, review 50, done 60, diff 70, touches 80, attempts 90, same 100, drift 110; cards: guard 10, now 20, stop 30). All have `"pack": "default"`, `"kind": "condition"` or `"card"`, `"main": "index.js"`, `provides.conditions` or `provides.cards`. None is `required`.

### One folder each (the decision, from the code)
Customize copies a FOLDER, so one folder per condition is what lets a user tweak `tests pass` without touching the other ten. Nothing blocks it: the loader loads conditions and cards before blocks, whatever the number of folders; each folder builds to `index.js` + `mod.json` (the generic `pack-mods.test.ts` builds, checks and Customizes all 14); the limits (50 files, 1 MB) are per folder. The ids are prefixed (`cond-tests`, `card-guard`) so they cannot collide with a block id or the id a user would give a mod (`tests`, `stop`), and read clearly in Settings. The names the atoms and cards have in files and in `provides` are unchanged (`tests`, `guard`). One cost: the Settings list grows by 14 rows.

Question cards were not moved (core owned).

## `api.core` additions: four, each a security surface, each needed
`api.core` was `checkMode, parseCond, policyOf, printCond, turnInstr` (group Y added `parseCond` and `printCond` to the same line while I worked; both are kept). Now: `+ driftFound, globMatcher, isValidGlob, relPath`. Frozen, same object. The pinned list in `toy-block.test.ts` is updated.
- `globMatcher(glob)`: `picomatch(glob)` with its defaults, for `touches`. A mod may not import the package.
- `relPath(p, cwd)`: the policy's own path normaliser, for `touches`.
- `isValidGlob(glob)`: for the `guard` card's validation (the validator in core uses the same function).
- `driftFound(events)`: true when any of the four drift detectors fires, for `drift`. The detectors stay in core (the run uses them); this is only the `||` of the old condition.
Files in core: `policy.ts` (+`globMatcher`, re-export of `isValidGlob`), `drift.ts` (+`driftFound`). Wired in `loader.ts` `buildApi`, `types.ts` `ModApi.core`, `core/test/pack.ts` (the core test api).

## Core and loader changes outside my kind files (each small, each tested)
1. `registerCondition(c, order, { shadow, pack })`: new `pack` flag. `isModCond(c)` is now "not flagged" (it was "not in the built-in set"). The parser answers a flagged atom's complaint at once and holds a mod atom's complaint until no other atom takes the text. Without this, once all 11 became mod atoms every complaint would have been held and a later atom could have taken text a pack atom rejects (`attempts > x` would parse as something else). The loader sets the flag for a pack mod and for a Customize copy of one (`may('cond-view', t)`); a test or a user mod registers without it. Core test setup (`core/test/pack.ts`) passes `{ pack: true }`. Tests: `m3-task-w-core.test.ts` (4), `m3-task-w-moves.test.ts` (loader and Customize copy).
2. `CORE_NAMES` (a snapshot of core's condition and card names, read when `kinds.ts` loaded) is replaced by `HOLDERS` (`kinds.ts`) and `holding()` (`loader.ts`). The snapshot would be empty now, which would have let a user mod claim `tests` and fail only at activation. `HOLDERS` records which mod put each condition and card name in core and takes it out with the entry. The manifest check refuses a name core holds for ANOTHER mod ("which Reins already has", the words are unchanged, `m2-fix-25a-a` and `toy-block-import` pin them); a mod's own name is not a clash (a manifest read again, a carried mod on a second load). A mod whose id is already recorded in the registry (a Customize copy) skips the check, so the loader's own rule still decides ("could not replace the built-in", pinned by `pack-loader`): this is a sixth parameter `replaces` on `providesProblems`, after the `builtin` one group X added. `Door.put` got a fifth parameter, the mod id. Side effect that is a feature: switch `cond-tests` off and a user mod may bring its own `tests` atom (tested).
3. `kinds-view.ts` `servedKinds`: the editor data of a condition or card is always the manifest's (the `cond-view` / `card-view` registry); `builtinCondView` and `builtinCardView` are deleted from core. A second view under a pack name is refused by the registry ("already registered"), which is what protects the pack's data now.
4. `cond.ts` / `cards/index.ts`: comments only (`CondType.view` stays in the type, because a test may still register an atom with one; the loader takes it out of any mod's code).

Anything here that could clash with another group: `loader.ts` (`Door.put`, the `core:` line, one import line), `kinds.ts` (`providesProblems`, the two `validate` lines, the `CORE_NAMES` block), `types.ts` (the `core:` type and the import line), `kinds-view.ts` (import, 2 lines), `core/test/pack.ts`, `no-kind-branch.test.ts` (one new `describe` appended). I re-read each file right before every edit; I saw the other groups' lines (`parseCond`/`printCond` in `api.core`, `builtin` on `providesProblems`, `block-view` trust args) and they are intact.

## The guard rule (new in `no-kind-branch.test.ts`)
`describe('no kind, condition or card file under core/src')`: `nodes/`, `conds/` and `cards/` hold EXACTLY this and nothing else:
`nodes/index.ts` (registry and shared block types), `nodes/fields.ts` (view types), `nodes/turn.ts` (`turnInstr`, `policyOf`, `checkMode`: the helpers a block gets through `api.core`), `nodes/use.ts` and `nodes/use.view.ts` (the `use` block, which the plan keeps in core), `nodes/README.md`, `conds/index.ts`, `cards/index.ts`. Plus: the matcher bites; the two registries import no atom or card file and register none; the pack has 11 `cond-*` and 3 `card-*` folders, each `"pack": "default"`. Verified red by putting a file `conds/zzz.ts` there. The `nodes/` part is green now that X, Y and Z have moved their kinds; if one of them leaves a file behind it goes red by name.

## Tests
New (all green):
- `server/test/m3-task-w-pin.test.ts` + `m3-task-w-pin.expected.json`: THE PIN. Through the real loader: 51 condition sources (valid, nested, malformed, whitespace) parsed, printed, round-tripped, with the judge kind and atoms; the 27 that parse evaluated sync, async and for an auto card against 9 fixed contexts (events, command results, last text, loop total, `atRun`, a judge, a diff) with the commands run, the judge calls and the logged events; the hook table (`sameAsRun`, `globs`, `modelCall`, `needsTestCmd`, `auto`, `judge`) of every atom and card; five workflows (gates, test command, cards, auto cards, nested) printed, re-parsed, validated, compiled and run through `commandsOf` (the trust list); four runs on a fake engine (guard turn lines, a `now` auto card, a `stop` auto card, a gate on `tests pass` after a run); the card tag catalogue; the served conds and cards. Recorded from `git archive HEAD` in a scratch folder (node_modules by junction; removed), then copied here; green on the moved code, unchanged.
- `server/test/m3-task-w-moves.test.ts` (24): the 11 + 3 folders and numbers; none required, each bundled, trusted, quiet, in core in manifest order, served from its manifest; the hooks kept; each of the 14 switched off is gone after a restart (and the parser/parse of a card line says so); the pack atom's complaint is answered at once although a later user atom would take the text, also for a Customize copy; Customize of `cond-tests` (another print and another label: after a restart the print and the served label are the copy's); a name the pack holds is refused for a user mod, free when the pack mod is off, and the holder map is written and cleared; the mods import nothing outside their folder.
- `core/test/m3-task-w-core.test.ts` (8): the helpers (`globMatcher`, `isValidGlob`, `relPath`, `driftFound` with each of the four signals), the `pack` flag, the disposer.
- `no-kind-branch.test.ts`: the new rule (4 tests).
- The generic `pack-mods.test.ts` already covers the 14 for the manifest, the flat build and Customize from the built folder (they pass), but its "in core" and "switched off" checks read `provides.kinds` and so do nothing for conditions and cards; `m3-task-w-moves.test.ts` covers that. I did not edit `pack-mods.test.ts` (shared with the other groups).

### Red at HEAD
The pin is green at HEAD by construction (it was recorded there). `m3-task-w-moves.test.ts` and `m3-task-w-core.test.ts` were not run at HEAD; they cannot pass there (no `cond-*` folders, no `driftFound`, no `pack` flag, no `HOLDERS`).

## Mutation round (rule 4)
57 hand-applied breaks by a script (find one string, replace, run the named files, write the original back, compare SHA-256; if another group edited the same file meanwhile the script undoes only its own break). `restored=true` every time. The script was in `spike/tmp` (gitignored) and is deleted.

| kind | breaks (all red unless stated) |
|---|---|
| approve | prefix `you approves`; judge `agent`; `auto: false` removed |
| tests | `needsTestCmd` removed; `sameAsRun` without `|| !cmd`; `atRun` ignored (SURVIVED, see below, red after) |
| cmd | `sameAsRun` inverted; "Unterminated command" words; print without `passes` |
| llm | `logEvent('judge')` removed; no judge answers yes; `modelCall` removed |
| review | optional question parse loses `skipWs`; judge `model`; `modelCall` removed |
| done | `REINS: Done`; first line instead of last; judge `model` |
| diff | `>` to `>=`; "Expected lines" words; no `diffLines` answers yes |
| touches | path not made relative; `globs` removed; `path` key dropped |
| attempts | `>` to `>=`; error words; print spacing |
| same | needs 3 results; digits kept; success not checked |
| drift | always false; print `drifting`; judge `agent` |
| guard | turn line words (SURVIVED, see below, red after); policy push removed; glob check off |
| now | delivery `stop`; manifest order 35; kind renamed |
| stop | delivery `now`; manifest order 5; `pack` changed in the manifest |
| manifests | `cmd` label; `touches` look; `llm` order |
| shared | S1 loader never passes `pack`; S2 name check off; S3 holder not written; S4 served `t` dropped; S5 core ignores `pack`; S6 `globMatcher` out of `api.core`; S7 core test api drops `pack`; S9 `driftFound` misses one detector; S10 `replaces` always false (red in `pack-loader`); S11 `isModCond` always true; S12 loader keeps a `view` from code (red in `questions-cards`); S8 a file under `conds/` (red in the guard) |

Two survivors at the first pass: `tests` ignoring `atRun` (no fixture had a passing command that was not at a run) and the `guard` turn line (no run sent a guarded step to the engine). I added three contexts and four runs to the pin, re-recorded it from the HEAD export (the old keys came out identical, checked key by key), and both breaks are red. Not mutated: the whitespace skip before `passes` in `cmd` (not tried).

## Existing tests edited (with the reason)
- `server/test/trust.test.ts`: `usePack()` (it compiles workflows with conditions and had no loader).
- `server/test/toy-block.test.ts`: the pinned `api.core` key list (and its title) gains the four.
- `server/test/claude-mod.test.ts`: the exact list of loaded mods now leaves the pack's rows out (`m.pack !== 'default'`); Task 3 had listed `end, phase, say`, which would grow with every group.
- `server/test/questions-cards.test.ts`: a `loadReal()` loader (the shipped bundled folder) for the "served conditions and cards" tests; the HEAD claims "core serves the built-in's data whatever a view under the name says" became "the registry refuses a second view under a pack name and the pack's data is served"; after `dispose` the pack's atoms go with the load (`[]`). I touched only that describe and the two import lines; group X edited other lines of the same file.
- `server/test/m2-fix-25a-a.test.ts`: the same two ideas for MINOR 2 (the name check and "serves core's data") now start the pack in a temp home (`startMods`) because the names live in the pack.
- `server/test/kinds-route.test.ts`: two lines that read every pack manifest as a block (`.view.order`, `.provides.kinds.includes`) now pick the block mods / allow no `kinds`. Group Z or X may also be editing this file; its three remaining failures (`gate` already registered, the lists with no pack) are theirs.
- `app/test/servedMenus.test.ts` and `app/test/m3-task-2-view-events.test.ts`: `servedKinds()` with no argument (core's own views only) became `served()` from `app-pack.ts` where a test needs the conditions and cards the setup made (Task 3's rule). 5 lines.
- `core/test/no-kind-branch.test.ts`: the new rule appended. `core/test/pack.ts`: `{ pack: true }` for conditions and the new `api.core` keys.
- No golden, no `*.browser.test.ts`, no `vitest.config.ts`, no lockfile, no `package.json`.

## What the plan got wrong or left open
1. The brief says "`isModCond` stays" implicitly (it reads conditions "through the registry"); it cannot: with `BUILT_IN` empty every atom is a mod atom and every complaint is held, which changes parsing. The `pack` flag above is the fix; nothing in the brief names it.
2. `CORE_NAMES` was a snapshot taken when `kinds.ts` loaded. The brief says nothing of it; after the move it is empty and a user mod could have claimed `tests`. `HOLDERS` replaces it.
3. The generic `pack-mods.test.ts` is vacuous for conditions and cards (it reads `provides.kinds`). Left alone; covered by a file of mine. A later task could fold the two.
4. Behaviour that is new and worth a line in Task 15: a user can switch off `cond-approve` and a workflow with `you approve` then has a parse error ("Unexpected condition token"), as an unknown step kind does. A user can also provide an atom of the same name once the pack mod is off. Both are the product goal (remove, tweak), but the Settings screen says nothing about it.
5. Docs not updated (Task 15 owns them): `packages/server/src/mods/README.md` lists `api.core` as three helpers and does not name `HOLDERS`, the `pack` flag or the `cond-*` folders; `core/src/nodes/README.md` still has the two-file recipe.
6. Not run: the real build (`tsc -p tsconfig.build.json`, `copy-mods.mjs`) and `tsc -p tsconfig.dist-check.json`. The generic test compiles each of the 14 folders file by file with `typescript` and checks the result is flat text; the real build needs the gate.
7. While I worked, `git status` began showing tracked files under `spike/tmp/` as deleted (` D spike/tmp/P0.2.json` and others). I did not delete them; I only created and removed my own script, results and HEAD export there.

## `git status --short` (my files)

```
 M packages/app/test/m3-task-2-view-events.test.ts
 M packages/app/test/servedMenus.test.ts
 D packages/core/src/cards/guard.ts
 M packages/core/src/cards/index.ts
 D packages/core/src/cards/now.ts
 D packages/core/src/cards/stop.ts
 M packages/core/src/cond.ts
 D packages/core/src/conds/approve.ts
 D packages/core/src/conds/attempts.ts
 D packages/core/src/conds/cmd.ts
 D packages/core/src/conds/diff.ts
 D packages/core/src/conds/done.ts
 D packages/core/src/conds/drift.ts
 M packages/core/src/conds/index.ts
 D packages/core/src/conds/llm.ts
 D packages/core/src/conds/review.ts
 D packages/core/src/conds/same.ts
 D packages/core/src/conds/tests.ts
 D packages/core/src/conds/touches.ts
 M packages/core/src/drift.ts
 M packages/core/src/policy.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/core/test/pack.ts
 M packages/server/src/mods/kinds-view.ts
 M packages/server/src/mods/kinds.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/mods/types.ts
 M packages/server/test/claude-mod.test.ts
 M packages/server/test/kinds-route.test.ts
 M packages/server/test/m2-fix-25a-a.test.ts
 M packages/server/test/questions-cards.test.ts
 M packages/server/test/toy-block.test.ts
 M packages/server/test/trust.test.ts
?? docs/plan/m3-task-W-report.md
?? packages/core/test/m3-task-w-core.test.ts
?? packages/server/src/mods/card-guard/
?? packages/server/src/mods/card-now/
?? packages/server/src/mods/card-stop/
?? packages/server/src/mods/cond-approve/
?? packages/server/src/mods/cond-attempts/
?? packages/server/src/mods/cond-cmd/
?? packages/server/src/mods/cond-diff/
?? packages/server/src/mods/cond-done/
?? packages/server/src/mods/cond-drift/
?? packages/server/src/mods/cond-llm/
?? packages/server/src/mods/cond-review/
?? packages/server/src/mods/cond-same/
?? packages/server/src/mods/cond-tests/
?? packages/server/src/mods/cond-touches/
?? packages/server/test/m3-task-w-moves.test.ts
?? packages/server/test/m3-task-w-pin.expected.json
?? packages/server/test/m3-task-w-pin.test.ts
```

Files in the shared list that I edited are: `loader.ts`, `kinds.ts`, `kinds-view.ts`, `types.ts`, `core/test/pack.ts`, `no-kind-branch.test.ts`. `nodes/index.ts`, `core/src/views.ts`, `core/src/index.ts`, `viewShape.ts`, `canvasKinds.ts`, `setup-kinds.ts`, `app-pack.ts` and `pack-helper.ts` I did not touch.

Line endings: every file keeps its own (checked by bytes, none mixed). The deleted and rewritten core files were CRLF and `conds/index.ts` and `cards/index.ts` are CRLF again; the 28 new mod files are CRLF like their siblings; the new test files and the JSON pin are LF; `servedMenus.test.ts`, `m3-task-2-view-events.test.ts` and `server/test/m2-fix-25a-a.test.ts` are LF as they were. No U+2014 in any file I touched or wrote.
