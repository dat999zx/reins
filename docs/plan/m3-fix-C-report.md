# M3 fix round, group C report (guides and docs): review items 4 and 11

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD ee8b080. Documentation only. One test file added; no source file touched.

## What I did

### Item 4 (a): `packages/core/src/nodes/README.md` rewritten for blocks as mods
- Read: `packages/core/src/nodes/index.ts` (registry, `register`, `CORE_OPS`, `VmCtx`, `TrackSpec`), `fields.ts`, `turn.ts`, `packages/core/test/no-kind-branch.test.ts` (the `STAYS` list), `packages/core/test/pack.ts`, `setup-pack.ts`, `packages/server/test/pack-helper.ts`, `packages/app/test/setup-kinds.ts`, `packages/server/src/mods/fork/index.ts`, `playbook/index.ts`, the 14 pack `mod.json` files.
- The old "Built in" way is gone (two files, a `register` loop in `index.ts`, `BUILTIN_VIEWS`). The new text says the default pack is the only source of kinds, lists the six files that may stay in `core/src/nodes`, `conds` and `cards` with the reason for each (`nodes/index.ts`, `nodes/fields.ts`, `nodes/turn.ts`, `nodes/README.md`, `conds/index.ts`, `cards/index.ts`; note that the test's six are spread over three folders, four of them in `nodes/`), and replaces the checklist.
- "No shipped block starts tracks" is replaced: `fork` and `playbook` with `session: own` start tracks. I also added `vm.tracks`, `handBack`, `outputs`, `lastReply` and `TrackSpec` (`seed`, `usd`, `share`).
- The order table now has both numbers for all 14 blocks (the old text gave only `end` and `playbook`, and was wrong for recall, store, model, subagent: view orders are 80, 90, 100, 110). Read from the manifests.
- The "import rule" (view files import only types) is gone: a view is the `view` object of `mod.json`. `fields.ts` is described as types and helpers. `applyField` is cited at `packages/app/src/panelEdit.ts` (the old text implied it was in core).
- The `beep` example is unchanged and a test checks it is byte for byte `packages/core/test/fixtures/beep.ts`.

### Item 4 (b): the `api.core` claim in `packages/server/src/mods/README.md`
- Read `loader.ts` `buildApi` (the frozen `core` object) and each function in core: `turn.ts` (`checkMode`, `policyOf`, `turnInstr`), `cond.ts` (`parseCond`, `printCond`), `drift.ts` (`driftFound`), `policy.ts` (`globMatcher`, `relPath`, `isValidGlob` re-export), `util.ts` (`isValidGlob`).
- The "exactly five" sentence is replaced by a table of the nine with a one-line meaning and a safety note each (which of them run other mods' hooks: `policyOf`, `parseCond`, `printCond`). A test compares the table with the names in `loader.ts`.
- Other stale lines fixed in the same file: "Task 18 moves them to data" (now points to the section that says they are data); "Reins does not yet enforce this: ... M3 Task 1's" (it does: `mayShadow`); "A mod cannot give a view to a built-in block name" (except the Customize copy); the order range (blocks 10 to 140, views to 150, pick above 150). Two manifest rows added for what group D put in `kinds.ts`: `tracks` and `reads`, plus the extra trust line (`TRACKS_LINE` in `actions.ts`). A link to `PACK.md` is at the top.

### Item 4 (c): the new guide `packages/server/src/mods/PACK.md` (one place, linked from the mod README)
Sections: the default pack (28 mods: 14 blocks, 11 conditions, 3 cards; where they live; `pack` and `required`; switch off and remove; Customize; "the built-in is newer"); write a block (`ping`, modelled on `say`); write a condition (`exists`, modelled on `cond-cmd` and `cond-touches`); write a card (`noshell`, modelled on `card-now` and `card-guard`); write a playbook; the `fork` block; the Share file.
Files read for it: `loader.ts` (283-291 `pack`/`required` refusal, 319-321 and 510-572 required, 346-360 `mayShadow`, 479 api), `actions.ts` (`isNewer`, `summary`, `setEnabled` 568-584, `removeMod` 588-609, `customizeSource`/`customizeMod` 1154-1199, the envelope code 1258-1505 and the changes group D made while I worked), `kinds.ts` (`tracks`, `reads`), `playbook/index.ts`, `fork/index.ts`, `run-cli.ts` (`readBlock`, `BLOCK_MAX`, `BLOCK_NAME`, `blockResolver`), `packages/core/src/cond.ts` (`CondType`, `EvalCtx`, `COND_PARAM_KEYS`), `cards/index.ts`, `policy.ts` (`checkTool`), `run.ts` (`capOf`, `reshare`), `app/src/ShareWorkflow.tsx`, `Providers.tsx`, `BlockPanel.tsx`, `providersStatus.ts`, and the tests `m3-task-f-run.test.ts`, `m3-task-f-fork.test.ts`, `mods-envelope.test.ts`.
Findings while writing that the guide now says in words:
- The block panel has one "add card" button, for the first card kind in `order` (`guard`); a card of a mod is written as a line in Text (`BlockPanel.tsx:124-153`; read, not tried in a browser).
- A copy of `phase` or `end` is required too: `required` follows the id (`loader.ts:510,521`). Tested.
- An export notes each playbook file that it does not carry (group D's change); conditions and cards of user mods are exported too (group D's change).

### Item 4 (d), (e): `CHANGELOG.md` and `README.md`
- CHANGELOG: bullets for `fork`; the built-in blocks are now the default pack; Customize; canvas chains; the `next` handle only on the fork (written as **Visible change**, with the "use `repeat` with `until`" advice and the fact that old files still load); Share/import of one file; the guides; shares rounded to a millionth. Two old bullets that became false are corrected ("No shipped block uses them yet" for tracks; "adding a block takes two files and one line").
- README: the Steps row had `turn` (not a block: no mod provides it) and lacked `fork`, `model`, `subagent`. Now it is exactly the 14 kinds. The Wires row says `next` from a `fork` starts a branch. Conditions row (11) and Live cards row (3) checked equal to the registries; a test keeps them equal.

### Item 11: shares rounded to a millionth
- `docs/plan/2026-10-17-m2-spec.md` 4.6 "Shares (B2)" now says "rounded UP to a millionth of a dollar, not a cent", with the examples 0.166667 and 0.333334, and the reason: plan v5.1 said "as a cap is rounded" (`run.ts:534` then), that rounding is `capOf` (up to a micro-dollar, via nano-dollars so float noise does not push it a whole micro-dollar), and a cap a hair under the limit would end a reply as an error that `usdOver` does not see as reached. Source of the reason: `packages/core/src/run.ts` comment on `capOf`; `docs/plan/m2-task-12-report.md` item 1 ("v3 test 2 says rounded up to a cent (0.17); v5.1 says as a cap is rounded. I followed v5.1"); `m3-task-F-report.md` line 37. Also a line that says "read 'up to a millionth'" wherever the older text says a cent, and that the "free room of a cent or more" test is a different number.
- `docs/plan/2026-10-21-m2-plan-v5-1.md` Task 12 goal: a NOTE added with the same fact.
- Not changed: v3/v4 plans and the open-questions notes, which also say a cent (superseded files; the NOTE in v5.1 and the spec are the live ones).

## Tests: `packages/server/test/m3-fix-c-guide-examples.test.ts` (23 tests)
It installs each guide mod through the real import path (preview, hash, `importApply` with trust), then parses, prints back, validates, compiles and RUNS a workflow. Examples run: `ping` block, `exists` condition (file present runs the step, absent skips it, with a real `cwd`), `noshell` card (turn line sent; `checkTool` refuses a shell command), the fork file (seed, results in wire order, per-branch caps 0.5/0.5, no cap, failed branch pauses alone and Resume, Stop closes both sessions, gate card titled with the branch), an own playbook (inputs, `output:`, own session, `usd:` 0.5) and an inline one, the limit messages, a fork inside a playbook refused (inline and own), Customize (copy without `pack`/`required`, second Customize refused, remove goes back, required has no off switch, a copy of `phase` is required), the Share file (export, preview, wrong hash refused with nothing installed, import with three trusts, second import refused, built-ins only gives `"mods": {}`). Doc checks: every example text is in `PACK.md` byte for byte; README rows equal the registries; the `beep` example equals the fixture; the order table equals the manifests; the counts (14, 11, 3, 28) equal the folders; the limits in the guide equal the constants in the source; the `api.core` table names equal the loader's; no U+2014 in any guide.
Existing tests edited: none.

### Red at HEAD
The guide checks fail against HEAD's docs (probe with `git show HEAD:...`): `PACK.md` does not exist at HEAD; the HEAD nodes README has no order row `| recall | 90 | 80 |`, still says "No shipped block starts tracks" and mentions `BUILTIN_VIEWS`; the HEAD mods README has no `globMatcher` row and says "exactly `checkMode`, `turnInstr`, `policyOf`, `parseCond` and `printCond`"; the HEAD README Steps row has `turn` and no `fork`; HEAD CHANGELOG has neither "fork" nor "Customize". The example tests themselves test code that exists at HEAD, so they are green at HEAD by design (they are the proof that the guide examples run); the file as a whole fails at HEAD on the PACK.md reads (ENOENT, which I saw on my first run).

### Mutations (hand-applied to the docs, sha256 checked before, mutated, after restore; full test file run each time; baseline green first)
| # | File | Break | Result |
|---|---|---|---|
| M1 | PACK.md | example `"order": 200` to 201 | killed (examples in the guide) |
| M2 | PACK.md | "28 of them say" to 27 | killed (counts) |
| M3 | PACK.md | "At most 30 inputs" to 31 | killed (limits) |
| M4 | PACK.md | fork "cut at 8,000" to 9,000 | killed (limits) |
| M5 | PACK.md | card example line changed | killed (examples) |
| M6 | PACK.md | playbook file `{{area}}` to `{{areas}}` | killed (examples) |
| M7 | PACK.md | the tracks trust line reworded | killed (README/PACK lines) |
| M8 | mods README | `globMatcher` row renamed | killed (api.core table) |
| M9 | mods README | `reads` row renamed | killed |
| M10 | README.md | `fork` taken out of the Steps row | killed (rows = registries) |
| M11 | README.md | `tests` taken out of the Conditions row | killed |
| M12 | nodes README | order row 80 to 90 | killed (order table) |
| M13 | nodes README | `'1'` to `'2'` in the beep example | killed (example = fixture) |
| M14 | CHANGELOG | a U+2014 put in | killed (dash test) |
| M15 | PACK.md | Share example `"mods": {}` changed | killed (examples) |
All restored; the sha256 after equals the sha256 before for every one. "Intended test red" was checked by searching for the test's name after a failure mark in the output, which is loose; every run also had exactly the expected files failing.
Survivors, by nature: a prose claim that no test ties to code (for example "Resume tries the failed branch again" in a changed sentence, the Customize "after a restart" sentence, the button names in Settings). The behaviours behind those claims are covered by the example tests (fork, playbook, Customize, Share) and by group F's tests (`m3-task-f-run.test.ts`), but a reworded sentence is not caught. I did not add text-matching tests for them.

### Run (`--maxWorkers=1`)
`m3-fix-c-guide-examples` 23/23, plus neighbours: core `no-kind-branch`, `m3-task-w-core`, `nodes-registry`; server `mods-envelope`, `m3-task-f-fork`, `m3-task-f-run`, `m3-task-p-playbook`: 8 files, 173 tests, all green at the time of the last run. `npm run typecheck` clean. During the round my file was red twice for a few minutes because other groups' edits were in flight (own-playbook track key `review#own` against `review`; a missing `KIND_NAME` in `loader.ts`; the mod-cache write). Those were not mine; they went green without my change. I made the playbook test independent of the track key.

## Unconfirmed / depends on other groups
- Not run in a browser: the Customize and Disable buttons in Settings > Providers, the Share button in Text, the missing add button for a mod card. Read from `Providers.tsx`, `providersStatus.ts`, `ShareWorkflow.tsx`, `TextTab.tsx:389`, `BlockPanel.tsx`.
- The Customize test needs the built folder (`packages/server/dist/mods/say/index.js`): the source folder holds `index.ts`, and Customize copies text files. It is skipped when there is no built folder. It passed on the current `dist`.
- "Switch off applies after a restart" and "a Customize copy takes the built-in's place after a restart" come from the loader's comment and logic (`loader.ts:546-552`, 570) and the older README; the Customize test checks the files and the refusals, not the restart.
- Guide statements that depend on files other groups were editing when I finished: (1) `usd:` on an own playbook: the guide says "The run ignores anything else, and the playbook then has no budget of its own" (`playbook/index.ts:306`); review item 2 (group B) may change that; (2) the own playbook's track key (`step` or `step#own`) is not in the guide; (3) the Share section follows `actions.ts` as group D left it: conditions and cards of user mods are exported, and each playbook file gets a note once (`reads` in `playbook/mod.json`); (4) `tracks` and `reads` manifest words and `TRACKS_LINE` (`kinds.ts`, `actions.ts`). The tests keep the guide in step with (3) and (4) (the Share test, the README rows test); if group D changes the wording, those tests go red and the guide needs the same edit.
- The v3 and v4 plans and the open-questions notes still say "to a cent". Left alone (superseded files).
- The docs say the Share export carries a user mod's files only; a Customize copy is exported like any user mod. Tested for a user mod; a copy of a built-in goes through the same `holder` code (not exercised).
- Mistakes of mine, fixed: a PowerShell replace that ran from the wrong folder created an empty `packages/server/m3-fix-c-guide-examples.test.ts` (deleted); a replace string with a backtick turned `fork` into a form feed in the mods README (fixed, checked: none left). Line endings of all five edited docs are CRLF throughout (checked by count), the new `PACK.md` too.

## `git status --short` for my files
```
 M CHANGELOG.md
 M README.md
 M packages/core/src/nodes/README.md
 M packages/server/src/mods/README.md
?? packages/server/src/mods/PACK.md
?? packages/server/test/m3-fix-c-guide-examples.test.ts
```
Also edited, outside git (docs/ is ignored): `docs/plan/2026-10-17-m2-spec.md` (4.6), `docs/plan/2026-10-21-m2-plan-v5-1.md` (Task 12 note), this report.
