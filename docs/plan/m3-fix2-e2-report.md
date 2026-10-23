# M3 fix round 2, group E2 (loader, view data, words): N2, N6, N8

Tests of mine: `packages/server/test/m3-fix2-e2-n2.test.ts` (8), `m3-fix2-e2-n6.test.ts` (8), `m3-fix2-e2-n8.test.ts` (3). All green.
Neighbours run (`--maxWorkers=1`): 61 server files (mods, pack, m3-*, drive, catalog, kinds, loader, run-cli, import, absent, session, tags): 1192 pass, 1 red that is not mine (below). Core `m3-fix-d-view-data` and the whole app project: 922 pass. `npm run typecheck`: no error in my files (see "Unconfirmed").

## N2: a copy may say only what the built-in says

The re-check's fix is right; I made it the one rule in one place and closed the served side as well.

- `copyViewProblem(view, builtinView)` in `packages/core/src/viewShape.ts` (no kind names; plain data compare). `view.stops` is allowed only if the built-in says `stops: true`; every event in `view.coreRows` must be in the built-in's `coreRows`; a non-list fails closed.
- Loader: `validateMod` (`loader.ts`) gets an optional `bundledViews` map (built from the bundled scan) and, for a user mod whose id and kind are a bundled mod's, refuses with plain words after the kind's own checks. The Settings actions (`actions.ts`, the two `validateMod` calls: provider add and the import preview) now pass `bundledViews(env.mods)`. `bundledKinds` there also lists a copy that already stands in a built-in's place (before, a second import over an existing copy was judged as a mod with an id of its own on the `builtin` flag but had no bundled kind to compare to).
- Served: `LoadedMod.builtinView` (new field, `types.ts`) is set where the loader marks `replaces: 'bundled'`. `servedKinds` (`kinds-view.ts`) runs the same `copyViewProblem` on a copy's view and leaves it out with a line in `problems`, so the server serves what it accepted.
- Decision: a copy that REMOVES `stops` from `end` (or lists fewer `coreRows`) is ALLOWED. Less is no extra power, it is a customization (the block draws as an ordinary one), and refusing would make the rule "equal to", which is stricter than the threat.
- Class check, other view fields reached through the same `builtin` flag: `hidden` and `status` are already refused for core events and need `provides.events` whatever the flag says (`eventProblem`); `rows` for a core event needs `coreRows` (now bounded); `fresh.cond` is the editor default of a new block, no core event involved, left open for a copy; `questionRefusal(builtin)` lets only a `kinds` entry named like a question card through (`gate`), and the id and kind must match the bundled mod. `count`/`print`/heading are node data from trusted code, not the view.
- App-side defence (the row removed in `m2-fix-25a-a`): NOT restored. I built it (a server stamp `own: true` on a view of a mod that is neither pack nor copy, and the app's `viewShapeProblem` reading it). It broke `kinds-route.test.ts` (3 rows: "served is the manifest and not the code", "every key of the served view is a key the manifest's view holds"). Those pin that the served view is the manifest's view plus `trusted` only; weakening them to allow a second server key is worse than the missing app row, so I took the stamp out again. Without a stamp the app cannot tell a pack block from another without a list of kinds. The comment in `m2-fix-25a-a.test.ts:61` still says the server holds it; that is now true for both load and serve.

Red at HEAD (run before the fix, then the same file green after):
- `a data say with coreRows and stops is refused, and not served`: red (`problems` was empty).
- `stops alone on a copy of say is refused`: red.
- `one core event more than the built-in lists is refused`: red.
The other five rows (Customize copies of `end` and `subagent` load and serve; a copy of `end` without `stops`; a copy of `subagent` with fewer events; a mod with its own id cannot; served-side check) pass at HEAD or are new guards, as they should.

Mutations (sha256 before = after restore every time; files restored from saved bytes):

| # | Break | Result |
|---|---|---|
| a | loader skips the copy check | killed (3) |
| b | `stops` always allowed | killed (2) |
| c | `coreRows` `every` to `some` | killed (1) |
| d | `coreRows` always allowed | killed (1) |
| e | served check off | killed (1) |
| f | loader passes no bundled views | killed (3) |
| g | `copy` flag false | killed (3) |
| h | first version: dead "must be a list" branch removed | survived: the branch was dead (the shape check already refuses a non-list), so I folded it into the one fail-closed condition and re-ran c, d and a new h (built-in's list not consulted): all killed (1 each) |

Hashes (first 10 hex, before / mutated): loader `03ABEC1F44` (a: `39C8A2D782`, f: `91B12B2CFA`, g: `903D38A826`), viewShape (final) `3BD5563BCC` (c: `22A9AD5256`, d: `2F71EDD86B`, h: `28F9E77B05`), kinds-view `5A93F12CF7` (e: `115A9FB9F5`).

## N6: the "switched off" words

(a) Reload. `loader.ts` keeps `LOADS`, the words of every load not yet disposed, oldest first; `ABSENT_KINDS` is cleared and refilled from the newest (`showAbsent`) when a load fills and when one disposes. That is the owner token (the load's own map by identity), not string equality. It is better than "clear on fill, clear on dispose if last": a reload that is thrown away (`engines.ts` disposes the NEW load when the folder had trouble) gives the words of the load that stays back; clear-only would leave them empty. A second `dispose()` of one load removes nothing else (guarded). `engines.ts` needed no edit.
(b) A mod whose id fails `isModId` is skipped (the folder name never reaches the words); the length and characters of what reaches the line are then bounded by the id rule (at most 40, letters, digits, dash) and `KIND_NAME`. "Waiting for your trust" is now said only for a mod the loader stopped at the trust step after its manifest passed (`waiting` set); a code mod with a broken manifest that is also untrusted says "not loaded (Settings says why)".

Red at HEAD (rows ran against HEAD's behaviour through mutation N6-a/d/e, which put each HEAD rule back; the first run before the fix had 5 of 7 red, 2 of those for a test mistake of mine, fixed): two loads then dispose of the first: words gone; folder `evil<U+202E>txt.exe...` named; broken-manifest untrusted mod said trust.

| # | Break | Result |
|---|---|---|
| a | dispose by string equality (HEAD) | killed (2) |
| b | no clear before fill | killed (3) |
| c | oldest load speaks | killed (1) |
| d | no `isModId` | killed (1) |
| e | trust words for any untrusted code mod (HEAD) | killed (1) |
| f | `waiting` never filled | killed (1) |
| g | dispose twice removes the last load | first survived; added the test "a load disposed twice takes nothing else with it"; killed (1) |

## N8: `#own` is not shown

- `OWN_SUFFIX` is exported from the playbook mod (`mods/playbook/index.ts`, the one place the text is written; `ownKey` uses it). `packages/server/src/trackKey.ts` has the one helper `shownStep(key)`. Core names nothing. A bundled mod cannot import server code (none does), so the helper imports the constant from the mod's file; a Customize copy that changes its own suffix would not be stripped (a copy is a byte copy by default).
- Used in `run-cli.ts` (track started and ended lines), `drive.ts` (the USD card line and its question detail) and `session.ts` (the subagent title).
- Unconfirmed / honest: in `session.ts` the title is used only when the subagent has no `asks`; an own playbook always has `asks` (`Playbook <name>`), so the title the re-check quoted, `Subagent Playbook review-pass (...)`, is not reachable for a playbook today. The call goes through the helper anyway (the class: any track key). Mutation N8-f (session title raw) SURVIVES because no test can reach that line with a playbook; I did not build a contrived track for it.
- Existing test edited: `packages/server/test/m3-task-p-playbook.test.ts:198-199`: the two lines now expect `track playbook-1 started (Playbook review-pass)` and `track playbook-1 ended (...)` (was `playbook-1#own`), plus a `not.toContain('#own')`. Why: this is the behaviour the item changes, not a weakening; the cost and title checks are the same.
- The pause's `stepId` (`playbook-1#own`) is unchanged in the pause data and the saved run; only the words shown to the user change.

| # | Break | Result |
|---|---|---|
| a | helper returns the key | killed (3) |
| b | started line raw | killed (2) |
| c | ended line raw | killed (1) |
| d | USD card raw | killed (1) |
| e | strips the wrong end | killed (3) |
| f | session title raw | SURVIVED (unreachable for a playbook, see above) |

## Existing tests edited

Only `m3-task-p-playbook.test.ts:198-199` (above). `m2-fix-25a-a.test.ts` is untouched (its comment is still true).

## Not mine, red

`packages/server/test/kinds-route.test.ts:64` ("vitest.config.ts: the app project has the kinds setup..."): the root `vitest.config.ts` is edited by another group. `npm run typecheck`: `packages/server/test/m3-fix2-e3-guide.test.ts(59,25)` (group E3's file). The app project's `tsc` also lists many `NodeKinds`/`playbook` errors in app tests and mod files; they come from module augmentation the app project does not see and are not in a file I touched (I did not compare against HEAD, I cannot check out).

## Other files touched (small, same flag or field)

`packages/server/src/mods/types.ts` (`LoadedMod.builtinView`), `packages/server/src/mods/actions.ts` (the two `validateMod` calls and the built-in lists), `packages/server/src/mods/playbook/index.ts` (`OWN_SUFFIX`). Line endings kept per file (viewShape.ts and the playbook test were LF at HEAD, the rest CRLF; new files LF). No U+2014. Helper script folder `.e2mut` was removed.

## git status --short (my files)

```
 M packages/core/src/viewShape.ts
 M packages/server/src/drive.ts
 M packages/server/src/mods/actions.ts
 M packages/server/src/mods/kinds-view.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/mods/playbook/index.ts
 M packages/server/src/mods/types.ts
 M packages/server/src/run-cli.ts
 M packages/server/src/session.ts
 M packages/server/test/m3-task-p-playbook.test.ts
?? packages/server/src/trackKey.ts
?? packages/server/test/m3-fix2-e2-n2.test.ts
?? packages/server/test/m3-fix2-e2-n6.test.ts
?? packages/server/test/m3-fix2-e2-n8.test.ts
?? docs/plan/m3-fix2-e2-report.md
```
