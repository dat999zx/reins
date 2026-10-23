# M3 fix round, group D: share file, guard, import words, switched-off mods

Items 5, 6, 9, 10 of `docs/plan/m3-final-review.md`. Worktree `D:/coding/reins-wt-fork`, branch `feat/fork-playbook`, HEAD ee8b080. Nothing committed, added, stashed, reset or checked out. No `npm run build`. `npm run typecheck` is clean.

Run results at the end (`--maxWorkers=1`): the 63 server and app files that are my neighbours (mods-*, pack-*, m3-task-*, toy-*, tags, run-cli, kinds-route, m2-fix-25a, m3-fix-c, app import/share/canvas/rows/kinds/view tests): 1318 passed, 1 skipped, 0 failed. Core neighbours (format, removed-kinds, cond, registry, one-file-types, no-kind-branch, phase2, review-round1, refactor-3a-proof, setup-pack, my view-data file): 152 passed.

## Other groups' red tests (not mine)

Seen while another group was mid-edit: `core/test/m3-fix-a-engine.test.ts` (14 failed), `core/test/playbook.test.ts` (7 failed, own-playbook tests), `m2-money`, `m2-tracks`, `m2-tracks-fix`, `m2-pauses`, `m2-boundaries`, `usd-room`, `receipt-tracks` (all `ReferenceError: room is not defined` at `core/src/run.ts:608`, group A's edit), `m3-fix-b-stop` (3), `m3-task-y-fence` (4). None touches a file of mine. I did not rerun them after my last edit.

## Item 5: the share file

What was wrong: `kindsUsed` collected step kinds only.

What I did (`packages/server/src/mods/actions.ts`):
- `kindsUsed` is replaced by `usesOf(env, text)`. It walks the steps (kids and else branches), each step's `cond` atoms (`condAtoms`, so and/or/not are looked through), each step's cards, and the `whenever` autos (their `cond` and card).
- `holder(env, key, name)` is the one lookup "which mod provides this name": the user's mod first, else the bundled one. Used for kinds, conditions and cards. `exportBundle` adds a mod to the file only when its holder is a user mod (a Customize copy included). A bundled condition or card is never added. The old "block nobody brings" note and its wording are unchanged.
- Playbook note, as data and not by naming a kind: a block mod's manifest may have `"reads": { "noun": "playbook", "folder": "blocks", "name": ["title", "playbook"] }`. The `playbook` mod now says that. `usesOf` finds the holder of each step kind, takes the file name from the step (`title`, then the attrs named in `name`), and makes one note per `noun + name`. Core and `actions.ts` name no kind.
- `kinds.ts` checks `reads` (a noun, a folder, 1 to 4 field names, all plain names, nothing else) with the other block checks.
- Notes stay in the reply as `notes`. Order: the "block nobody brings" notes first, then the playbook notes in the order the playbooks appear.
- App: the Share button and "Export my mods" already showed every `notes` entry joined with `. ` in `ShareWorkflow.tsx`, so the new notes show with no change. I pulled the words into a tiny exported `exportWords(r)` so a test can pin them.

Exact wording of the new note (Group C: keep this stable):

`The playbook <name> is a file in your blocks folder and is not in this file. Whoever imports the file needs a playbook with that name.`

(`<name>` is cut at 80 characters with `...`. A name with a hidden character never gets here: the workflow text itself is refused first, status 400.)

Review fix check: the suggested fix is right. One difference: the review says "map each to the mod that holds it" for conditions and cards by walking the registry; I use the mod manifests' `provides.conditions` / `provides.cards` (the same data `BRINGS` already reads), because after a restart a user copy of a built-in is the only holder in the list.

Tests (new, `packages/server/test/m3-fix-d-share.test.ts`, 17 tests): a user condition in a repeat's `until:`; inside and/or/not and nested (an if's else, a repeat in it); in a `whenever`; a built-in condition and card are never added; an unused condition mod is not added and two uses add it once; a Customize copy of `cond-done` is carried while the bundled one is not; a condition named `store` is not the `store` block and the other way round; a user card on a step and on a `whenever`; playbook note for one name, inside a repeat and an else, two playbooks with one name (one note), two names (two notes), a long name cut, a hidden-character name refused, note order after the block notes, no note for a workflow without a playbook; export from one home, import into a second `tempHome` with trust, restart, parse with no error. App: `packages/app/test/m3-fix-d-share-summary.test.ts` (`exportWords`).

Red at HEAD: before I changed `actions.ts`, 13 of the 16 tests then written failed (`expected [] to deeply equal ['cm-ping']`, `['cd-zap']`, `['cond-done']`, the notes lists). The 3 that passed were the negative ones (built-in never added, no note without a playbook), as they should.

## Item 6: names in core and a guard that could not see them

Data moved out of core:
- `viewShape.ts`: `CAP = 'end'` and `EVENT_ROW_KIND` are gone. A view says `stops` or `coreRows` itself, and the check is "who may": `stops` and `coreRows` are accepted only from a pack block or its Customize copy (`scope.mod.pack`, which `kinds.ts` and `kinds-view.ts` already pass). The `end` manifest already had `"stops": true`. The `subagent` manifest now has `"coreRows": ["subagent_started", "subagent_result"]`. `coreRows` is a list of up to 8 events core logs. A row over a core event is accepted only if the same view lists it in `coreRows`. `mayRow(type, view)` takes the view now, not a kind name.
- Difference from the review: it says "move CAP into the end manifest's view data". The manifest already held it; what was in core was the name that decided who may. That decision is now "pack block" and not "named end". A Customize copy of any pack block can therefore also say `stops` (it is the user's own file; `stops` only changes how the block is drawn, the end behaviour is in the block's code). Said so in the comment.
- Served views: I first marked served pack views with `pack: true` so the app could check the same rule. That changed every served view and broke "a served view is the JSON of its manifest" (kinds-route, five pins). I took it out again. The server checks every manifest and checks again when it serves the view (`kinds-view.ts` `take`), so the app's third check is now shape only for `stops` and `coreRows`. A served view is again byte-for-byte its manifest (test pins it).
- `parse.ts` (the `whenever` default): a `whenever` whose condition does not parse still gets an auto (the error is reported) but with an atom nobody registers, `{ t: 'unparsed' }`, not `drift`. Unknown atoms evaluate false everywhere (`evalCond`, `evalCondSync`, `judgeOf`, `validate` all use `CONDS.get(...)?.`), so it never fires. One real change: `printCond` of an unknown atom returned `undefined` (it would print `whenever undefined`); it now returns `''` (`cond.ts`). Before, such a block printed back as `whenever drift`, a silent rewrite of what the user typed; that is gone too.

The guard (`packages/core/test/no-kind-branch.test.ts`, rewritten; the old one kept only its three file-structure tests at the end):
- Lists are built from the pack manifests: `provides.kinds`, `conditions`, `cards`, `ops` and `events`, found the same way as before (every `packages/server/src/mods/<id>/mod.json` with `pack`).
- A hit is a name as a whole quoted literal (single, double, template) or as a key (`name:`, `name?:`, at the start of a line or after `{ , ; (`). A longer text that holds the word is not a hit. Comment lines and trailing `// ...` are not read. Also `KINDS.name` and `KINDS['name']`. Events as before. `[data-kind=` in css.
- Scope: every `.ts`, `.tsx`, `.css` file in `packages/*/src`, except a pack mod's own folder.
- Allowlist: exact by name, then file, then number of lines (`ALLOW`), with one reason for each name. A new use, a changed count, a use that went away (stale) and a missing reason all fail. The judging is one function (`judge`) with its own unit test.
- Real hits: 419 lines in 172 (name, file) pairs. Besides the three the review named (all fixed above), none is a lookup of a pack block by name. They are the words of the language that happen to be pack names. Allowed, with reasons in the file:

| name | lines | files | why it stands |
|---|---|---|---|
| model | 98 | 35 | the model a request, setting or usage row names; the `model` field input; JudgeKind |
| stop | 78 | 20 | live-card and pause word: `run.stop()`, PauseReason, /stop, answer word |
| done | 45 | 19 | status word of run, step, receipt, API |
| now | 41 | 20 | live-card word `now` and `opts.now` clock |
| gate | 27 | 8 | the pause and question type core raises; palette colour; status rule key |
| run | 24 | 10 | feed piece type, thunks, the run command |
| end | 22 | 12 | ranges, stream events, canvas drop zone and `top: 'end'` position |
| say | 18 | 6 | CLI `say` callbacks, retry table, the chat's `say` event row |
| store | 14 | 9 | store objects and the Knowl `store` service |
| cmd | 13 | 7 | a command-string parameter; COND_PARAM_KEYS |
| approve | 10 | 6 | answer word to a gate question; hook decisions |
| recall | 9 | 2 | Knowl `recall` service and a track's recall list |
| phase | 4 | 3 | the app's RunPhase |
| same | 4 | 3 | SwitchOutcome `same`; tool approval dedupe key |
| attempts | 3 | 3 | step status count |
| subagent | 2 | 2 | JudgeKind and `vm.subagent` |
| drift | 2 | 2 | the workflow's `drift:` key |
| verify | 2 | 2 | palette colour |
| repeat, guard, diff | 1 each | 1 each | `drift.repeat`; refusal reason text; `git diff` |

Not fixed, and worth a decision later: `now` and `stop` are the control words of the live cards. Core (`run.ts` `LiveCardKind`, `interruptCard`), the session and the app's composer name them as part of the protocol, not through the card mods. They are allowlisted as vocabulary. If the plan wants those cards to be pure data too, that is a separate design.

Proof the guard works (planted in the real file `packages/core/src/display.ts`, sha256 before and after identical `1EB60B29...8923`, restored from the saved bytes): `const PLANT1 = 'subagent'`, `"end"`, `[].includes('gate')`, `{ recall: 1 }`, `const X = 'verify'`, `` `playbook` ``, `c.t === 'tests'`, `'guard'`, `'LOOP_IN'`, `{ fork: 1 }`: all 10 fail the guard test. Quiet as intended: `'the end is near'` and a `// const x = 'subagent'` comment: pass.

Red at HEAD: `m3-fix-d-view-data.test.ts` against the HEAD copies of viewShape, parse, fields, cond and the subagent manifest: 12 of 13 failed (the 13th pins that `end` already says `stops`). The first run of the new guard on HEAD sources listed `viewShape.ts` (9 lines) and `parse.ts` (2 lines) among 392 lines.

## Item 9: the tracks line

- Manifest data, no kind named: a block mod may say `"tracks": true` (`kinds.ts` `shareProblems`: true or false, nothing else). `playbook`, `fork` and `subagent` say it.
- `actions.ts`: `ImportSummary.tracksLine` is `TRACKS_LINE` = `This mod may run several sessions at once and spend money on them.` It is set for a block mod with code when the manifest says `tracks: true` or when a `.js/.mjs/.cjs` file of the mod contains `tracks.start` (spaces and line breaks around the dot allowed). The code is read as text, never run. The code prompt `CODE_PROMPT` is unchanged word for word.
- App: `importLines.ts` `planOf` carries `tracksLine` only when there is a code prompt; `ImportSummary.tsx` shows it under the code prompt for a single mod and for each mod of a mods file (`EnvelopeMod` is exported for the test). Text only.
- Not built: a run-time fence on `vm.tracks.start` (the review's alternative was this line or a plan note). A mod that hides the call (a computed name) and leaves the manifest silent gets no line. Comment in the code says so.
- Tests: `m3-fix-d-summary.test.ts` (9) and the app file: manifest flag, three spellings of the call, none for a mod that does neither, `tracks` values other than a boolean refused, a text file that mentions the call is not a call, `reads` shapes refused, none for a data block, a condition mod, a provider, per mod in an envelope; app: plan, single dialog, envelope mod, `<b>` shown as text.
- Red at HEAD: 5 of 8 failed when written (the 3 passing were the negative ones).

## Item 10: switched-off mods

- One place makes the line: core `unknownKind(kind)` (`nodes/index.ts`), used by `parse.ts` and `validate.ts`. It reads `ABSENT_KINDS` (kind to words), which the loader fills at the end of `loadMods` (`loader.ts`) and empties in `dispose`. So the parse, `validate`, the editor check, `reins check`, `reins run` and the import preview all say the same.
- Words: `Unknown step kind "recall": it comes with the mod recall, which is switched off in Settings`. For a mod waiting for trust: `..., which is waiting for your trust in Settings`. For a mod that did not load or broke: `..., which is not loaded (Settings says why)`. Only a block mod with a plain kind name, only when core does not hold the kind (a carried one that waits for a restart is not "absent"). A kind nobody brings keeps the bare line.
- Chat: `tags.ts` `unknown tag "recall"` gets the same `: it comes with ...` ending.
- Envelope preview: `unknownKinds` keeps its "the mod X brings it" for a kind the file brings, and now also reads a line that carries the new ending.
- A removed mod: the server has no record of which kinds it had, so the line stays bare. Not done.
- Tests (`m3-fix-d-absent.test.ts`, 11): parse and validate; two mods off; a required mod named in a hand-edited list; dispose leaves nothing; trust-waiting, throwing and switched-off user mods; a disabled condition mod that lists kinds adds no hint; odd kind names add nothing; import preview; `reins check` and `reins run` (nothing run); chat tag. `pack-mods.test.ts` now also pins the words for every pack mod that can be switched off.
- Red at HEAD: HEAD's message is the bare one, which the mutations below reproduce (10a, 10b, 10c, 10j each fail the tests: 6, 2, 1, 1 failed).

## Mutation round

Method: `node` script, one exact text replaced, the named test files run with `--maxWorkers=1`, then the saved bytes copied back and sha256 compared (every run ended `restored=True`). No `git checkout`.

| id | file | change | result |
|---|---|---|---|
| 5a | actions.ts | cards not walked | killed (2) |
| 5b | actions.ts | conditions not walked | killed (7) |
| 5c | actions.ts | whenever conditions ignored | killed (1) |
| 5d | actions.ts | whenever cards ignored | killed (1) |
| 5e | actions.ts | else not walked | killed (2) |
| 5f | actions.ts | kids not walked | killed (2) |
| 5g | actions.ts | playbook notes dropped | killed (7) |
| 5h | actions.ts | notes not deduped | killed (1) |
| 5i | actions.ts | bundled holder before user holder | SURVIVED, equivalent: a user mod that replaces a built-in takes its place in the list, so two holders of one name never both appear. The preference is kept from the old code. |
| 5j | actions.ts | step conditions ignored | killed (5) |
| 5k | actions.ts | step cards ignored | killed (2) |
| 5l | actions.ts | no `reads` read | killed (7) |
| 5m | actions.ts | name not cut | killed (1) |
| 5n | actions.ts | bundled cond/card mods added | killed (8) |
| 9a | actions.ts | manifest `tracks` ignored | killed (2) |
| 9b | actions.ts | code scan misses spaced call | killed (1) |
| 9c | actions.ts | data block with tracks gets line | killed (1) |
| 9d | actions.ts | non-block can get line | killed (1) |
| 9e | actions.ts | field dropped | killed (3) |
| 9f | actions.ts | every file scanned | killed (1) |
| 9g | kinds.ts | `tracks` not validated | killed (1) |
| 9h | kinds.ts | `reads.name` not bounded | killed (1) |
| 9i | kinds.ts | `reads.folder` not validated | killed (1) |
| 9j | importLines.ts | line without a code prompt | killed (1) |
| 9k | ImportSummary.tsx | single dialog drops line | killed (1) |
| 9l | ImportSummary.tsx | envelope mod drops line | first run SURVIVED; I exported `EnvelopeMod` and added a test; now killed (1) |
| 10a | nodes/index.ts | bare line | killed (6) |
| 10b | parse.ts | parse says bare line | killed (2) |
| 10c | validate.ts | validate says bare line | killed (1) |
| 10d | loader.ts | other words for off | killed (7) |
| 10e | loader.ts | broken enabled mod says nothing | killed (1) |
| 10f | loader.ts | dispose leaves words | killed (2) |
| 10g | loader.ts | kind names unchecked | killed (1) |
| 10h | loader.ts | registered kind may carry hint | killed (1) |
| 10i | loader.ts | untrusted looks like broken | killed (1) |
| 10j | tags.ts | chat tag no hint | killed (1) |
| 10k | actions.ts | preview regex ignores hint | killed (1) |
| 10l | loader.ts | any mod kind may carry hint | first run SURVIVED; added the disabled-condition-mod test; now killed (1) |
| 6a | viewShape.ts | anyone may `stops` | killed (2) |
| 6b | viewShape.ts | anyone may list `coreRows` | killed (4) |
| 6c | viewShape.ts | `mayRow` ignores coreRows | killed (8) |
| 6d | viewShape.ts | served rows unchecked | killed (1) |
| 6e | viewShape.ts | every mod is a pack block | killed (6) |
| 6f | viewShape.ts | any scope is a pack block | killed (6) |
| 6g | viewShape.ts | served view may say `pack` | killed (1) |
| 6h | viewShape.ts | `coreRows` any event | killed (1) |
| 6j | parse.ts | failed whenever is `drift` again | killed (2) |
| 6k | cond.ts | unknown atom prints undefined | killed (1) |
| 6l | viewShape.ts | `coreRows` length unbounded | first run SURVIVED; added the 8/9 length test; now killed (1) |
| 6m | kinds.ts | Customize copy held to the user rule | killed (8) |
| g1..g4, g6 | no-kind-branch.test.ts | key rule off; single quotes only; trailing comments read; comment lines read; pack folders scanned | killed (2, 2, 1, 2, 2) |
| g5, g7, g8 | no-kind-branch.test.ts | counts not exact; reasons not needed; stale not reported | first run SURVIVED; pulled `judge` out with a unit test; now killed (1 each) |
| plants | display.ts | the 12 planted lines above | 10 fail the guard, 2 correct passes |

Two removed defences I decided not to keep: `showText` on the playbook name (unreachable, the workflow text is refused for hidden characters before), and the `pack: true` served mark (above).

## Existing tests edited, and why

- `core/test/no-kind-branch.test.ts`: rewritten as above (CRLF kept).
- `server/test/m3-task-Z-moves.test.ts`: two tests pinned `mayRow(type, kindName)` and the subagent kind name; they now pin `mayRow(type, view)` with `coreRows`, pack scope and the user scope.
- `server/test/m3-task-3-moves.test.ts`: the refusal words for `stops` are now "only for a block of the default pack".
- `server/test/m3-task-Z-pin.expected.json`: the recorded subagent view gets `coreRows` (hand edit after the `fresh` key, same JSON style; a round trip of the file was identical before the edit). `end` is unchanged.
- `server/test/pack-mods.test.ts`: the switched-off check accepted only the bare line; it now takes the line with the ending and pins the words.

## Shared files I touched (small targeted edits, re-read before each)

`core/src/nodes/index.ts` (+`ABSENT_KINDS`, `unknownKind`), `core/src/validate.ts` and `core/src/format/parse.ts` (use `unknownKind`; parse line 242 area), `core/src/cond.ts` (`printCond` default), `core/src/nodes/fields.ts` (`stops`, `coreRows` doc/type), `core/src/viewShape.ts`, `server/src/mods/kinds.ts` (`shareProblems`), `server/src/mods/loader.ts` (end of `loadMods`; another group edited the same file at the same time and my edits applied cleanly), `server/src/mods/actions.ts`, `server/src/tags.ts`, `app/src/rows.tsx`, `app/src/importLines.ts`, `app/src/ImportSummary.tsx`, `app/src/ShareWorkflow.tsx`, manifests `playbook`, `fork`, `subagent`. `kinds-view.ts` was edited and put back (net no change).

For Group C (guides): two new optional manifest keys of a block mod, `tracks` (true or false) and `reads` (`{ noun, folder, name }`), worth a line each in `PACK.md`; and the export `notes` wording above.

## Unconfirmed

- The built app bundle was not rebuilt and no browser run was made; the app changes are covered by render tests only.
- `tracks` is advisory: nothing at run time stops a mod from starting tracks it did not declare.
- A removed mod's kinds are not named in the unknown-kind line.

## `git status --short` for my files

```
 M packages/app/src/ImportSummary.tsx
 M packages/app/src/ShareWorkflow.tsx
 M packages/app/src/importLines.ts
 M packages/app/src/rows.tsx
 M packages/core/src/cond.ts
 M packages/core/src/format/parse.ts
 M packages/core/src/nodes/fields.ts
 M packages/core/src/nodes/index.ts
 M packages/core/src/validate.ts
 M packages/core/src/viewShape.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/server/src/mods/actions.ts
 M packages/server/src/mods/fork/mod.json
 M packages/server/src/mods/kinds.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/mods/playbook/mod.json
 M packages/server/src/mods/subagent/mod.json
 M packages/server/src/tags.ts
 M packages/server/test/m3-task-3-moves.test.ts
 M packages/server/test/m3-task-Z-moves.test.ts
 M packages/server/test/m3-task-Z-pin.expected.json
 M packages/server/test/pack-mods.test.ts
?? packages/app/test/m3-fix-d-share-summary.test.ts
?? packages/core/test/m3-fix-d-view-data.test.ts
?? packages/server/test/m3-fix-d-absent.test.ts
?? packages/server/test/m3-fix-d-pack-view.test.ts
?? packages/server/test/m3-fix-d-share.test.ts
?? packages/server/test/m3-fix-d-summary.test.ts
```
(`fork/mod.json`, `playbook/mod.json`, `playbook/index.ts`, `loader.ts`, `run.ts` and others also carry other groups' edits.)
