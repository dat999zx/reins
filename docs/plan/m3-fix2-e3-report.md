# M3 fix round 2, group E3 (guard test, guides): N5, N9, N10, N7

Tests and docs, plus one small source edit that N7 asked for (the playbook mod's early check). Everything ran with `--maxWorkers=1`.

## N5: the guard can be fooled (`packages/core/test/no-kind-branch.test.ts`, new `no-kind-branch.allow.json`)

The re-check's fix is right in its three parts (count hits, strip a leading comment, no count-based allowlist). One part cannot be done as written: "keep the old exact forms as HARD rules with NO allowlist" works for `NODES.get('x')`, `KINDS.x`, `case 'OP'` and a block receiver (`step.kind === 'x'`), but NOT for a bare `kind === 'gate'` or `ans.t === 'stop'`. The tree has dozens of legal lines of that shape (a pause kind in `drive.ts`, a question kind `q.kind === 'gate'` in `run-cli.ts`, a card kind `kind === 'stop'` in `session.ts`, an answer type `ans.t === 'approve'`). A hard rule on them would need its own allowlist. So there are two layers:

1. HARD (no list can excuse it): `step|s|st|node|instr|block|first|prev|next|it|item|b` `.kind ===/!==/==/!=` a quoted kind (and the reverse order); `['x'].includes(<block>.kind)`; `{ x: 1 }[<block>.kind]` or `[kind]`; `NODES.get('x')`; `KINDS.x` and `KINDS['x']`; `c|cond|atom|a` `.t ===` a quoted condition (and the reverse); `case 'OP'` for every pack op. All three quote kinds. The real tree has 0 hard hits.
2. Everything else (a quoted name, a key `x:`): must be an entry of `no-kind-branch.allow.json`, which holds, per word, a reason and, per file, the EXACT TEXT of every allowed line (trimmed). A new line, a changed line (so appending to an allowed line), a copy of an allowed line, the same text in another file, and a line gone from the code all fail. The bare `kind == "recall"` and `switch (kind) { case 'verify': }` plants are caught by this layer, not by a hard rule (they have no block receiver).

Also: `codeOf` strips any number of leading `/* ... */` and a leading `//` or `*`, and reads the rest of the line (the `/* PLANT2 */ ...` plant was invisible before). Every hit counts (a multiset of line texts). `scan(files, allow)`, `hitsIn` and `sources` are exported so the plants can be applied in memory to the REAL text of `run.ts` and `validate.ts`. Limits stated in the file header: a computed lookup, a name built at run time, a block comment that goes on over lines.

Red at HEAD: a scratch copy of HEAD's guard (`git show HEAD:...`, then `sources()` changed to plant in memory) with the reviewer's two plants (`run.ts`: the `kind === 'gate'` append on the `const f = this.awaiting(track, 'gate');` line; `validate.ts`: a new line `/* PLANT2 */ if (step.kind === 'end') continue;`) passed: 9 of 9 green. The scratch file was deleted.

Plants found now (test "the plants the re-check used are found, in the real files", each asserts hard + bad > 0 on the real file, and that the untouched file is clean): the two reviewer plants; `kind == "recall"`; `['store'].includes(step.kind)`; `switch (kind) { case 'verify': break; }`; `const M = { repeat: 1 }[kind];`; `c.t === 'tests'`; `NODES.get('fork')`; a second copy of an allowed line. The plants are applied in memory to a real file's text, not written into a temp file on disk (same text, same scan; it keeps the other groups' runs undisturbed).

Drift: after E1 and E2 finished I re-ran the guard: 15 of 15 green, no allowlist text needed a refresh (E1's `run.ts` and E2's `loader.ts` and `viewShape.ts` edits added no line with a listed word). Nothing to report to the orchestrator. Re-run once more after your merge: any edit to an allowed line changes its text.

Mutations (file `no-kind-branch.test.ts`, sha256 first 10: before `91a53e8a42`, after every restore `91a53e8a42`; restored from saved bytes; each run: the 11 tests of the first describe):

| # | Break | Result |
|---|---|---|
| M1 | `codeOf` skips a line that starts with `/*` again | killed (3: matcher, hard forms, plants) |
| M2 | allowlist matched by name and file, not by text | killed (2: list is exact, plants) |
| M3 | hard hits not reported | killed (2) |
| M4 | the `case 'OP'` rule removed | killed (1) |
| M5 | stale entries not reported | killed (1) |
| M6 | the `[...] .includes(step.kind)` rule removed | killed (1) |

No survivors. Not mutated: the `{ x: 1 }[kind]` hard rule has no test of its own beyond the "hard forms bite" lines (`const M = { repeat: 1 }[kind];` is in the list; if you want, I can add a mutation for it).

Existing test edited: `no-kind-branch.test.ts` itself (rewritten). Why, and what each old test became: "matcher bites" kept and extended (the two plants' spellings); "quiet" kept and extended (two comment cases); "event matcher", "css matcher", "manifests add names", "pack mod's own folder" kept as they were; "no file names ... and the allowlist is exact" now `scan(sources())` against the text list; "the allowlist is exact" now checks the stronger rules (new, changed, copied, removed, other file, missing reason, hard never excused); the second `describe` (no kind file under core/src) is unchanged. Nothing was weakened: the count-based list is gone.

## N9: guides

All sentences were written for the code as it stands after E1 and E2 (read their reports and the code: `run.ts` `startTracks`/`startRoom`/`BUILTIN_GRACE_MS`, `session.ts` `WORKER_WAIT_MS`, `viewShape.ts` `copyViewProblem`).

- `PACK.md` usd row: now says a value that is not an amount above 0 is ignored and the playbook is capped as if it had none; without `usd:` it is capped at what is left of the workflow's budget (inside a fork branch, of the branch's share) and has no cap only when no budget is set anywhere; with it, that amount and never more than what is left.
- `PACK.md` fork "Money": the "own spend and own share" line stays true; new bullet: a track a branch starts (an own playbook) spends from that branch's share, with or without `usd:`.
- `CHANGELOG.md`: the fork bullet gets the same sentence; the playbook bullet says the cap without `usd:`.
- `coreRows`: `PACK.md` Customize section has a new part "`stops` and `coreRows`: the two view keys of the pack" (what they are, the shipped `subagent` line quoted, `end` has `stops`, who may use them, what a copy may say: the same or fewer, the refusal words, a mod with an id of its own is refused, a row for a core event without `coreRows` is refused). `nodes/README.md` view-key list has a `coreRows` entry (and says only the pack, and a copy as far as the built-in does). `mods/README.md` shadowing line says the same in one sentence.
- Customize behaviour (from E1): two new bullets in `PACK.md`: a copy runs the way the built-in runs (what a "copy" is, not fenced; a copy of `gate` keeps its condition, title and track; the run waits for a command of the copy); the one difference is Stop: the built-in's commands are cut after 10 minutes, a copy's code that never ends is given up on after 11 minutes by Stop and closing the run, and closing the session or shutdown stops waiting after 12.
- `nodes/README.md` line 22 (the "Nothing in core may name a block" sentence): now says the forms that look a block up fail anywhere, the plain words (`end`, `run`, `model`, `now`, `stop`, `done`, `gate`, ...) are allowed one line at a time by exact text in `packages/core/test/no-kind-branch.allow.json` with a reason per word, and what a developer must do.
- Not done: `README.md` (root) needed no change (it has no money or Customize sentence). The `#own` words (N8) are E2's: the user no longer sees the key, so the guide needs nothing.

Tests: `packages/server/test/m3-fix2-e3-guide.test.ts` (10 tests, all green): the `coreRows` line in the guide equals the shipped `subagent` manifest and `end` has `stops`; the nodes README entry and the mods README sentence exist; the loader accepts a copy of `subagent` and of `end`, a copy with fewer events or without `stops`, refuses a copy with one more event or `stops` on `say` with the words the guide quotes, refuses `stops`, `coreRows` and a core-event row on a mod with an id of its own; the minutes in the Customize text are read from `run.ts`, `commands.ts` and `session.ts`; the allow file exists and every word has a reason; the money claims run through the real playbook mod and `Run`: an own playbook with workflow `usd: 2.00` opens with 2, with `usd: 0.5` opens with 0.5, with no budget opens with no cap; in two fork branches it opens with 1 each (with `usd: 0.5` and `usd: 1.5`, it opens with 0.5 and 1); and the PACK.md and CHANGELOG sentences exist.

Doc mutations (guide text changed by hand in the file, saved bytes put back; sha256 first 10 before = after: PACK.md `37671fc73f`, nodes README `18c9546b3c`, CHANGELOG `301bd32104`, mods README `822378ccfd`; those are the hashes before the Customize bullets were added, the same procedure was used then): usd row back to the old words, fork money bullet removed, the `coreRows` example changed, the `coreRows` entry of the nodes README renamed, the allow file not named, the CHANGELOG share sentence changed, the mods README sentence cut: 7 of 7 killed (exit 1, baseline green). The Customize bullets were added afterwards and are covered by the constant-reading test (not mutated by hand).

Red at HEAD for the money test: not shown by running it at HEAD, because that needs HEAD's `run.ts` (E1's file) and I may not check out or touch it. E1's `m3-fix2-e1-share.test.ts` is the red-at-HEAD proof for the behaviour; my test pins that the guide says what the code does.

## N10

`docs/plan/2026-10-17-m2-spec.md` is untracked (`.gitignore:12`). The item 11 note in it: section 4.6 "Shares (B2)" says a share is rounded UP to a millionth of a dollar, not to a cent, with the examples `0.166667` and `0.333334`, and gives the reason (`capOf` rounds up to a micro-dollar via nano-dollars; a cap a hair under the limit would end a reply as an error that `usdOver` does not see as reached); it also says "read 'up to a millionth'" where older text says a cent, and that the "free room of a cent or more" test is a different number. `docs/plan/2026-10-21-m2-plan-v5-1.md` Task 12 carries a NOTE with the same fact. The orchestrator will `git add -f` the spec (and the plan, if wanted). I changed neither.

## N7: tests the re-check calls weakened

- `packages/server/test/m3-task-p-playbook.test.ts` deep-condition rows: RESTORED and made stricter. It now expects exactly one error line that matches `/Playbook "deep".*Maximum call stack size exceeded/` whichever frame overflowed. At HEAD this was red under `--pool=threads` (the line was `! block playbook, its early check: Maximum call stack size exceeded`, which does not name the playbook) and green under `--pool=forks` (`Playbook "deep": Maximum call stack size exceeded`). So the production message needed the fix: `packages/server/src/mods/playbook/index.ts` now wraps the `early` check (5 lines at the end of `activate`) so any throw out of the check is pushed as `Playbook "<name>": <message>`. Tests ran in both pools: 16 of 16 green each.
  Mutations (playbook/index.ts, sha256 first 10 `20c97daa54` before and after, restored from saved bytes; 16 tests in `--pool=threads`): the catch rethrows (killed), the message without the name (killed), the catch pushes nothing (killed), the name taken from `step.id` instead of the file name (killed: `Playbook "playbook-1"`).
- `packages/app/test/m2-fix-25a-a.test.ts` "stops on a kind that is not end" row: NOT restored. E2 owns it and reports why: restoring it needs a stamp in the served view that breaks two `kinds-route.test.ts` rows; the server now holds the rule on load and on serve (`copyViewProblem`). I left it. The comment in that test is still true.
- Edits in the fix round that the re-check lists as not weakened are unchanged: `m2-money`, `playbook.test.ts`, `registry.test.ts`, `m2-track-sessions`, `m3-task-3-moves`, `m3-task-Z-pin`, `m3-task-y-moves`, `pack-mods`. `m3-task-Z-moves.test.ts` `mayRow` pins the looser rule of N2; E2's `copyViewProblem` now closes that at load and serve, but the `mayRow` test still matches the code (a view that lists the event in `coreRows` may draw it). I did not edit it.

## Existing tests I edited (all)

1. `packages/core/test/no-kind-branch.test.ts` (above).
2. `packages/server/test/m3-task-p-playbook.test.ts` lines 135 to 138 (deep condition, above). E2 edited lines 198 to 203 of the same file (N8); not me.

## Unconfirmed / not mine

- `npm run typecheck`: 90 `error TS` lines at the end; none in my files (my `m3-fix2-e3-guide.test.ts` had one at first and is fixed). The rest are the app and `mods/*` ones E1 and E2 also list.
- `pack-mods.test.ts` showed 17 red in a four-file run (79 s, other groups running at the same time): the first was a 30 s timeout. Alone it is 118 of 118 green. I read this as load, not as a break; unconfirmed.
- The guide's claims about the app (how the feed draws a `coreRows` row) were not seen in a browser.
- The Customize bullets say "the import dialog asks 'this replaces a built-in' first": read from the earlier guide text and `actions.ts` names, not re-tested here.

## `git status --short` (my files)

```
 M CHANGELOG.md
 M packages/core/src/nodes/README.md
 M packages/core/test/no-kind-branch.test.ts
 M packages/server/src/mods/PACK.md
 M packages/server/src/mods/README.md
 M packages/server/src/mods/playbook/index.ts      (the early-check wrapper; E2 also edited OWN_SUFFIX in it)
 M packages/server/test/m3-task-p-playbook.test.ts (deep condition lines; E2 edited other lines)
?? packages/core/test/no-kind-branch.allow.json
?? packages/server/test/m3-fix2-e3-guide.test.ts
?? docs/plan/m3-fix2-e3-report.md
```

Line endings kept: CRLF files stay CRLF (`no-kind-branch.test.ts`, PACK.md, both READMEs, CHANGELOG, `playbook/index.ts`), LF files stay LF; the two new files are LF. No U+2014 in any file I touched (a test in the fix-C guide-examples file already checks the guides).
