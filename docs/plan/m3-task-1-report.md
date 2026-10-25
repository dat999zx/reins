# M3 Task 1: pack folders, Customize, required mods, core test setup

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 0421a1c. Nothing committed, added, stashed, reset, checked out or pushed. The pack is still empty: no existing kind moved, and no product pack mod was added. Every pack mod in the tests is made at run time (`tempHome`, `mkdtemp`).

## What I built

**Loader (`packages/server/src/mods/loader.ts`, `types.ts`)**
- `pack` and `required` in `mod.json`. A bundled mod may say `"pack": "default"` and `"required": true` (nothing else is accepted, with words). A USER mod that says either, with any value (`true`, `false`, `null`, another string), is refused with words in `commonProblems`. That function is the one `validateMod` runs, so import preview and import apply refuse it too.
- `LoadedMod` gains `pack`, `required` and `builtinVersion`. `required` is by id: the user copy of a required bundled id is required too.
- Required ids ignore the off list. A hand-edited `disabled-mods.json` that names one is ignored, and the mod gets one line: "`end`: is required, so it stays on. Reins ignored the switch-off in disabled-mods.json." Settings shows that line as news (a notice), not as a fault, so the row does not read "invalid".
- Shadowing fix (review MINOR 9). `replacing` no longer shadows everything. `mayShadow(was, id)` lets a user copy cover only: the built-in's own record, the `block-view`, `cond-view` and `card-view` entries named in the built-in's own `provides.kinds`, `.conditions`, `.cards`, and the protocol named like the mod. The three doors (`registerBlock`, `registerCondition`, `registerCard`) pass `shadow` per name. Ops need no shadow rule: core's "op already brought by kind X" already refuses an op of another kind. A copy that registers another pack kind, a core kind, or another mod's view, condition, card or protocol is refused with the existing "could not replace the built-in; the built-in stays" line.
- Carry keys. The carry map was keyed `<kind>:<id>` for both the built-in and its user copy. With a bundled startOnly mod that is one slot for two mods: the second `carry.set` overwrote the first one's undo (the built-in's registrations then never came out at dispose), and the next reload tried to record the same `block-view` twice and threw. M2 never met it because no bundled mod was startOnly. A bundled mod's key is now `bundled:<kind>:<id>`; user keys are unchanged (an M2 pin holds them). The stand-in loop strips the prefix.
- A user copy of a built-in that is already in core waits for a restart on a live reload ("pending"): nothing is copied to the cache or imported, the list shows the copy in place of the built-in (`replaces: 'bundled'`) with the line "applies after a restart", and core keeps running the built-in. After a restart (empty carry) the copy loads fresh, runs from `mod-cache`, shadows the built-in, and replaces it in the list. A reload after that records both from the carry with no clash.
- `builtinVersion` (the built-in's `version`) is set on a copy that replaces a built-in, and `pack` is inherited from it.

**Settings actions (`actions.ts`, route in `server.ts`)**
- `listMods` returns `pack: [{ id, label, enabled, required }]` (the first-run pack line), and each row may carry `pack`, `required`, `builtinVersion` and `newer`. `newer` is `isNewer(builtinVersion, version)`: dotted numbers (1 to 4 parts, up to 9 digits each), compared left to right, so 1.10.0 is newer than 1.9.0. Anything else is never "newer".
- `setEnabled(id, false)` on a required mod is a 409 with words and writes nothing.
- Customize: `GET /api/mods/:id/customize` returns the file it would import. `POST /api/mods/:id/customize` (body may hold only `trust`) imports it. Both build the file from the BUNDLED folder with `readFolder` (a link anywhere is refused), decode each file as strict UTF-8, remove `pack` and `required` from `mod.json`, and hand the result to `importApply` with `replaceBuiltin: true` and a new internal `newOnly: true`. So names, count, 1 MB, binary text, keys, the manifest check, the code prompt and the trust record are the import's own. The refusal of a hostile file is word for word the refusal of a plain import of the same files (a test compares the two bodies).
- `newOnly` makes the import itself refuse (409, "You already have your own copy") when a copy of the user's exists. The check runs inside the import's serial turn, so a copy made between Customize's read and write is never replaced.
- Lookups for a change to one mod (`removeMod`, `trustMod`, `reinstallMod`, `editMod`, `exportMod`, and the `trust` word in the import reply) use `entry()`: the user's copy first. Before, a failed or untrusted copy listed beside its built-in made `Remove` and `Trust` find the built-in ("is built in and cannot be removed").

**Test seam**: `startMods({ dir, env, bundledDir? })` (engines.ts). Production never passes it.

**App**: `providersStatus.ts` (`canDisable`, `canCustomize`, `newer`, `otherMeta` words), `Providers.tsx` (no Disable button for a required row, a Customize button for a built-in pack mod, the key of a row is `id:bundled`), `ImportSummary.tsx` (`ImportPanel` takes `initial`, so Customize opens the normal import dialog on the copy: preview, code prompt, built-in confirm), `FirstRun.tsx` and `firstRunCards.ts` (the pack line: a switch per mod, the switch of a required mod is disabled and the row is forced on), `App.tsx` (passes `pack` to `FirstRun`).

**Core test setup**: `packages/core/test/pack.ts` (`packMods`, `registerPack`, `packProblems`), `setup-pack.ts` (runs `registerPack(PACK_DIR)`; sets `globalThis.__packSetup` so tests can see which project ran it). `registerPack` activates each `pack: "default"` mod under `packages/server/src/mods/` in folder order through a test api (`registerBlock`, `registerCondition`, `registerCard` pass the manifest `order`; `core` is the frozen three), finds `index.ts` when `main` says `index.js`, and undoes everything on a failure. `packProblems(dir)` is the guard for Tasks 3 to 8: a pack mod must be flat and import nothing outside its folder except `node:` modules, `./file`, and type imports (erased at compile).

### The reviewed edit to `vitest.config.ts` (approved in the brief)

```diff
-    // The app's setup fills its kinds from the same builder the server's `GET /api/kinds` uses; core and server have none yet.
+    // The app's setup fills its kinds from the same builder the server's `GET /api/kinds` uses; core's registers the default pack (M3 Task 1); the server has none.
     projects: [
-      { extends: true, test: { name: 'core', include: ['packages/core/test/**/*.test.ts'] } },
+      { extends: true, test: { name: 'core', include: ['packages/core/test/**/*.test.ts'], setupFiles: ['packages/core/test/setup-pack.ts'] } },
       { extends: true, test: { name: 'server', ...unchanged } },
       { extends: true, test: { name: 'app', ...unchanged } },
```

The server project has no setup. A test pins both facts (`__packSetup` is set in core, unset in server and app, and the config shape is read back).

## Tests (all new files; nothing red is left)

| file | tests |
|---|---|
| `packages/server/test/pack-loader.test.ts` | 34 |
| `packages/server/test/pack-customize.test.ts` | 25 |
| `packages/core/test/setup-pack.test.ts` | 9 |
| `packages/app/test/packLine.test.ts` | 9 |

Run result after the last edit: those four files plus 14 pin files (mods-loader, mods-import, mods-api, toy-block, toy-ask, toy-provider, p29c-import, toy-block-import, app firstRun, providersStatus, importSummary, importSummaryKinds, core wires, nodes-registry): 18 files, 505 tests, all green. `tsc --noEmit` (root) and `tsc --noEmit -p packages/app` clean. eslint on every touched file clean.

Hostile cases written first: a user mod claiming `pack` or `required` (six variants), a Customize id with `..` (and `../x`, `a/b`, `a\b`, empty, 41 characters, `con`, upper case, numbers, null, objects), Customize while the user copy exists (before and after a restart, and the race through `importApply` with `newOnly`), a hand-edited off list naming a required id (loader and Settings), a hostile file in the built-in folder (binary, over 1 MB, a folder, a leading-dot name, a known key, 53 files, a link, bytes that are not UTF-8, a manifest the import refuses), a copy that registers a core kind, another pack kind, another mod's view, condition, card or protocol.

### Red at HEAD

I exported HEAD (`git archive`) to a temp folder, copied in my new test files and helpers, and added only the `bundledDir` seam so the product behaviour decides red or green. Results:

- `pack-customize.test.ts`: 25 of 25 red (no Customize, no `pack` in the list, no `isNewer`, no required refusal, no route).
- `pack-loader.test.ts`: 25 red, 7 green at HEAD. Green at HEAD: an empty pack loads; a pack mod registers at its manifest order; switching off removes the kind after a restart (the M2 carry rule already did that); an id that is not required is still switched off; a switched-off other id does not keep a required one on; dispose takes both out; why the server project has no global registration (surprise 4). The red ones are: bundled and trusted with `pack`, bundled manifest checks, required stays on, all six user claims, the claim of a bundled required id, the control copy, every shadow-limit test, and every pending / restart / reload test. (Later I added the protocol test and the stand-in test; both are red without the matching change, see M12 and M20.)
- `packLine.test.ts`: 6 of 7 red at HEAD; the green one is "no pack line when the pack is empty". (The two later tests, the dialog `initial` and "app has no pack setup", were added after this run; M45 shows the first is red without the change.)
- `setup-pack.test.ts`: the file tests new helper files, so at HEAD it is green only once `pack.ts` exists. The per-project pin (`__packSetup`, config shape) and the guard tests were added later; M38 and M39 show the pin is red when the config is wrong.

## Mutation round (rule 4)

54 hand-applied breaks, each by replacing one string with a throwaway script under `spike/tmp/` (gitignored, deleted after), running the named test files, writing the original bytes back and comparing SHA-256 before and after (`restored=true` for every one). No git command. Every one went red. One survived its first run (M20) and got a test.

| # | break | first red test |
|---|---|---|
| M01 | user claim check refuses only `true` | pack-loader: "pack: refused with words" and 4 more |
| M02 | user claim check no longer looks at `pack` | pack-loader: the three `pack` claims |
| M03 | bundled `pack` value not checked | "a bundled manifest must say pack default and required true" |
| M04 | bundled `required: false` not refused | same test |
| M05 | required id obeys the off list | "a required id stays on when a hand-edited off list names it" and the customize copy |
| M06 | required set built from nothing | pack list, Settings refusal, 4 more |
| M07 | the "stays on" line never written | loader and Settings notice tests |
| M08 | view shadow allowed for any name | another kind, phase, view, 3 more |
| M09 | block door always shadows | another kind, phase, op |
| M10 | condition door always shadows | "a copy of a condition mod cannot cover another's atom" |
| M11 | card door always shadows | same for a card |
| M12 | protocol-impl shadows any id | "a copy of a protocol mod covers its own, not another's" |
| M13 | a copy activates live on a reload | "on a live reload the copy waits for a restart" |
| M14 | pending reads this load's carry | 17 tests (the restart flows) |
| M15 | built-in and copy share one carry key | 18 tests |
| M16 | built-in stays listed beside its copy | 9 tests |
| M17 | `builtinVersion` not recorded | "the built-in is newer" and the pending test |
| M18 | copy does not inherit `pack` | required copy, waiting row, 1 more |
| M19 | a carried copy recorded without shadow | "after a restart the copy runs ... a reload after that keeps both" |
| M20 | stand-in ignores the `bundled:` prefix | SURVIVED at first; "a built-in whose folder is gone on a reload ..." added, now red |
| M21 | Settings disables a required mod | the refusal test, required copy, 1 more |
| M22 | Customize keeps `pack` | 10 tests |
| M23 | Customize keeps `required` | file test, required copy |
| M24 | import turn ignores `newOnly` | "the check no copy of yours is made inside the import turn" |
| M25 | Customize accepts a mod outside the pack | file test, HTTP test |
| M26 | `isNewer` compares the wrong way | unit test, "the built-in is newer" |
| M27 | lookups take the built-in first | the needs-trust flow, edited-copy flow |
| M28 | pack line lists only optional mods | pack list, hand-edit test, 1 more |
| M29 | required line counted as a fault | hand-edit test |
| M30 | Customize accepts other request fields | "a request may only say trust" |
| M31 | Customize without the built-in confirm | 7 tests |
| M32 | Customize skips the own-copy check before reading | "a Customize while the user copy exists is refused" |
| M33 | customize route gone | HTTP test |
| M34 | `startMods` ignores `bundledDir` | 22 tests |
| M35 | core setup drops the manifest `order` | 3 tests |
| M36 | core setup keeps no disposer | 4 tests |
| M37 | core setup takes mods that are not in the pack | whole file fails to run (the setup throws on a non-pack manifest); red, but a file-level red |
| M38 | core project loses the setup file | "the core project ran it" |
| M39 | server project gets the setup file | the same test and the real-BUNDLED_MODS test |
| M40 | first-run switch of a required mod is enabled | "shows the line and a switch per mod" |
| M41 | required row not forced on | "rows: a required mod is shown on and locked" |
| M42 | required row keeps Disable | "no Disable button" |
| M43 | every bundled mod offers Customize | "a built-in pack mod offers Customize" |
| M44 | "the built-in is newer" never shown | "a copy that has fallen behind says..." |
| M45 | import dialog ignores the chosen file | "opens on the copy of the built-in" |
| M46 | Customize drops the trust choice | 4 tests |
| M47 | a carried copy not settled into the list | "after a restart the copy runs ... reload" |
| M48 | Customize does not check the id shape | file test, HTTP test |
| M49 to M54 | guard `packProblems`: refuses `node:`, lets `./../x` through, reads type imports as value imports, ignores subfolders, misses dynamic import, misses `require` | "what the check refuses, and what it lets through" |

Equivalence note: the own-copy check in `customizeSource` (M32) and the `newOnly` check inside the import (M24) overlap on purpose. Each alone is caught by a different test (the first by the sequential test, the second by the race test); removing both is not tested because the import's own "replaces your copy" would then overwrite the copy.

## Decisions

1. **Q1**: the pack ships built in and trusted (a bundled mod, loaded from its own folder, not copied to the cache). Customize makes the user copy.
2. **`pack` and `required` are stripped from a Customize copy.** A user mod may not claim them, and the copy goes through the same check as an import. The copy keeps the pack through the loader (it inherits `pack` from the built-in it replaces, and `required` is by id).
3. **A user copy waits for a restart on a live reload** instead of shadowing live. M2's note (16b report, point 2) left "new startOnly mods activate live" open. For a copy of a built-in a live swap of a kind under running workflows is the worse choice, and the brief says "after a restart". Other new startOnly mods are unchanged.
4. **The off switch of a required mod is refused in two places**: the Settings action (409 with words) and the loader (ignores the off list, with a notice). The first-run row has no switch.
5. **Settings words "the built-in is newer"**: the brief says to copy the wording from `Providers.tsx`, but there is no such wording there (it only has "replaces the built-in x"). I wrote "the built-in is newer (1.10.0)" in the same style and join (` · `) as "replaces the built-in x".
6. **Customize reads the bundled folder itself** (`readFolder`, strict UTF-8) instead of calling `exportMod`, so every refusal is the import's own and not export's different words.
7. **`protocol-impl` shadowing** is limited to the protocol named like the mod. The brief's list does not mention protocols; leaving them open would keep the same hole for protocol mods. Existing tests pin the providers' behaviour and stayed green.
8. **The first-run pack line shows only when the first-run screen shows** (when there are provider cards). An empty pack shows nothing. With a non-empty pack and no catalog the screen would not appear; I did not change when the screen appears.

## Files outside the brief's list that I edited (and why)

`packages/server/src/server.ts` (two routes for Customize), `packages/server/src/mods/types.ts` (the new fields), `packages/server/src/engines.ts` (the `bundledDir` seam; listed to read), `packages/app/src/App.tsx` (passes `pack` to `FirstRun`, 4 lines), `packages/app/src/firstRunCards.ts`, `providersStatus.ts` (pure helpers of the pack line and rows). No lockfile, `package.json`, tsconfig, golden or `*.browser.test.ts` touched.

## Existing tests edited

None. Nothing else went red.

## Anything the plan got wrong or left open

- **Carry keys** (above): the plan said "carry under `<kind>:<id>`"; with a bundled startOnly mod that is one key for two mods. Fixed here; Tasks 3 to 8 depend on it.
- **`main` vs source**: a pack mod's `mod.json` says `"main": "index.js"`, but the folder under `src/mods/<id>/` holds `index.ts`. Customize and its import preview can only work from the BUILT folder (`dist/mods/<id>/` holds `index.js`). In a source run (`vitest`, `tsx`) Customize of a source pack mod fails the import's check "`main` ... is not one of the files". My tests use a temp bundled folder with `index.js`. Tasks 3 to 8 should not rely on a Customize test against `src`. `registerPack` handles the same gap for core tests by trying `index.ts`.
- **Customize needs flat folders**: an import file is one folder with no folders in it (and at most 50 files, 1 MB). A pack mod with a subfolder (or `.d.ts`/`.map` files that are not text or too many) cannot be customized. `packProblems` catches subfolders and imports that leave the folder; it does not check the size, because the build output is not there in a source run. Task 3 should check that the compiled folder of the first real pack mod customizes.
- **Wording**: the brief says to copy "the built-in is newer" from `Providers.tsx`; it is not there.
- **Duplicate ids in the list**: when a copy fails (needs trust, bad code) the built-in and the copy are both listed with the same id (M2 behaviour, pinned by `mods-loader` tests). I made the actions user-first and the app key `id:bundled`; the Settings list still shows two rows in that state.
- **The vitest dot reporter** can print "Unhandled Rejection: Channel closed" after a file finishes (seen with `mods-import` and `toy-provider` under `--reporter=dot`, not under the default reporter; the tests pass). I did not investigate; it looks like worker teardown, not this task.
- **Not tested**: the browser. No `*.browser.test.ts` was run or added. The Customize button and the first-run switch are covered by server-side render (`react-dom/server`) and by the server actions, not by a click.
- **Docs**: the mods guide (`packages/server/src/mods/README.md`) and the changelog are not updated (Task 15 owns them).

## `git status --short` (my files)

```
 M packages/app/src/App.tsx
 M packages/app/src/FirstRun.tsx
 M packages/app/src/ImportSummary.tsx
 M packages/app/src/Providers.tsx
 M packages/app/src/firstRunCards.ts
 M packages/app/src/providersStatus.ts
 M packages/server/src/engines.ts
 M packages/server/src/mods/actions.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/mods/types.ts
 M packages/server/src/server.ts
 M vitest.config.ts
?? docs/plan/m3-task-1-report.md
?? packages/app/test/packLine.test.ts
?? packages/core/test/pack.ts
?? packages/core/test/setup-pack.test.ts
?? packages/core/test/setup-pack.ts
?? packages/server/test/pack-customize.test.ts
?? packages/server/test/pack-loader.test.ts
```

All touched files are CRLF (checked by bytes: 0 bare LF), and none holds U+2014.
