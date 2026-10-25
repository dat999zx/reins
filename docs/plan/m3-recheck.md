# M3 re-check of the fix round (at 91e49c9)

Scope: `git diff ee8b080 91e49c9`, the four fix reports, and `docs/plan/m3-final-review.md` items 1 to 11. The worktree was clean at 91e49c9 the whole time (checked at the start and the end), so files read in it are the commit's bytes. Probes ran in a `git archive` copy of 91e49c9 under `%LOCALAPPDATA%/Temp/m3re` (node_modules and `packages/server/dist` linked from the worktree; that `dist` carries the fix round, checked by `#own` and `reads` in it). Nothing in the worktree was changed except this file. Line numbers are at 91e49c9.

Runs at 91e49c9 (temp copy, `--maxWorkers=1`): the whole core project, 79 files, 1043 tests, green (includes my two core probes). The fix round's own server files, one by one: `m3-fix-b-customize` 5, `m3-fix-c-guide-examples` 23, `m3-fix-d-absent` 12, `m3-fix-d-pack-view` 6, `m3-fix-d-share` 17, `m3-fix-d-summary` 11, `m3-task-3-moves` 8, `m3-task-Z-moves` 5, `m3-task-p-playbook` 16, `m3-task-y-moves` 4, `pack-mods` 118, `m2-track-sessions` 2: all green. Not run: the app project and the whole server folder.

## Items 1 to 11

| # | Item | Verdict | Where |
|---|---|---|---|
| 1 | fork branch whose first block is an own playbook | FIXED | `packages/server/src/mods/playbook/index.ts:157` (`ownKey`), `:168` (track starts as `<step>#own`), `:261-263` (a step named `<step>#own` is refused) |
| 2 | own playbook with no `usd:` had no cap | PARTLY | `packages/core/src/run.ts:567-570` (`sliceCap` caps every track with no share at the room). Still open: a track with no share started inside a track that has one (new MAJOR N1) |
| 3 | Customize cut long commands and titles on save | FIXED | `packages/core/src/guard.ts:98`, `:102`; `packages/server/src/mods/loader.ts:376`, `:469` |
| 4 | guides missing or wrong | FIXED, with wrong claims left (MINOR N9) | `packages/server/src/mods/PACK.md`, `packages/core/src/nodes/README.md`, `packages/server/src/mods/README.md`, `CHANGELOG.md`, `README.md` |
| 5 | share file left out conditions, cards, playbook files | FIXED | `packages/server/src/mods/actions.ts:1469` (`holder`), `:1475` (`usesOf`), `:1533` (notes) |
| 6 | kind names in core; guard blind | PARTLY | names gone: `packages/core/src/viewShape.ts:25`, `:97-108`, `packages/core/src/format/parse.ts:242`. The guard misses two plain hardcodes (MINOR N5), and the move to data opened MAJOR N2 |
| 7 | core tests did not run the pack as production does | FIXED | `packages/core/test/pack.ts:67`; the real bug it found is fixed at `packages/core/src/run.ts:1993`, `:1997` |
| 8 | Stop did not wait for a copy's command | FIXED as asked | `packages/core/src/run.ts:904-906`, `:1754`. New MINOR N4: a copy whose op never ends now holds Stop, `/close` and server shutdown |
| 9 | import summary said nothing about tracks | FIXED (the line the review offered) | `packages/server/src/mods/actions.ts:836`; advisory only, no run-time fence (said in the code) |
| 10 | switched-off mod gave a bare "Unknown step kind" | PARTLY | `packages/core/src/nodes/index.ts:205-207`, `packages/server/src/mods/loader.ts:733-748`. The words go away after the first Settings reload, and a broken mod's raw folder name reaches the line (MINOR N6) |
| 11 | shares round to a millionth, not a cent | FIXED | `CHANGELOG.md`, `PACK.md:357`. The spec edit (`docs/plan/2026-10-17-m2-spec.md:487-489`) is in `docs/`, which `.gitignore:12` ignores, so it is not in the commit |

### Proof per item

- **1.** Probe: an own playbook track saved with the OLD key (`playbook-1`, as ee8b080 saved it; made by renaming the key in a 91e49c9 snapshot) restores and runs to `done`, one `playbook_done`, cap 1 kept. Restore never derives the key, it reads `tracks[].key` and `groups[].keys` as saved (`run.ts:1729-1734`), and kind versions did not change, so no "saved with other blocks". By reading, the ee8b080 stuck case (branch paused with `track "pb" is live`) now resumes: Resume runs PLAYBOOK again, `take` finds nothing, and the track starts as `pb#own`. A step literally named `x#own` next to an own playbook `x` is refused; next to an inline playbook it is allowed (no track, no clash); `__proto__` as a playbook id is refused by the old id rule. The key is used as a DOM id only through `FeedView.tsx:13` (non-word characters become `_`), as a `Map` key in the app (`stepStatus.ts`, `runState.ts`), as `usdSpent` key (own-key check), and as the subagent `step`/title. Never as a path or file name. Cosmetic: the user sees `#own` (MINOR N8).
- **2.** Probe at 91e49c9 confirms the main-line case is fixed (group A's tests). The gap is real and measured, see N1.
- **3.** The Customize test runs the real loader on five copies and gets the built-in's bytes back. Is the weaker print flag a new hole? No. Only `fit` (heading text, default id) and Stop read `ModInfo.builtin` (`guard.ts:102`, `run.ts:906`); `count`/`print` lines, event names and keys stay tamed (`guard.ts:161-172`). A copy that gets `builtin` is a code mod the user trusted (a data block has no heading and no `defaultId`), and the trust prompt already says such code runs with the user's rights and Reins cannot limit it (`actions.ts:829`): it can write the workflow file or the terminal directly, so an unguarded print gives it nothing new. What DID widen is the manifest flag, not `ModInfo.builtin`: see N2.
- **4.** I ran two worked examples exactly as printed, taking the fenced text out of `PACK.md` by code: the `ping` block (`mod.json` and `index.js` into a temp `REINS_HOME`, trusted by hash) and its workflow: `reins check` says ok, `reins print` gives the same bytes back, `mode: sideways` gives `mode must be read-only or write, not "sideways" (step "ping-1")`, and `ping` compiles to TURN, END. The playbook pair (`blocks/review.reins.md`, `ship.reins.md`), the inline form and the fork example: `reins check` ok for all three. Untrue or missing text: N9.
- **5.** Export walks kinds, condition atoms (through and/or/not), cards, `whenever` autos and `reads`; only user mods are added. The import path (per-mod trust by hash, all or nothing, `replaceBuiltin`) is unchanged apart from the `unknownKinds` regex (`actions.ts:1360-1366`). Group D's 17 tests pass, including export from one home and import into another.
- **6.** See N5 for the plants and N2 for what moving `CAP` and `EVENT_ROW_KIND` into data opened.
- **7.** `pack.ts:67` marks every pack block `{ id, events, pack, builtin }`. Marking it also showed that a copy still runs differently from the built-in in many places (MAJOR N3).
- **8.** See N4.
- **9.** `startsTracks` (`actions.ts:836`): manifest `tracks: true` or the text `tracks.start` in a `.js/.mjs/.cjs` file. A computed name escapes it; the code comment says so. Spec 9's run-time guard on `vm.tracks.start` is still not built; with N1's fix, money is held anyway.
- **10.** See N6.
- **11.** Text checked; only the git point above.

## New findings

### BLOCKER

None.

### MAJOR

#### N1. An own playbook with no `usd:` inside a fork branch is held to the workflow room, not to its branch's share: the total limit does not hold

- Where: `packages/core/src/run.ts:584-593` (`startTracks`: the playbook's track gets no `share` because its spec has no `share: true`, and no slice because it has no `usd`), `:567-570` (`sliceCap` caps it at `usdRoom(t)`, the workflow room), `:1130-1137` (`guardUsd` checks a share only for a track that has one), `:1041` (a subagent on that track: same, `shareRest(t)` is undefined). The spend IS counted up into the branch (`:1259`), but nothing reads the branch's share while the branch is parked.
- Reproduction (probe, core project, 91e49c9): workflow `usd: 2.00`, `## fork` with `next: p1` and `next: p2`, each branch's first block an own `review-pass` playbook with no `usd:`. The branches get `share=1` each; the two playbook tracks open at the same time with `maxUsd=2` and a live room of 2 each. Script 0.75 + 0.75 per playbook: every reply is under its cap, the run ends paused on the USD card with `spent 3` for `limit 2`. With 0.8 + 0.8 for one and 0.1 x 3 for the other: the run finishes `done`, branch `p1` spent 1.60 of its 1.00 share, with no warning and no card.
- How bad: with a provider that holds the cap for the life of its process (`cap: 'process'`, the CLI path), each of N branches may legally spend the whole room, so a run can spend up to N times its USD budget. One branch can also take the other's share: whatever it spends comes out of the room the sibling's live cap reads. The shipped blocks reach this with no code mod; the share design exists to stop exactly this. Before the fix round it had no bound at all, so it is better, not fixed.
- Smallest fix (tried in the temp copy): two lines in `run.ts`.
  - `:587`: a track with no share and no `usd` of its own, started by a track that has a share, inherits what that share has left:
    `...(share !== undefined && s.share ? { share } : !(typeof s.usd === 'number' && s.usd > 0) && parent.share !== undefined ? { share: capOf(Math.max(0, this.shareRest(parent)!)) } : {}),`
  - `:710` (`held`): skip a parked track, whose share its child is now spending: `if (x !== except && !this.parked(x))`.
  - Result: the two playbook tracks open with `maxUsd=1` and a room of 1 (was 2 and 2); the whole core project stays green (79 files, 1043 tests). When the child is cut at the share, `guardUsd` takes the ordinary re-share path. Change `m3-fix-a-engine.test.ts:272-273` to `toBe(1)` and add the two-branch case above. `regrow` (`:866-875`) also counts the parked parent; that only shapes an Allow and I did not test it.

#### N2. A mod that takes the place of a built-in may now draw the feed row of any core event, and say `stops`; a data block (no code, no code prompt) is enough

- Where: `packages/core/src/viewShape.ts:97` (`packed` = `scope.mod.pack`), `:104-108` (`stops` and `coreRows` allowed when packed, `coreRows` may list ANY core event), `:164`; `packages/server/src/mods/kinds.ts:267` (scope `pack` comes from the manifest `builtin` flag, which is true for ANY user mod with a bundled id and kind, `loader.ts:307`); `packages/server/src/mods/kinds-view.ts:74` (served views: `mod.replaces === 'bundled'`); `packages/app/src/rows.tsx:27` (the first view by order that lists an event draws it), `:43`.
- Before this round only a view of kind `subagent` could draw `subagent_started` and `subagent_result`, and only kind `end` could say `stops`.
- Reproduction (probe, real loader, temp home): a DATA block `say` (`turn: "Say hi."`, no `main`) with `view.coreRows: ["refusal", "run_paused", "judge", "link_budget_exceeded"]`, rows `refusal: "Allowed: nothing was refused."`, `run_paused: "The run finished."`, `judge: "Judge: passed."`, and `stops: true`. It loads with no problem (`source user`, `replaces bundled`) and `servedKinds` serves it with all of that; `servedKinds().problems` is empty. The same view on a mod with its own id is refused. The app accepts a served view with `coreRows` (no scope means packed, `viewShape.ts:97`). That the feed then draws these words for those events I read from `rows.tsx:27-43` and `rows/hidden.ts:5` (none of the four has a row file or is hidden); not seen in a browser (unconfirmed).
- Why it matters: through import, the only gate is the "Replace the built-in say" box; a data block gets no code prompt. The feed is how the user sees what core did (a refusal, a judge's verdict, a pause, a link limit), and such a file can make those rows say something else. Because the first view by order keeps an event, a low-order replacement can also take the `subagent` rows. `stops: true` on a non-end block draws it as a cap with no links out.
- Smallest fix: a copy may say only what the built-in it replaces says. In `validateMod` (`loader.ts:304-307`), for a user mod with a bundled id, refuse a `view.stops` or `view.coreRows` that differs from the bundled manifest's (a Customize copy is a byte copy, so it passes). Test: the probe above is refused; a Customize copy of `end` and of `subagent` still loads.

#### N3. A Customize copy still runs differently from the built-in in 17 core behaviours (pre-existing; my first review missed it)

- Where: a copy's ops and NODE `exec` take the fenced route (`run.ts:1897`, `:1993`, `:1997`), and a mod's pause is rebuilt by `modPause` (`run.ts:345-351`), which drops the condition, the title and the track ("never a track, a title, a condition"). Only Stop (item 8) and print (item 3) were aligned.
- Reproduction (temp copy): mark the core test pack as the loader marks a copy (`pack.ts:67`, mark `{ id, events, builtin: true }` without `pack`), run the core project: 18 tests fail (one is the guard test that expects `pack`; 17 are behaviour). Examples:
  - `m1-snapshots` P1a and P1b, `m2-pins` Q9: a copy of `gate` pauses without its `cond`, so the saved run differs and the `reins run` card reads "until you approve" instead of the gate's condition (`drive.ts:124`).
  - `m2-pauses`: a track's gate pause loses its title, and the change-request retry per track differs.
  - `m2-boundaries` X5, X6; `m2-money` 4 and 5, the live re-share, bound 11, S6 (CARRY_ON and re-share); `m2-tracks-fix` 3 and 5 and `receipt-tracks` (close with a copy of `subagent` leaves the track paused "did not move on", the bug group B fixed for the pack only).
- This was the same at ee8b080 (`modPause` and the fenced copy route predate the round). It matters because PACK.md and the CHANGELOG tell strangers that Customize gives "the same block" you can change, and `gate`, `subagent`, `run`, `verify`, `repeat` are the blocks people will customize.
- Smallest fix: the fence on a copy buys no safety (trusted code runs with the user's rights, `actions.ts:829`), so route `builtin` like `pack` at `run.ts:1897`, `:1993`, `:1997` (and the op route's pause), then run the core project once more with the copy mark: it should be green. If the fence must stay, say in PACK.md "Customize" which of these differ. Either way, keep the copy-mark run as a second core test project so the two paths cannot drift again.

### MINOR

#### N4. Stop now waits forever for a copy whose op never ends, and so do `/close` and server shutdown

- Where: `run.ts:906` (`cutMods(true)` spares every `builtin` mod), `drive.ts:87` (the driver awaits `step()`) and `:113` (`close()`, which would cut it, comes only after), `session.ts:1085-1086`, `:1112-1113` (`await worker` with no time limit).
- Reproduction (probe, server project): register a `builtin` op that returns a promise that never settles, run it under `driveRun`, `await run.stop()`: the run says `stopped`, and the worker is still waiting 1.5 s later. The same op without `builtin`: the worker ends at once.
- The built-in cannot do this: its command has a 10 minute timeout and is then killed (`commands.ts:22`, `:47-50`). A hostile trusted mod can hang the process anyway, so this is about a buggy copy.
- Smallest fix: on Stop, cut a `builtin` op after a grace instead of never (for example the same 10 minutes: `setTimeout(a, 600_000).unref()` in `cutMods` when `stopping && mod.builtin`), or cut it at once unless it is inside `vm.command`.

#### N5. The new guard misses the most direct hardcode, `kind === '<name>'`, when the line or file is already allowed

- Where: `packages/core/test/no-kind-branch.test.ts:34` (`skipLine`: a line that starts with `/*` is not read at all), `:40` (a line counts once per name, however many hits), `:346-355` (the allowlist is by file and LINE COUNT).
- Plants, in the temp copy, then the guard run: (1) in `core/src/run.ts`, on the two lines that already hold `'gate'` (`const f = this.awaiting(track, 'gate');`), I appended `if ((this.program[this.programCounter] as { kind?: string })?.kind === 'gate') return false;`. (2) In `core/src/validate.ts`, a new line `/* PLANT2 */ if (step.kind === 'end') continue;`. All 13 guard tests pass. A control line `if (step.kind === 'fork') continue;` is caught (`fork in packages/core/src/validate.ts: 1 line(s), not allowed`). The ee8b080 guard would have caught both plants: its `kind\s*[!=]==\s*'(...)'` rule had a two-line exact-text allowlist and did not skip `/*` lines.
- Also: a new use in an allowed file passes as soon as someone bumps the count, and the reasons are per name, not per line.
- Smallest fix: keep the old exact forms as hard rules with no allowlist (`kind ===/!== '<kind>'`, `.t ===/!== '<atom>'`, `case '<OP>'`, `NODES.get('<kind>')`, `KINDS.<kind>`); count hits, not lines; strip a leading `/* ... */` instead of skipping the line.

#### N6. The "switched off" words vanish after a reload, and a broken mod's raw folder name reaches them

- Reload: `engines.ts:47-59` loads the new set, then disposes the old; the old load's `dispose` (`loader.ts:748`) deletes every entry whose words EQUAL its own, which are the new load's words for a mod that is still off. Probe: two loads of one home, dispose the first: `ABSENT_KINDS.get('deploy2')` goes from the words to `undefined`. In the app every Settings action reloads, so after the first one the line is bare again until a restart. Fix: `ABSENT_KINDS.clear()` before filling, and in `dispose` clear only if this load was the last to fill (an owner token, not string equality).
- Folder name: `loader.ts:517` uses the folder name as the id when the manifest id is bad, and `:739` puts `m.id` into the words. Probe: a folder `evil` + U+202E + `txt.exe` + 150 x `x` with a bad id and `provides.kinds: ["deploy"]`: `parseWorkflow` gives a 257-character line holding U+202E. `reins check` escapes it (`cli.ts:86`); the app's editor line I did not check (unconfirmed). Only someone who can write into `~/.reins/mods` can do this. Fix: skip a mod whose id fails `isModId` (one line at `loader.ts:734`).
- Words: a code mod with a broken manifest that is also untrusted says "waiting for your trust in Settings" (`loader.ts:737`), but trust will not load it (seen in the same probe: the bad-id mod got these words).

#### N7. Two edits to existing tests are in no report, and one more pins a looser rule

See "Test weakening" below: `packages/app/test/m2-fix-25a-a.test.ts:61` and the deep-condition lines of `packages/server/test/m3-task-p-playbook.test.ts:135-137`.

#### N8. `#own` is shown to the user

`reins run` prints `track playbook-1#own started` (pinned in `m3-task-p-playbook.test.ts:197`), the USD card says `block playbook-1#own used its $1 budget` (`drive.ts:152`, the slice's step is the key), the tool approval title is `Subagent Playbook review-pass (\`pb#own\`)` (`session.ts:519`), and the pause's `stepId` names no step the app can mark. No guide mentions the key. Fix: print the playbook's step (strip `#own`) in those three lines, or say it in PACK.md "Write a playbook".

#### N9. Guide text that is untrue or missing

- `PACK.md:355` "each branch has its own spend and its own share" and `CHANGELOG.md` ("its own share of the USD budget"): not true for an own playbook with no `usd:` in a branch (N1). `PACK.md:298` "the playbook then has no budget of its own" reads as "no cap"; since item 2 it is capped at the room.
- `coreRows` is in no guide (`PACK.md`, both READMEs); the nodes README list of view keys (`packages/core/src/nodes/README.md:188`) has `stops` but not `coreRows`, and neither says only a pack block (or its copy) may use them.
- `packages/core/src/nodes/README.md:22` "Nothing in core ... may name a block": 419 lines do, by allowlist, and N5 shows two that are not seen.

#### N10. Item 11's spec note is outside git

`docs/plan/2026-10-17-m2-spec.md` is ignored (`.gitignore:12`) and not in 91e49c9 (`git ls-files` returns nothing). Strangers read the CHANGELOG and PACK.md, which are right; the spec fix lives only in this worktree.

## Answers to the brief's hunt list

1. **Money.** Every place that opens a session reads a cap now: tracks through `ensureTrackSession` (`run.ts:549-553`), subagents through `subagentTurn` (`:1041-1052`), the main line through its live room (`:630`). With no limit anywhere there is no cap, as designed. A restored run opens its tracks through the same code. The one gap is N1, and it does break the total limit, by up to N times the room with process-held caps; fix above, tried and green.
2. **Customize trust.** No new reach through `ModInfo.builtin`: only heading text, default id and Stop read it, and only a trusted code mod gets it. The widening is the manifest flag through `viewShape` (N2), reachable with no code. Stop: a copy can now hold Stop and shutdown in a way the built-in cannot (N4).
3. **Key rename.** No path, file name, regex or session file uses the key; `Map`s and an `Object.hasOwn` dictionary hold it; the DOM id is cleaned. Old snapshots resume (probe). An older Reins reading a new snapshot: by reading it works (keys are opaque strings), not run. Shown words: N8.
4. **Guard and `ABSENT_KINDS`.** Guard: N5 (two plants pass). `ABSENT_KINDS`: no leak between test files (each file has its own module); within a file a load that is not disposed leaves words. Reload: N6. Hidden characters and length: kind names are held to `KIND_NAME`, but the mod id is not (N6).
5. **Items 5, 9, 10.** 5 holds, trust and all-or-nothing unchanged. 9: the line shows under the code prompt only, for a single mod and for each mod of a share file. 10: N6.
6. **Guides.** Two examples run as written, plus the inline playbook and the fork file: all clean. Wrong text: N9.
7. **Test weakening**: below.

## Test weakening: existing tests edited in `git diff ee8b080 91e49c9 -- 'packages/*/test'`

| File | What changed | Weakened? |
|---|---|---|
| `packages/app/test/m2-fix-25a-a.test.ts` | the row "stops on a kind that is not end" removed | YES. The app no longer refuses `stops` (or `coreRows`) on any served view; it trusts the server, which N2 shows lets a replacement through. Not in any report (group A saw it red and called it another group's). |
| `packages/core/test/m2-money.test.ts` | a plain split now expects `maxUsd 1` and a room of 1 on two opens | No (the new rule, and the count of opens is now pinned). |
| `packages/core/test/no-kind-branch.test.ts` | rewritten: lists from manifests, allowlist by file and line count | Mixed: it covers far more names and spellings, but it is weaker than the old one for `kind === 'x'` (N5). |
| `packages/core/test/pack.ts` (helper) | the loader's mark | No, stronger. |
| `packages/core/test/playbook.test.ts` | `playbook-1` to `playbook-1#own`, `pb` to `pb#own` | No: every changed line is the key; no expectation dropped. |
| `packages/core/test/registry.test.ts` | the shadowing copy carries `mod: undefined` | Not in what it asserts; it now proves identity on an unmarked node, a path production does not take. |
| `packages/server/test/m2-track-sessions.test.ts` | a track's `usdRoom` is a function, not undefined | No (the new rule; the raw-turn point still holds). |
| `packages/server/test/m3-task-3-moves.test.ts` | the `stops` words; the Customize print flipped to `toContain(long)` | No (the item 3 fix). |
| `packages/server/test/m3-task-Z-moves.test.ts` | `mayRow` now takes a view with `coreRows`; pack scope | It pins the looser rule of N2 (any pack-scoped view may list core rows). Matches the code. |
| `packages/server/test/m3-task-Z-pin.expected.json` | subagent view gains `coreRows` | No (record follows the manifest). |
| `packages/server/test/m3-task-p-playbook.test.ts` | the two `track ... #own` lines (reported) AND the deep-condition refusal: from the exact line `Playbook "deep": Maximum call stack size exceeded` to "one error matching /Maximum call stack size exceeded/" | The second is a mild weakening that no report lists: it no longer pins that the error names the playbook. The comment gives a reason (stack depth differs between pools). |
| `packages/server/test/m3-task-y-moves.test.ts` | a copy's Stop now records `command_result`, same counter as the pin | No (the item 8 fix). |
| `packages/server/test/pack-mods.test.ts` | accepts and pins the new ending of the unknown-kind line | No, stronger. |

## Unconfirmed

- How the app draws N2's rows (read from `rows.tsx`, not seen in a browser); how the app's editor shows N6's line.
- N1 with a real provider: the fake engine ignores `maxUsd`, so the probe shows the caps and the counted spend, not a provider cutting a reply.
- N4 at the session level: the driver hang is probed; `/close` and shutdown hanging is read from `session.ts:1086`, `:1113`.
- An older Reins restoring a 91e49c9 snapshot.
- The app project and the whole server folder were not run.

## Verdict

M3 is closer but not yet safe to show strangers. Items 1, 3, 5, 7, 8, 9 and 11 are fixed, the guides are now real and their examples run as written, and old saved runs still resume. Three MAJORs are left, and two of them are cheap. First, an own playbook with no `usd:` inside a fork branch ignores the branch's share, so two branches can spend $3 of a $2 budget with every reply under its cap (up to N times the budget on the CLI); a two-line change fixes it and the core suite stays green. Second, moving `stops` and `coreRows` into data let any replacement of a built-in, even a no-code data block that only needs the "Replace the built-in" box, rewrite the feed rows of core's own events; a copy should be held to what the built-in says. Third, a Customize copy of `gate`, `subagent` and the others still behaves differently from the built-in in 17 core tests (pre-existing, missed in my first review). Either route copies like the pack, or say plainly what differs. The single most important thing left is N1: money is the product's promise, and today the shipped `fork` and `playbook` blocks can break the USD limit without any mod installed.
