# M3 Task 14 (Group E): the shareable envelope, export and import of a workflow with its mods

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 058a0f0. Nothing committed, added, stashed, reset, checked out or pushed. No U+2014 in any file I touched. Line endings kept (every touched file CRLF, CR count = LF count; my three new files are CRLF too).

## What I built

One file, `{ "reinsMods": 1, "mods": { "<id>": { "<file name>": "<text>" } }, "workflow": { "name": "...", "text": "..." } }`, beside the old `{ reinsMod: 1, files }`. Both import. The same two routes serve both (`POST /api/mods/import/preview`, `POST /api/mods/import`): a file with a top-level `reinsMods` goes to the envelope code, anything else is the old path, unchanged.

**Server, `packages/server/src/mods/actions.ts`** (all of it; no new server file):
- `openEnvelope`: ALL checks, no write. Shape (only `reinsMods`, `mods`, `workflow`), at most 20 mods, the whole file at most 1 MB (the HTTP body cap is the same 1 MB), the key check over the decoded envelope, then for each mod: the id must pass `isModId` (so `..`, `a/b`, `__proto__`, `con`, upper case, 41 characters are refused), then the mod's files go through the single-mod `checkImport` unchanged (names, 50 files, 1 MB, binary, keys, `validateMod` with the `pack`/`required` refusal, `main` present, hidden characters). The id in `mod.json` must equal the key, and two mods of the file may not bring the same block, condition or card. The workflow: a name that is a plain name (letters, digits, dash, underscore, at most 60, not a Windows reserved name), a text of at most 256 KB, no hidden character (line breaks and tabs are fine), no key.
- `previewEnvelope`: ONE summary: `{ envelope: true, mods: [the usual per-mod summary], adds: ["<id>: adds the block ...", ...], workflow: { name, exists, diagnostics }, warnings }`. Every code mod has its own `codePrompt`, `hash` and `trusted`; a data mod has none. A mod that takes a built-in's id gets a warning line.
- `applyEnvelope`: body `{ file, trust, replaceBuiltin }`. `trust` is `{ "<mod id>": "<hash the preview showed>" }`: a code mod is trusted only when named with its current hash. `true`, a list, a wrong hash, a hash of another mod, a data mod, an id that is not in the file: each is refused and nothing is installed. `replaceBuiltin` is a list of ids; a mod that takes a built-in's id (a Customize copy travelling to another home is the only honest case) needs its own id in it, and no other field stands in for it. Everything is checked first; then every mod is placed in order, then the workflow is saved; if any step fails, the ones placed before are taken back in reverse (folder, the old copy, the trust line, the on/off mark, and the new `workflows` folder), and one reload runs at the end. The reply: `{ ok, ids, trust: { id: "trusted" | "needs-trust" | ... }, workflow: { name, diagnostics }, reloaded, problems? }`.
- Refactor of the existing import: the body of `importApply` that put one mod on disk is now `placeMod(env, checked, trust)`, returning `{ undo, commit }` or a reply. `importApply` for one mod calls it and behaves as before (all 368 tests of the neighbouring server and app files pass). One behaviour change in the old path: when an import is undone and there was NO `mod-trust.json` before, the undo now removes the empty `{}` file it would have left. The envelope tests found this (a failed envelope left a file); it is the single-mod path too.
- Unknown kind words: `Unknown step kind "<kind>": the mod <id> brings it`, built in `unknownKinds` from the parser's own diagnostic plus the mods of the file. It sits in the import preview (every kind the file brings is unknown until it is installed and trusted) and in the import reply (after the reload: only the kinds that are STILL unknown, i.e. a mod that was not trusted). A kind nobody in the file brings keeps the plain core message. I did not touch core's parser or validator: they cannot know which file a mod came from.
- `exportBundle(env, { ids?, workflow? })`, route `POST /api/mods/bundle`: reads the step kinds of the workflow (nested steps too), finds the installed mod that brings each (the user's mod first), and adds it. A built-in pack mod is never added ("ships with Reins"). A Customize copy is a user mod, so it is. A kind that no installed mod brings and core does not have is named in `notes` and `missing`; the file is still made, with the workflow. An explicit id that is built in is refused (409). Each mod goes through the existing `exportMod` (links, secrets, binary, 1 MB, home files), the file is written with sorted ids, and the text is read back through `openEnvelope` before it is handed out (a file that would not import is not exported). The reply is `{ text, ids, notes, missing }`; `text` is the file, `JSON.stringify(..., null, 2) + "\n"`.
- Saving the workflow: `<home>/workflows/<name>.reins.md`, written whole (`wx`, never over a file), the folder must not be a link; a name already taken refuses the whole file BEFORE anything is installed. The workflow lands in the user's workflows (the same folder `GET /api/workflows` lists as "user").

**Server, `server.ts`**: two one-line changes (the import of `exportBundle` and the route `POST /api/mods/bundle`).

**App**:
- `ImportSummary.tsx`: `ImportPanel` understands the envelope preview: every mod's summary list, ONE code prompt and ONE unticked box ("Trust and import: <id>") per code mod, a box "Replace the built-in <id>" where needed, the workflow line with its unknown-kind lines, and an "Import the file" button that is off while a workflow name is taken or a built-in is not confirmed. Pure helpers `envelopeBody`, `envelopeReady`, `isEnvelope`. The request names each ticked code mod by its hash and never sends `trust: true`.
- New `ShareWorkflow.tsx`: `ShareButton` (the workflow menu: the editor bar of the Text/Blocks tab, next to Save; off while there are unsaved changes, because the file holds the saved workflow) and `ExportMine` (Settings, next to Import: all mods you installed and your Customize copies, at most 20). Both download the file and say how many mods are in it and the notes. `TextTab.tsx` and `Providers.tsx` got two lines each (an import and the button).

## Files

Changed: `packages/server/src/mods/actions.ts`, `packages/server/src/server.ts`, `packages/app/src/ImportSummary.tsx`, `packages/app/src/Providers.tsx`, `packages/app/src/TextTab.tsx`.
New: `packages/app/src/ShareWorkflow.tsx`, `packages/server/test/mods-envelope.test.ts` (53 tests), `packages/app/test/importEnvelope.test.ts` (8 tests).
`workflow-files.ts` is not changed: saving needs to be in the same all-or-nothing turn as the mods, and `workflow-files.ts` pulls in the session and the CLI, which `actions.ts` does not import.

## Tests (new files only)

`mods-envelope.test.ts`, hostile first. Every refusal test calls the preview AND the apply (with every choice a sender could hope for: trust and replaceBuiltin for every id) and checks: status 400 or more, the words, the key never repeated, a byte-for-byte equal home (a SHA-256 map of every file and folder, so a `.mod-*` scratch leftover, a trust file or a `workflows` folder would show), and an equal core registry.
- 10 000 mods (object and text), 21 mods vs 20; mod names `..`, `.`, `a/b`, `a\b`, `../x`, `A`, `Eb1`, `con`, empty, 41 characters, `__proto__`, `a b`, `-x`, NUL, `ebé`; key and `mod.json` id disagree; one id under two keys; two mods bringing one block; a mod that takes `say` (preview 200 with the warning; apply refused with no choice, trust, `replaceBuiltin: true`, a list naming another id, or a string); `pack`/`required` in five variants; a workflow with each of 8 hidden characters; CRLF and tabs allowed; a 5 MB workflow, one just over 256 KB, a 5 MB file as text; two 600 KB mods; 14 workflow names that are paths or reserved; extra workflow fields (`path`, `file`); nested envelopes (as a mod, as `reinsMod` inside, as `mods.x` holding an envelope, as the workflow, and inside a file's text, which is plain text and installs nothing); a key in a file text, in `mod.json`, in a file name, in a property name, in the workflow, as a mod id, and in a file in text form; shape errors (extra field, version 2, array of mods, no mods, not JSON, no `mod.json`, 51 files, a slash in a file name, binary text, a `..` file name, `workflow: null`); a mod that lacks its main file names the mod.
- All or nothing: mod 3 of 5 refused by its manifest; mod 3 of 5 failing at placement (a plain file stands in its place) after a trusted `eb1` was replaced and `eb2` placed: the home is byte-equal to before, the old trusted `eb1` is back with its trust line, no `.mod-*` leftover; the workflow cannot be saved (a file stands where `workflows` goes) after the mods were placed: the mods are taken back; a taken workflow name refuses before anything is written; a choice that names a mod that is not in the file.
- Trust: one summary lists every mod's adds, one prompt and hash per code mod and none for the data mod; only the code mod named with its hash is trusted (`mod-trust.json` holds only it; the other is `needs-trust` and not registered); `true`, a string, a list, a wrong hash, another mod's hash, a data mod, a number, one good and one bad: nothing installed; the same trusted bytes are `trusted: true` in the next preview; changed code is `trusted: false`, the old hash is refused (409), and importing it without trust leaves it not trusted while the unchanged mod stays trusted.
- Unknown kind: the exact words in the preview and in the reply, plain for a ghost kind, and gone once the mod is trusted.
- Export: user mods in, built-in blocks out, ghost block named, deterministic, nested steps (inside a `repeat`) counted, explicit built-in ids refused, bad requests (empty, extra field, bad ids, 21 ids, bad workflow name, a key in the workflow, a hidden character), a key in a mod file refuses without repeating it, a mod that would not import is not exported, text that grows when written as JSON, over 1 MB.
- Round trip: export from home A (CRLF text, an accented letter and an emoji in the workflow, a CRLF file in a mod), import into a second `tempHome` after the preview: every file of every mod is equal by bytes, the workflow file is equal by bytes, and exporting again from B gives the same text. A Customize-shaped copy of `say` is in the file because the workflow uses `say`; `phase` is not; the second home refuses it without the confirm (409) and takes it with `replaceBuiltin: ["say"]`.
- Old file and routes: a `reinsMod` file still previews and imports with `trust: true` (and `trust: 'yes'` is refused); a single file whose text only mentions `"reinsMods"` is a single file; over real HTTP: preview, import with a hash, bundle, an empty bundle (400), a path as workflow name (400).

`importEnvelope.test.ts` (app): the request names ticked code mods by hash and nothing else (never a data mod, an unknown id, a mod without a hash, or `true`), `replaceBuiltin`, `envelopeReady`, `isEnvelope`, `shareName`, Share and Export-mine disabled states.

## Red at HEAD

`git archive HEAD` into a temp folder (node_modules linked), my test files copied in, nothing else: `mods-envelope.test.ts` (51 tests at that time): 48 red, 3 green. The 3 green at HEAD: "a choice that names a mod that is not in the file refuses the file" (HEAD refuses every envelope, so it holds by accident), "a `reinsMod` file still previews and imports", and "a single file whose text only mentions `reinsMods` is a single file". At HEAD an envelope is refused with "`reinsMods` is not a field of a mod file", so every refusal test fails on its words, and `exportBundle` does not exist. Two tests were added later (53 now) and were checked by mutation instead.

## Commands

All `D:\nodejs\node.exe node_modules/vitest/vitest.mjs run ... --maxWorkers=1`.
- `mods-envelope.test.ts` + `importEnvelope.test.ts`: 61 passed.
- Pins: `toy-block-import`, `pack-customize`, `mods-import`, `mods-api`, `p29c-import`, `toy-provider`, `mods-loader`, `mods-envelope`, app `providersStatus`, `packLine`: 10 files, 368 passed. App `importSummary`, `importSummaryKinds`, `importEnvelope`: 29 passed.
- `tsc --noEmit` (root) clean for my files; `tsc -p packages/app` clean. The root run currently fails in `packages/core/test/playbook.test.ts(388)`: group P's file, not mine. ESLint on my six source/test files: clean.
- Not run: the whole suite, the build, any browser test.

## Mutations

37 hand-applied breaks (string replace in `actions.ts` or `ImportSummary.tsx`, original bytes written back, SHA-256 equal each time; no git). Hostile-input guards first.

| # | break | result |
|---|---|---|
| H01 | count cap off | red (2) |
| H02 | mod id shape not checked | red (15) |
| H03 | key vs `mod.json` id | red |
| H04 | same block brought twice | red |
| H05 | built-in confirm off | red (2) |
| H06 | workflow hidden characters | red (2) |
| H07 | workflow name shape | red (3) |
| H08 | workflow Windows reserved names | red |
| H09 | workflow size cap | red |
| H10 | whole-file cap | red (2) |
| H11 | envelope-level key check | red |
| H12 | workflow key check | SURVIVED, then a test for `exportBundle` with a key in the workflow; red |
| H13 | trust hash compared | red (2) |
| H14 | trust of a data mod | SURVIVED (the hash mismatch refused it anyway), then the test asserts the "has no code" 400; red |
| H15 | `trust` shape (so `true` would pass) | red |
| H16 | placeMod always trusts | red (2) |
| H17 | a choice naming a stranger id | red |
| H18 | undo of placed mods off | red (2) |
| H19 | extra top-level fields | red |
| H20 | envelope detection off | red (48) |
| H21 | taken workflow name | red |
| H22 | workflow written without `wx` | SURVIVED, left: equivalent. The taken-name check is in the same serial turn and uses `lstat`, so `wx` only matters against a writer outside Reins. Kept as defence |
| H23 | workflows folder link check | red |
| H24 | bundled mods exported | red (6) |
| H25 | explicit built-in id | red |
| H26 | export read-back check | SURVIVED, then a test with a mod that exports but would not import; red |
| H27 | unknown kind names the mod | red |
| H28 | trust file removed on undo | red |
| H29 | ids sorted on export | red |
| H30 | export size cap | SURVIVED (the read-back check overlapped), then a test where JSON escaping pushes it over; red |
| H31 | missing-block note | red |
| H32 | `commit` of placed mods | SURVIVED, then tests that no `.mod-*` backup is left after a replace; red |
| H33 | nested steps not walked | SURVIVED (my first nested test used a wrong syntax and did not check ids), then fixed to a `repeat` with an id assert; red |
| A01 | app sends trust for any ticked id | red |
| A02 | app built-in confirm not needed | red |
| A03 | app ignores taken workflow name | red |
| A04 | `isEnvelope` always false | red |

The first run of the 33 server breaks was killed by the 10 minute background limit while H32 was applied; I put that one line back by hand (`const left = placed.flatMap((p) => p.commit())`), checked that every `from` string of every break is back in the files, and re-ran with a backup copy and output written per break.

## Existing tests edited

None. No golden, lockfile, `package.json` or browser test touched.

## Decisions and things to know

1. **Where the envelope code lives**: `actions.ts` (as the brief said), appended at the end; `importApply` and `importPreview` call into it (one dispatch line each). The file is now 1505 lines.
2. **The 1 MB cap is the same as the HTTP body cap.** A bigger envelope could not arrive anyway. The per-mod 1 MB, the file 1 MB, the 20 mods and the 256 KB workflow are each tested.
3. **Trust is by hash, per id, never a flag.** This is stricter than the single file's `trust: true`; the old path is unchanged.
4. **A Customize copy is accepted in a second home only on the built-in confirm.** There is no way to tell a real Customize copy from a stranger's file with a built-in's id, so the user's confirm (by id, in `replaceBuiltin`) is the gate, and the loader's existing rule still applies after: a copy of a built-in waits for a restart, shadows only what the built-in provides, and may not claim `pack`/`required`.
5. **Pack mods are never exported even when named.** The workflow's own built-in blocks (`say`, `phase`, ...) are skipped silently; a user who names one gets a 409.

## Not confirmed / left open

- No browser test. The new dialog, the Share button and the Settings button are checked by the helper tests and by server-side render of the buttons, not by a click.
- Export looks at the steps' KINDS only. A condition or a card mod that a workflow uses (for example a `cond-*` mod a user customized) is not added by the workflow scan; the user can add it by id from Settings (`ExportMine` sends all of them).
- `GET /api/sessions/:id/workflow` (the editor's diagnostics) still says the plain `Unknown step kind "x"` for a workflow whose mod is installed but not trusted yet; only the import reply names the mod. Naming it there needs the editor path to know the installed mods.
- A kind that is registered in core (the frozen three: none for blocks; the pack) is never "missing". A kind a user mod brought but that is DISABLED still exports its mod.
- JSON duplicate keys in the text of a file (`{"a":..,"a":..}`) are read by `JSON.parse` as the last one; there is nothing to detect after parsing. The case "two mods with one id" is covered through different keys with the same id inside.
- During the mutation round `actions.ts` held a break for about 15 seconds at a time. Groups F and P run tests in the same tree; a failure of theirs that names `actions.ts` or an envelope word in that window is mine. Nothing else was left changed.
- The tests start the real loader, so they load the real default pack. While group P's `playbook` mod was half done, the app test setup failed to load the pack for a few minutes ("`playbook`: `provides.attrs` does not list the heading key"); it was green again later with no change of mine.

## `git status --short` (my files)

```
 M packages/app/src/ImportSummary.tsx
 M packages/app/src/Providers.tsx
 M packages/app/src/TextTab.tsx
 M packages/server/src/mods/actions.ts
 M packages/server/src/server.ts
?? packages/app/src/ShareWorkflow.tsx
?? packages/app/test/importEnvelope.test.ts
?? packages/server/test/mods-envelope.test.ts
```
(`TextTab.tsx` and `server.ts` also hold other groups' edits; mine are two lines and one route line.)

## For the user: sharing a workflow with its blocks

**Export.** Open the workflow in Reins, save it, and click **Share** in the bar above the editor (next to Save). Reins works out which blocks the workflow uses and puts the mods that bring them into one file, `<name>.reins-mods.json`, together with the workflow. The blocks that come with Reins (say, phase, end and the rest of the default pack) are not in the file: everyone already has them. A block you customized, or one you installed, is. If the workflow uses a block that none of your installed mods brings, Reins tells you which one; the file is still made, and whoever opens it needs that mod. In Settings, **Export my mods** puts all the mods you installed into one file without a workflow.

**Import.** In Settings, click **Import** and choose the file (or paste its text). Reins shows ONE summary: every mod in the file with what it adds (blocks, conditions, cards, providers), and the workflow's name. Each mod that runs code has its own warning and its own box: **Trust and import: <mod>**. Nothing is trusted until you tick that box; leave it empty and the mod is installed but its code does not run (the workflow will then say, for example, `Unknown step kind "beep": the mod toy-beep brings it`, and you can trust the mod later in Settings). A mod with no code needs no box. If the file replaces a built-in mod, you must also confirm that. Then **Import the file**: either everything in it is installed and the workflow is saved in your workflows, or nothing is. If the same code was trusted before, it is not asked about again; if the code changed, it is.
