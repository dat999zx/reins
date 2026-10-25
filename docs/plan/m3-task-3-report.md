# M3 Task 3 report: `say`, `phase` and `end` move into the default pack

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 04360d4 (M3 Task 2). Nothing committed, added, stashed, reset, checked out or pushed.

Result: the three kinds are bundled pack mods under `packages/server/src/mods/{say,phase,end}/` (`index.ts` + `mod.json`). Core registers none of them. Everything they produce
is byte for byte what core produced at HEAD (the pin below was recorded at HEAD and passes unchanged). Whole suite: core 897 (+ new), app 858, server 3205 (3185 passed, 20 skipped),
0 failed; root and app `tsc --noEmit` clean; eslint clean on every file I touched. The real build (`tsc -p tsconfig.build.json`, `copy-mods.mjs`) gives `index.js` + `mod.json` per mod
and nothing else, and the built `reins doctor --no-probe`, `reins check` and `reins print` load and use the pack (see "Verified on the built product").

## What moved

| Old | New |
|---|---|
| `core/src/nodes/{say,phase,end}.ts` and `*.view.ts` | deleted. `packages/server/src/mods/<kind>/index.ts` calls `api.registerBlock(node)`; the view is JSON under `view` in `mod.json` |
| `nodes/index.ts`: 3 imports, 3 list entries, `phaseNode`/`sayNode`/`endNode` exports | removed (the registry list keeps the other ten with their numbers) |
| `views.ts`: 3 imports, 3 entries in `BUILTIN_VIEWS` | removed (10 core views left; the three are served from the manifests) |
| `declare module '../model.js' { interface NodeKinds ... }` in each file | `declare module '@reins/core'` in each mod's `index.ts` (root and app typecheck still see the names) |
| `tags.ts:22`, `:83` `NODES.get('phase')` | `NodeType.chatTurn` (new flag, below). The two allowlist lines in `no-kind-branch.test.ts` are gone |

Manifests (order is the number the kind has in core's registry today; the view keeps its own `order`, so `end` is registry 130, view 120, as before):

| mod | `order` | `required` | `provides` | view order |
|---|---|---|---|---|
| `phase` | 10 | true | kinds `phase`, attrs `mode` | 10 |
| `say` | 20 | no | kinds `say`, attrs `mode` | 20 |
| `end` | 130 | true | kinds `end` | 120 |

All three have `"pack": "default"`, `"main": "index.js"`, `"kind": "block"`, no `ops`, no `events`.

### `api.core` additions: none
`say` needs `checkMode` and `turnInstr` (already there). `phase` also needs `slugify` (core's `util.ts`): I did NOT add it to `api.core` (every addition is a security surface and a pinned test names the frozen three).
`phase/index.ts` carries its own one-line copy. A pin runs titles with trailing dashes, punctuation and a 120-character title through it, so a drift from core's `slugify` is red.

### New in core and the loader (each is small, each is tested)
1. `NodeType.chatTurn?: true`: the block a chat message is wrapped in. The chat tags (`server/src/tags.ts`) build `## <kind> prompt` for the first kind in `order` that has it, and read that kind's `attrs` as the attribute tags. `phase` sets it. Text of a chat message is byte for byte as before.
2. Only the pack may claim it. In the loader (`DOORS.registerBlock.put`) `chatTurn` is dropped unless the mod is `pack: "default"` or a copy that covers one of the built-in's own kinds (`mayShadow`). Without this a user mod with `order: 1` and `chatTurn: true` would wrap every chat message in its own block. A Customize copy of `phase` keeps it (tested, also after the restart).
3. `ModInfo.pack` (core `nodes/index.ts`, `guard.ts`): set only by the loader (`nodeCopy`) from a bundled `pack: "default"` manifest. For such a node the guard does not cut the heading text and the default id (`fit()`); for every other mod they stay one capped line (200 / 80). See "What the plan got wrong", point 3.
4. `viewShape.ts`: `view.stops` is allowed on the kind named `end`, in or out of a mod scope (was: core only). It is safe because a mod can bring the name `end` only as the pack's own block or a Customize copy of it: the registry refuses a second `end`. A view with `stops` on any other kind is still refused (app and server pins hold).

## THE BIG RISK: who needs the pack now (found first)

After the move a kind exists only while the pack is loaded. I grepped every parser/validator/`NODES.get` entry point and ran the three suites.

**Production entry points (all already call the loader, nothing to change):**
- `cli.ts main()` calls `startMods` before every command except `--version`: `reins check`, `print`, `run`, `run --resume`, `serve`, `doctor`, bare `reins`.
- `server.ts startServer` calls `startMods` unless the caller hands it `mods` (only tests do).
- `engines.ts startMods` reads `BUNDLED_MODS` (`src/mods` under tests, `dist/mods` in the build).
- Checked on the BUILT cli with a temp `REINS_HOME`: `doctor --no-probe` lists `end`, `phase`, `say` first (bundled, ok); `check` on a file with all three says `ok`; `print` prints it.

**Tests (the risk):**
- core: nothing to do. `setup-pack.ts` (Task 1) already registers every pack mod with its manifest `order`.
- server tests that parse, validate or run workflows with no loader of their own: a new helper `packages/server/test/pack-helper.ts`.
- app tests: the setup file now loads the pack the way the server does.

**The helpers (the pattern for Tasks 4 to 8):**
- Server: `usePack()` (beforeAll/afterAll for a file or a describe) and `loadPack()` / `.off()` (by hand). It is `startMods` over the real bundled folder in a temp home, so kinds are registered with their manifest order and guarded exactly as in production. It throws "The default pack did not load: ..." if any pack mod has a problem.
- App: `packages/app/test/app-pack.ts` loads the pack once per file (top-level await, `startMods`, temp home removed at once) and exports `served()` = `servedKinds(mods)`. `setup-kinds.ts` fills `KINDS`, conditions, cards and questions from `served()`. A test that wants "the list the setup made" calls `served()`; `servedKinds()` with no argument is only core's own views now.
- The server project still has NO global setup (a global registration would make every `startMods` say "already registered"; Task 1 pins this). One rule follows and I hit it three times: **a test file must not load the pack twice at once.** A file that calls `startMods`/`boot` itself already has the pack; a file that calls `usePack()` must not also start the real loader in the same scope. Where a file did both I scoped `usePack` (pack-customize, p29a-approval), gave the second loader an empty bundled dir (toy-block `start()`), disposed the first world before the next `boot` in a loop (mods-keys), or left the pack's rows out of an assertion (provider-switch, toy-block-import).
- `vi.resetModules()` makes a second copy of core: `p29a2-nonce` loads the pack inside the test, after the reset, with `onTestFinished`.

### Server and app tests migrated (all listed; each needed it, nothing else was edited)
`usePack()` added (the file parses/validates/runs `phase`/`say`/`end` without a loader): drive, m2-fix-c, m2-track-sessions, m2-track-sessions-fix, m3-task-2-mod-events, m3-task-2-moves, m3-task-2-session, p29a2-display, p29b-compaction, p29d-display, p29d-money, recover, run-cli, run-cli-golden, run-cli-unpriced, session, session-tracks, session-usd-room, store, tags, toy-ask, toy-block, toy-kind, pack-loader. Scoped: p29a-approval (the terminal describe), pack-customize (every describe except "the real bundled folder"). In test: p29a2-nonce (after `vi.resetModules()`).
Other edits, each because the pack is now part of what a loader returns:
- `claude-mod.test.ts`: the exact list of loaded mods now starts with `end`, `phase`, `say` (blocks load before protocols).
- `kinds-route.test.ts`: "13 views of core" is now 10 core views + 3 manifests' views; `servedKinds()` with no mods is the 10; "a mod view cannot take the place of a built-in kind" tests `gate` (a core kind) and says a pack kind is refused by the registry itself ("block-view "say" is already registered").
- `mods-keys.test.ts`: two tests boot twice in a loop; `w.mods.dispose()` at the end of each round.
- `provider-switch.test.ts`: the second loader of the file leaves the pack's own rows out of its "no problems" check (the first world still holds the pack).
- `toy-block-import.test.ts`: the "no block listed" check ignores `pack` rows. `toy-block.test.ts`: `start()` reads only the home's own mods (the pack comes from `usePack`).
- app: `m2-fix-25a-a.test.ts` and `unknownKind.test.ts` restore with `served()` instead of `servedKinds()` (the old call dropped the pack's kinds and cascaded); `views.test.ts` (a), (b), (c) count the view files of the kinds that are NOT in the pack and assert the pack kinds have none.
- core: `op-registry.test.ts` read `phaseNode` from core's index (gone): it reads `NODES.get('phase')`. `nodes-registry.test.ts` gains the pack section the brief asks for. `no-kind-branch.test.ts`: the two allowlist lines.
- `packages/server/test-dist/check.ts` (the CI dist check, not a vitest test) said `'phase' satisfies StepKind`; it now merges its own kind into `NodeKinds` and checks that. `tsc -p packages/server/tsconfig.dist-check.json` passes.
- Fragile but not edited: `app/test/m3-task-2-view-events.test.ts` restores with `setKinds(servedKinds().kinds)` (no pack kinds). It passes, but leaves `KINDS` without the three for the rest of that file.

## Core with no pack at all (the decision, made from the code)

An empty registry is safe, so the loader does NOT refuse to start. Reading the code:
- `END`, `TURN`, `JUMP`, `NODE` are core instructions (`CORE_OPS`); `compile.ts:165` pushes a final `END` itself. A workflow with no step compiles to `END` and a run of it finishes. Core needs neither `end` nor `phase` to run.
- A step of a kind nobody registered is an ERROR in `parseWorkflow` and again in `validate` ("Unknown step kind "phase""), so no program is made from it; `reins check` prints it with the file and line and exits 1; `reins run` runs nothing.
- The one place that built a step by name was the chat tags. With no `chatTurn` block they now return `No block that takes a turn is installed, so a chat message cannot be wrapped in one. The default pack is missing: reinstall Reins.` and build nothing (`taggedWorkflow` carries the same words; the tag list has no attribute tag).
- Why not a loader refusal: "required" is declared in a mod's own manifest, so a folder that is gone declares nothing. Refusing would need a list of ids in the loader, which is the hardcoding this move removes. The words appear where the user meets the problem.
- Tests (`m3-task-3-empty-pack.test.ts`, 6): empty registry has none of the three and loads with no problem; the parse and `validate` words and severity; an empty workflow compiles to `END` and finishes; `loadWorkflow`/`formatDiagnostic` and `startRunCli` (the fake engine gets no turn); the chat tags and `taggedWorkflow`; the served list is the 10 core views with no problem.
- Related: `end` and `phase` stay on. The Settings off switch is refused (409, Task 1), a hand-edited `disabled-mods.json` is ignored for them, and `pack-mods.test.ts` runs both for every required pack mod.

## What the three requested items became

(a) Written once, generic over the pack folder (`packages/server/test/pack-mods.test.ts`, 18 tests; Tasks 4 to 8 add folders and change nothing): the pack is found by `"pack": "default"` in `mod.json`; only `end` and `phase` are `required` (the one constant to touch if that ever changes is `REQUIRED`); each pack mod has the manifest the machinery needs, a flat source folder with no import that leaves it (`packProblems`), and BUILDS flat (the folder is compiled file by file with `typescript`, then: only `*.js` and `mod.json`, no folder, no `.d.ts`, no `.map`, within 50 files and 1 MB, strict UTF-8, no NUL, `main` is one of the files); with the real loader each is bundled, trusted, enabled, no problem, read from its own folder, nothing in `mod-cache`, in core at its manifest order; a non-required one switched off is gone after a restart and says "Unknown step kind"; a required one refuses the switch and ignores a hand-edited off list; **Customize works from the built folder** (copy made through the import path, restart, runs from `mod-cache`, replaces the built-in, keeps neither `pack` nor `required` in the copy, still `pack: default`, still required where it was); and the helper itself.
The real `tsc` output was compared by hand with the `typescript` transpile once (see "Verified on the built product"); the test uses the transpile so it needs no build.

(b) `BUNDLED_MODS` is already data-driven; I changed nothing in `engines.ts` or `copy-mods.mjs`. `BUNDLED_MODS` is a folder, the loader scans every folder in it, `pack`/`required` come from each manifest, and `copy-mods.mjs` copies every `mod.json` it finds under `src/mods` and fails if the counts differ. There is no list of pack folders anywhere; `core/test/pack.ts` finds them by the same `"pack": "default"` rule. A test pins "found by the manifest, not by a list".

(c) The helpers and the migration list are above.

## Tests

New (all green):
- `server/test/m3-task-3-pin.test.ts` + `m3-task-3-pin.expected.json`: the PIN. Through the real loader, for 4 workflows (one long and odd titles, say with a mode, an end before an unreachable phase, an end in a repeat, a file full of errors): parse, printed text (round trip), diagnostics, compiled program (full JSON, `src` included), the events and the receipt of three runs with a fake engine and a fixed clock, 9 chat-tag cases, the tag catalogue, the served order of all 13 kinds and the 3 served views. The expected file was recorded at HEAD (`PIN_WRITE=1`, before any move) and passes unchanged now.
- `server/test/pack-mods.test.ts` (18), `m3-task-3-empty-pack.test.ts` (6), `m3-task-3-moves.test.ts` (8): the chat turn is the flagged block (also under another name: a pack whose turn kind is `turnx` gets `## turnx prompt`); a user mod claiming `chatTurn` at a lower order is dropped to no flag; a user mod cannot take the name or the face (`phase`, `say`, `end`, with `stops`); `stops` only on `end`; a Customize copy of `phase` stays the turn after the restart, and a copy edited to drop the flag leaves the tags with the clear words; long titles (12, 40, 90 words) keep their id and print back byte for byte, and a Customize copy's heading is capped like any user mod's; `end` warns for a link, a card or a prompt each and not for a bare end; each block's attributes.
- core `nodes-registry.test.ts`: every pack block is in `NODES` at its manifest order (4 new tests).

### Red at HEAD
I exported HEAD with `git archive` to a scratch folder (node_modules by junction), copied in the new test files and the helper, and ran them (the scratch folder and its junctions are removed):
- `m3-task-3-pin`: green at HEAD (it is the pin; it must be).
- `m3-task-3-empty-pack`: 5 of 6 red (the registry is not empty at HEAD). The 6th, "an empty workflow compiles", is green at HEAD by nature (core already did that).
- `m3-task-3-moves`: 5 of 8 red (`chatTurn` does not exist; `stops` for a mod; the turn kind by flag; the pack's blocks). Green at HEAD by design (they pin behaviour that did not change): a user mod cannot take a pack name (core owned it), the long-title round trip, the end warnings.
- `pack-mods`: the two pack-level tests red (no pack folders at HEAD); the loader tests are vacuous with an empty pack at HEAD and green, as the first test of the file shows by being red.
- The migrated tests are not red at HEAD (they only gained `usePack()`); a full server run right after the move showed which needed it (about 30 files red, listed above).

## Mutation round (rule 4)

39 hand-applied breaks, each by replacing one string, running the named files, writing the original bytes back and comparing SHA-256 (`restored=true` every time). No git command. Scratch scripts were in `spike/tmp` (gitignored) and are deleted.

| # | break | first red test |
|---|---|---|
| S1 | say compiles to nothing | pin |
| S2 | say drops its `checkMode` | pin (bad mode) |
| S3 | say `attrs: []` | SURVIVED first. `attrs` of `say` is read only through the union of all kinds (`nodeAttrs`), and phase lists `mode` too, so it was not observable. A test now pins the three attribute lists; red as S3b |
| S4 | say manifest `order` 20 to 35 | pin (kind order) |
| P1 | slug keeps the trailing dash | pin (`odd-title-v2`) |
| P2 | heading prints `phase` without the title | moves (long title round trip) |
| P3 | the empty-prompt warning words change | pin |
| P4 | phase loses `chatTurn` | moves, tags (4) |
| P5 | heading parse does not read the title | moves, pin |
| P6 | no default id from the title | moves, pin |
| E1 | end compiles to nothing | pin |
| E2 | end warning ignores a card | moves (end warns) |
| E3 | end warning ignores a prompt | moves (end warns) |
| E4 | `end` not required | pack-mods "only end and phase are required" |
| E5 | end view loses `stops` | moves |
| E6 | `phase` not required | pack-mods |
| M01 | loader never drops a claimed `chatTurn` | moves (hijack) |
| M02 | loader drops it for the pack too | moves, tags, pin |
| M03 | loader drops it for a Customize copy | moves (copy keeps the turn) |
| M04 | guard never trusts the pack (cuts titles) | moves (long title) |
| M05 | loader does not pass `pack` to the guard | moves |
| M06a, b | `stops` allowed on any kind | moves (server), app `m2-fix-25a-a` |
| M07 | no clear refusal without a turn block | empty-pack |
| M08 | chat text always says `phase` | moves (`turnx`) |
| M09 | chat turn found by the name `phase` | moves (`turnx`, copy) |
| M10 | core test setup drops the manifest `order` | nodes-registry, setup-pack, kind-order |
| M11 | app `views.test` reads no pack kinds | views (a) |
| M13 | a folder inside a pack mod | pack-mods (flat) |
| M14 | a pack mod imports `fs` (outside the folder) | pack-mods |
| M15 | `say` loses `"pack": "default"` | pack-mods |
| M16 | `phase` manifest does not list `attrs` | the loader refuses the block: 10 tests |
| M17 | app setup fills no kinds | 45 app tests |
| M18 | default id cut at 80 for the pack | moves |
| M19 | heading cut at 200 for the pack | moves |
| M20 | `loadPack` does not throw on a problem | pack-mods (helper) |
| M21b | core setup skips the `end` mod | nodes-registry |
| M22, M23 | `NODES.get('phase')` back in `tags.ts` (both places) | the no-kind-branch guard |

Per kind: say 4, phase 6, end 6; shared 23. Survivors: S3 (gone, see above). An equivalent I did not mutate: the "first `chatTurn` in order" tie break (only one block has the flag); a test with two flagged pack blocks would be needed, none exists.

## Existing tests edited (with the reason)
All listed above under "migrated". In short: `no-kind-branch` (the brief), `nodes-registry` (the brief), `op-registry` (`phaseNode`), `kinds-route`, `claude-mod`, `mods-keys`, `provider-switch`, `toy-block-import`, `toy-block`, `p29a2-nonce`, `p29a-approval`, `pack-customize`, `pack-loader`, app `m2-fix-25a-a`, `unknownKind`, `views`, and the 20 or so files that only gained `usePack()`. No golden, no `*.browser.test.ts`, no `vitest.config.ts`, no lockfile or `package.json` touched. `packages/app/tsconfig.json` and `packages/server/test-dist/check.ts` were edited (below).

## What the plan got wrong or left open
1. The common brief says "the app tsconfig includes `../server/src/mods/*/index.ts`". It did not (`include` was `src`, `test`, `vite.config.ts`). Without it the app program does not see `declare module '@reins/core'` from the mods and ~40 app test lines fail to typecheck. I added the one entry; `tsc -p packages/app` is clean.
2. `NodeType.chatTurn` did not exist; the plan named it as if it did. Built here, with the loader rule that only the pack may claim it.
3. The guard cuts a mod node's heading text at 200 characters and its default id at 80 (M2 Task 16c). Both are the USER's data for `phase` (a title, the id made from it, which links in saved files name). At HEAD a 120-character title printed whole and had a 120-character id; after a plain move the title was cut on save and the id became `...`, so links to it stopped matching. The pin caught both (the first run was red). Fixed with `ModInfo.pack` and `fit()`. `m2`'s `mod-contain` pin (a hostile 5000-character heading is cut under 220) stays green for every other mod. Tasks 4 to 8: `print`/`count` lines have the same cut (300 / 40) and `repeat` prints a condition in its heading; if a pin goes red for that, `fit()` is the place.
4. `view.stops` was core-only (`viewShape.ts`), so the `end` mod was refused by its own manifest check ("a mod's block cannot end the workflow"). See "New in core" point 4. The plan did not list it.
5. `kinds-view.ts` `taken` (and `questions/index.ts`) read `BUILTIN_VIEWS`, so "a mod cannot give a view to a built-in block" no longer names the pack kinds. The registry still refuses a second view or kind of the same name ("already registered"), which is what protects `say`/`phase`/`end` now (tested, with the hostile `stops` view). Task 4 (`gate`) meets the question-card name check in `questionRefusal` the same way.
6. Task 1's report said Customize works from the built folder; it is verified here for real pack mods (the generic test).
7. Documentation not updated (Task 15 owns it): `core/src/nodes/README.md` still lists "built-in blocks use these numbers: phase 10, say 20 ..." (true as registry numbers) and the "Built in" two-file recipe; `packages/server/src/mods/README.md` does not mention `chatTurn` or the pack's `fit`.

## Verified on the built product
- `npm run build -w @reins/core` and, in `packages/server`, `tsc -p tsconfig.build.json` and `node copy-mods.mjs` (7 mods copied) run clean. They rewrote the ignored `dist` folders. `dist/mods/say`, `phase`, `end` hold exactly `index.js` and `mod.json` (287 + 658, 1215 + 799, 686 + 469 bytes). The declaration merges are erased; `index.js` imports nothing.
- With a temp `REINS_HOME`: `node dist/cli.js doctor --no-probe` lists `end`, `phase`, `say` (block, bundled, ok); `check` on a workflow with a phase, a say and an end prints `ok` (exit 0); `print` prints it.
- `tsc -p packages/server/tsconfig.dist-check.json` (the CI step) exits 0.
- Not run: the browser tests (`*.browser.test.ts`) and the live tests (`test/live`). They are not in the vitest projects I ran, and a browser would show the canvas from the served list, which `kinds-route` and `m3-task-3-pin` cover without one.

## Open for Tasks 4 to 8 (the checklist this task sets)
1. Folder `packages/server/src/mods/<kind>/` with `index.ts` + `mod.json` (`order` = today's registry number, `provides` kinds/ops/attrs/events, `"pack": "default"`, the view as JSON). Own helpers go in the same folder (flat); nothing imported outside it except `import type` (the guard `packProblems` and the generic test check this).
2. Delete the core `<kind>.ts`, `<kind>.view.ts`, its import, list entry and export in `nodes/index.ts`, `views.ts`; the `declare module '@reins/core'` merge goes into the mod.
3. If the kind has events: add them to `provides.events`, delete them from `RunEvents` and `CORE_EVENTS` and from the guard's allowlist lines, and edit `m2-fix-25a-a.test.ts` (it pins the two lists equal). Task 2 already moved the event-specific code behind `count`/`print`/`view.status`/`view.hidden`.
4. Run the three suites. Any server test that parses a workflow with the kind and has no loader gets `usePack()`; a file that already loads the real pack must not load it twice. Any app test needs nothing (the setup loads the pack). Edit `pack-mods.test.ts` only if a kind becomes required.
5. Pins to watch: the guard caps in `guard.ts` (`fit`), `questionRefusal` for kinds that are also question cards (`gate`), `api.core` (a kind that needs more than `checkMode`/`turnInstr`/`policyOf`: add the smallest frozen helper and say why; `repeat` in Task 6 needs the kind and condition lookups, see Task 2's report point 3).
6. The helper in `m3-task-3-pin.test.ts` re-records with `PIN_WRITE=1`; only ever do that at a commit where the answer is known to be right.

## `git status --short` (my files)

```
 M packages/app/test/m2-fix-25a-a.test.ts
 M packages/app/test/setup-kinds.ts
 M packages/app/test/unknownKind.test.ts
 M packages/app/test/views.test.ts
 M packages/app/tsconfig.json
 M packages/core/src/guard.ts
 D packages/core/src/nodes/end.ts
 D packages/core/src/nodes/end.view.ts
 M packages/core/src/nodes/index.ts
 D packages/core/src/nodes/phase.ts
 D packages/core/src/nodes/phase.view.ts
 D packages/core/src/nodes/say.ts
 D packages/core/src/nodes/say.view.ts
 M packages/core/src/viewShape.ts
 M packages/core/src/views.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/core/test/nodes-registry.test.ts
 M packages/core/test/op-registry.test.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/tags.ts
 M packages/server/test-dist/check.ts
 M packages/server/test/claude-mod.test.ts
 M packages/server/test/drive.test.ts
 M packages/server/test/kinds-route.test.ts
 M packages/server/test/m2-fix-c.test.ts
 M packages/server/test/m2-track-sessions-fix.test.ts
 M packages/server/test/m2-track-sessions.test.ts
 M packages/server/test/m3-task-2-mod-events.test.ts
 M packages/server/test/m3-task-2-moves.test.ts
 M packages/server/test/m3-task-2-session.test.ts
 M packages/server/test/mods-keys.test.ts
 M packages/server/test/p29a-approval.test.ts
 M packages/server/test/p29a2-display.test.ts
 M packages/server/test/p29a2-nonce.test.ts
 M packages/server/test/p29b-compaction.test.ts
 M packages/server/test/p29d-display.test.ts
 M packages/server/test/p29d-money.test.ts
 M packages/server/test/pack-customize.test.ts
 M packages/server/test/pack-loader.test.ts
 M packages/server/test/provider-switch.test.ts
 M packages/server/test/recover.test.ts
 M packages/server/test/run-cli-golden.test.ts
 M packages/server/test/run-cli-unpriced.test.ts
 M packages/server/test/run-cli.test.ts
 M packages/server/test/session-tracks.test.ts
 M packages/server/test/session-usd-room.test.ts
 M packages/server/test/session.test.ts
 M packages/server/test/store.test.ts
 M packages/server/test/tags.test.ts
 M packages/server/test/toy-ask.test.ts
 M packages/server/test/toy-block-import.test.ts
 M packages/server/test/toy-block.test.ts
 M packages/server/test/toy-kind.test.ts
?? docs/plan/m3-task-3-report.md
?? packages/app/test/app-pack.ts
?? packages/server/src/mods/end/
?? packages/server/src/mods/phase/
?? packages/server/src/mods/say/
?? packages/server/test/m3-task-3-empty-pack.test.ts
?? packages/server/test/m3-task-3-moves.test.ts
?? packages/server/test/m3-task-3-pin.expected.json
?? packages/server/test/m3-task-3-pin.test.ts
?? packages/server/test/pack-helper.ts
?? packages/server/test/pack-mods.test.ts
```

Line endings: every file I edited keeps its own (checked by bytes: no file has mixed endings; `viewShape.ts`, `m2-fix-25a-a` (app) and the three `m3-task-2-*` tests are LF, the rest CRLF; the new mod files are CRLF like their siblings, the new test files LF). No U+2014 in any file I touched or wrote.
