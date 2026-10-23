# M3 final review (at ee8b080)

Scope: `git diff 0421a1c ee8b080`. Every file was read from the commit (a `git archive` copy of ee8b080 in the OS temp folder), never from the working tree. Three throwaway probes ran in that temp copy with the core vitest project (`node vitest.mjs run <probe> --maxWorkers=1`); they are deleted. Line numbers are at ee8b080.

## BLOCKER

None found.

## MAJOR

### 1. A fork branch whose first block is an own playbook is stuck for good

- Where: `packages/server/src/mods/fork/index.ts:53-55` (a branch's key is the step id of its first instruction), `packages/server/src/mods/playbook/index.ts:164-166` (an own playbook starts its track with key = its own step id), `packages/core/src/run.ts:576-577` (`startTracks` refuses a key that is live), `packages/core/src/run.ts:1840` (the throw becomes a branch pause).
- What breaks: the branch track is called `pb`, and the playbook inside it then asks for a second track called `pb`. `startTracks` throws `track "pb" is live`; the branch pauses with "Branch pb failed: track "pb" is live; Resume tries again", and every Resume fails the same way. Only Stop gets out. Validation says nothing: the playbook's `program` check (`playbook/index.ts:249-266`) and the fork's (`fork/index.ts:84-103`) both pass. Spec 4.6 allows an own playbook in a branch, and putting one as the branch's first block is the natural way to write it.
- Reproduction (probe, run at ee8b080): `validate` returns `[]`, then the run logs `run_paused` on track `pb` with the text above.
  ```
  ## fork
  next: a
  next: pb

  ## phase after
  > after

  ## end

  ## phase a
  id: a
  mode: read-only
  > a

  ## end

  ## playbook review-pass
  id: pb
  input: target = t; depth = 1
  session: own

  ## end
  ```
  The existing tests always put a block before the own playbook (`core/test/playbook.test.ts:528`), so they miss this case.
- Smallest fix: in the playbook's `validate.program`, refuse an own playbook that is the first block of a branch (`own && ctx.trackOf(step.id) === step.id`), with words like "an own playbook cannot be the first block of a branch; put a block before it". The better fix gives the own playbook's track a key that can never be a branch key (for example `<step>#own`). That needs the `runs-pb-end` and `m3-task-p-pin` records made again. Add the case above as a test either way.

### 2. An own playbook without `usd:` runs its session with no spending cap

- Where: `packages/core/src/run.ts:549` (`const cap = this.shareFor(t) ?? this.sliceCap(t)`), `packages/core/src/run.ts:567-570` (`sliceCap` gives a cap only to a track with `ownSlice`).
- What breaks: `usd:` is optional on an own playbook (spec 5.1). Without it the track has no share and no own slice, so it opens its session with no `maxUsd` and no `usdRoom`. That happens even when the workflow has a `usd:` budget or a `model` step's slice is open. A main-line subagent in the same spot is capped at the smaller of the slice room and the workflow room (`run.ts:1040-1051`). The check between steps (`run.ts:1888`) still pauses the run, but only after the track's turn. One agent turn can be many model calls, and the API loop engine has no `usdRoom` to read before each call, so the overshoot has no bound. Spec 4.6 allows one model call per branch. The same gap applies to any track a code mod starts through `vm.tracks.start` with no `share` and no `usd`.
- Reproduction (probe): a workflow with `budget: { ..., usd: 4.00 }` and `## playbook review-pass` / `session: own` with no `usd:` line. `openSubagent` receives `{ step: 'playbook-1' }` with `maxUsd` and `usdRoom` both undefined.
- Smallest fix: in `sliceCap`, drop the `t.ownSlice &&` test, so every track without a share is capped at `usdRoom(t)` as a main-line subagent is. Then pass `usdRoom: () => this.trackRoom(t)` for it too. Test: the reproduction opens with `maxUsd: 4` and a live room. Then rerun the split and fork money tests, which may have assumed no cap.

### 3. Customize changes what a block prints: long commands and titles are cut when the file is saved

- Where: `packages/core/src/guard.ts:101` (`fit` cuts only when the mod mark has `pack`), `:120` (heading print), `:156` (default id); `packages/server/src/mods/loader.ts:376`, `:468` (`pack` is set only from a bundled manifest); `packages/server/src/mods/actions.ts` `customizeSource` (deletes `pack` from the copy, as it must).
- What breaks: a Customize copy is a user mod, so core guards it like any foreign mod. Its heading print is cut to 200 characters plus `...`, and any hidden character (a tab, say) is written as `<U+0009>`. Its default id is cut to 80 characters plus `...`. The canvas saves by printing the workflow model on the server (`packages/server/src/server.ts:455`). So after a user customizes `run`, `phase`, `if`, `gate` or `playbook`, any canvas edit silently writes a cut command, title or condition back into the file. A saved `next:` or `against:` that names a long default id stops resolving. This breaks the goal that a Customize copy "keeps working".
- Reproduction (probe): register `run` and `phase` as the loader registers a copy (the mod mark without `pack`, `shadow: true`), then parse and print one workflow. The 252-character `## run npm test -- xxx...` line prints as 206 characters ending in `...`. A phase with a 210-character title gets an 83-character id instead of a 210-character one. The Customize tests (`packages/server/test/pack-mods.test.ts:185-212`, `pack-customize.test.ts:212-260`) only check that the copy loads and its kind is in `NODES`. Nothing prints or runs a workflow with a copy in place.
- Smallest fix: give the loader's mark a second flag for "the built-in or a copy of it" (`pack || may('block-view', n.kind)` in `nodeCopy`), and have `fit` read that flag. Keep ops fenced for the copy, so trust and containment do not change. Test: customize `run`, print a 250-character command, and check the bytes are unchanged.

### 4. The guides were not written (plan Task 15), and the ones that exist are wrong

- `packages/core/src/nodes/README.md:6-18` still teaches the "Built in" way: two files in `core/src/nodes`, an entry in a `register` loop in `index.ts` that no longer exists, and an entry in `BUILTIN_VIEWS`, which is now empty. Following it fails `no-kind-branch.test.ts:145-148`, which allows only six files there. `:144` says "No shipped block starts tracks", but `fork` and `playbook` do. The checklist at `:193` repeats the old way.
- `packages/server/src/mods/README.md:209` says `api.core` is "exactly `checkMode`, `turnInstr`, `policyOf`, `parseCond` and `printCond`". The loader gives nine functions (`loader.ts:479`): `driftFound`, `globMatcher`, `isValidGlob` and `relPath` are missing from the guide.
- No guide covers any of these:
  - the default pack: where it lives, what `pack` and `required` mean, Customize, and "the built-in is newer";
  - how to write a condition and a card as a mod, with a worked example (the 14 pack folders would serve);
  - how to write a playbook: the `blocks/` folder, `input:` and `{{name}}`, `output:`, `session: own`, `usd:`, and the name, size and nesting limits;
  - `fork`;
  - the Share file.

  The plan (Task 15) asks for a pack README with Customize, required mods and "how to write a block". The user's goal (blocks are pre-installed mods that users remove, tweak, export and import) depends on these guides.
- `CHANGELOG.md:16-17` covers only playbook and the removal of `use`. Missing: `fork`; "the built-in blocks are now the default pack" (the plan's words); Customize; canvas chains; the `next` handle now only on the fork (a visible change: plain blocks lost their handle); and Share/import of one file. `README.md:55` (the Steps table) has no `fork`.
- Fix: do Task 15 before showing M3, and fix the three wrong claims above.

## MINOR

### 5. The share file leaves out what the workflow needs besides block kinds

`packages/server/src/mods/actions.ts:1448` (`kindsUsed`) collects step kinds only, and `exportBundle` (`:1465`) adds just the user mods that bring those kinds. This leaves two gaps:

- A playbook's file from `blocks/` is never put in the share file, and no note says so. The person who imports it gets `Playbook "X" not found`.
- A user condition or card mod the workflow uses (an `until:` atom, a card line) is not added and not named in `notes`. The importer gets a parse error.

Fix: also walk the conditions (each step's `cond` and the `whenever` autos) and the cards, map each to the mod that holds it, and add it. Add one note per playbook name saying its file is not in the share file. Carrying the files themselves would be a plan change.

### 6. Kind names still in core, and the guard cannot catch them

- Names still in core:
  - `packages/core/src/viewShape.ts:25` (`EVENT_ROW_KIND` names `subagent`);
  - `viewShape.ts:33` (`CAP = 'end'`: only a view of kind `end` may say `stops`);
  - `packages/core/src/format/parse.ts:242` (a `whenever` that failed to parse defaults to `{ t: 'drift' }`; harmless at run time, because an unknown atom is false).
- `no-kind-branch.test.ts` passes all three. Its `KINDS` list (`:10`) has no `playbook` or `use`, and no condition or card name. Its rules (`:12-19`) match only a few single-quoted forms, so `"end"`, `.includes('end')`, `{ end: ... }` and `const X = 'end'` all pass.
- Fix: build the name lists from the pack manifests (`provides.kinds`, `conditions`, `cards`), as `packEvents` already does for events. Match any quoted name outside the pack folders, against an exact allowlist. Move `CAP` into the `end` manifest's view data.

### 7. The core tests do not run the pack the way production does

`packages/core/test/pack.ts:67` registers each pack node with `register(n, order)` and no `mod` mark. So in every core test (the M1 goldens, the stop-await pins, `m2-pins`, `playbook.test.ts`), the pack blocks run without:

- the `guardNode` wrappers;
- the frozen compile context (`modCtx`);
- the fence on their NODE blocks (`run.ts:1991-1993` fences every mod NODE, `pack` or not).

`setup-pack.ts` says "the way the server's loader registers it", which is not true. The server pins through the real loader cover the main paths, but the M1 goldens and the A1 to A6 Stop pins prove the old behaviour on a path production no longer takes. Fix: set `mod: { id, events, pack: true }` in `pack.ts` (and `pack: true` on conditions), as `nodeCopy` does, then rerun the core project.

### 8. A Customize copy of a block with ops runs fenced: Stop no longer waits for its command (unconfirmed, reading only)

`run.ts:1897` skips the fence only for `mod.pack`. A copy of `run`, `verify`, `repeat`, `fork` or `playbook` therefore takes `modRun` (`run.ts:912-935`). There Stop wins the race and returns while the copy's shell command keeps running, and that in-flight command still records its `command_result`. The built-in waits for the command. Fix: decide whether a copy is "the same block, tweaked". If it is, use the copy flag from item 3 for this too; if not, say so in the Customize words.

### 9. Spec 9 asked M3 to guard `vm.tracks.start`; not built

Spec 9: "the import summary lists `starts`, `share` and `usd`." The import summary says nothing about tracks, and the fence (`run.ts:965`) checks only `at`. Fixing item 2 closes the money side. For the rest, add a line to the code prompt ("may run several sessions at once"), or record in the plan that this was dropped.

### 10. A pack mod that is switched off gives a bare "Unknown step kind"

A workflow that uses a switched-off `recall` gets `Unknown step kind "recall"` (`parse.ts:268`), with no hint that Settings switched it off. Only the import preview names the mod. Fix: the server knows the disabled ids and their `provides.kinds`, so it can add "it comes with the mod recall, which is switched off in Settings" to the line.

### 11. Shares are rounded to a millionth, not a cent

Spec 4.6 says a cent. The F report records the change as M2's code, pinned on purpose. Write the change into the spec, so the next reader does not take it for a bug.

## Answers to the brief's questions (checked against the code)

### 1a. Containment

- **`api.core`**: all nine functions (`loader.ts:479`) are pure over their arguments. None returns a registry, core state, a file handle or another mod's object: `globMatcher` returns a picomatch matcher, `relPath` returns a string. `parseCond` and `printCond` call into `CONDS`, so a mod can run other atoms' `parse` and `print` on its own input. That gives no new reach to code that is already trusted. The object is frozen.
- **Built-in versus copy**: bundled pack ops run unfenced (`run.ts:1897`). A copy is fenced, because `pack` comes only from a bundled manifest (`loader.ts:468`) and `nodeCopy` overwrites any `mod` the node gives (`:376`).
- **Claiming `pack` or `required`**: a user mod that says either is refused (`loader.ts:283-291`).
- **Replacing a built-in**: any user mod with a bundled id and the same mod kind replaces the built-in (`loader.ts:547-549`), not only a Customize copy. It may cover only the built-in's own `provides` (`mayShadow`). Through import it needs `replaceBuiltin`. A data block replacing a built-in brings no code, so it gets no code prompt; only the built-in confirm stands between it and the user.

### 1b. Playbook

- **File names** (`run-cli.ts:313-335`): plain names only, the real path inside `blocks/`, at most 100 KB, no device names.
- **Self-calls and size**: a file that runs itself is refused in validation (`playbook/index.ts:235`). Compile is bounded at 8 levels and 2,000 steps or 2 million characters per outermost playbook.
- **Inputs**: names are plain, values are at most 300 characters, hidden characters are refused, and the fill is one pass. `{{__proto__}}` is reported as a missing input (a `Map`, and the input name rule).
- **Commands from inputs**: values go into commands as they are, by design (spec 5.2). Trust walks the compiled program, both inline and own (`trust.ts:20-26`), so the filled commands are listed and the hash changes when an input changes a command.

### 1c. Share file import and export

All of the following hold:

- caps of 20 mods and 1 MB, then the single-mod checks for each mod;
- ids checked with `isModId`;
- two mods that bring the same name are refused;
- a built-in is replaced only by explicit id;
- trust is given per mod by hash, so a changed mod asks again;
- the install is all or nothing (`placeMod` undo);
- the workflow is saved with `wx` into `~/.reins/workflows`, with the name rule, a link check and a key check;
- keys are checked on export (`exportMod`) and on import (`holdsDeep`).

Duplicate JSON keys collapse the same way in preview and apply.

### 1d. Clashes and required mods

- **Clashes**: a second kind of the same name throws in core. A condition or card name that another mod holds is refused (`kinds.ts:237`). Ties in `order` go by arrival.
- **A required mod missing or broken**: its steps are "Unknown step kind" in the editor and in `reins run`, and the chat refuses with words (`tags.ts`). The app survives the empty lists: `addStepAt` refuses an empty kind.

### 2. Engine

- **Carry item 7** is closed: `fork/index.ts:64-65` and `playbook/index.ts:181-182` move the counter before the done row.
- **Pinned M1 bugs**: B2 (a subagent re-runs on restore) and the queued `now` card lost on save are not in M3's scope and stay open. Their pins are unchanged.
- **Code moved from core**: the receipt keeps its fixed fields through `count` (`receipt.ts:56-65`). The resume note now reads the host's own record (`session.ts`). An M2 snapshot saved before this change resumes with no model note; that is cosmetic.

### 5. App

- **Edited tests**: `blocksFace.test.ts` and smoke 8e.5 and 8e.7 now drag the fork's handle. The old backward-link `(max 3)` check is gone because only a fork can draw `next`. Nothing else was weakened.
- **Unknown kinds and odd keys**: unknown kinds draw the "unknown block" face, and the maps are `Object.create(null)`.

### 6. Goldens

- **`runs-S9.json`**: the changes are only the `use` names becoming `playbook` names, `playbook_started` and `playbook_done`, `counts: { playbooks: 1 }`, and 2,000 ms more for the two extra clock ticks. The gate is still judged, the top-level `end` still finishes the run, and the free phase still never runs.
- **`contract-examples.json`**: it gains one `PLAYBOOK` and `PLAYBOOK_END` pair with nothing between them, because that golden compiles with no block resolver.

Nothing semantic hides in either.

## Verdict

M3 is not ready to show strangers yet, though nothing found is a security hole: containment, the share file, playbook file reading and the trust list all hold up. Four things should be fixed first:

1. **Item 2**, an own playbook with no `usd:` spends with no cap. Money is the product's promise, so this goes first.
2. **Item 1**, a fork whose branch starts with an own playbook passes validation and then can never finish.
3. **Item 3**, Customize, the headline feature of "blocks are mods you can tweak", quietly cuts long commands and titles the next time the canvas saves the file.
4. **Item 4**, the guides a stranger would follow to write a block, condition, card or playbook are missing, and the one that exists sends them down a path the tests now forbid.

Items 5 to 11 can follow in Task 17.
