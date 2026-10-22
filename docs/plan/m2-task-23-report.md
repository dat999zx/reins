# M2 Task 23 report: guides and changelog

Base: HEAD 2b011c3, branch feat/fork-playbook. Docs only. No code, no test run (the brief says so), nothing committed, added, stashed or reset.

## Files

- `packages/server/src/mods/README.md`: new section "Block, condition and card mods", appended at the end. The existing text is untouched.
- `packages/core/src/nodes/README.md`: rewritten. The old text was stale: it said the app globs `*.view.ts` ("the view file needs no line"), and its view example used functions for `fresh` and `rows`. Tasks 17a and 17b removed both.
- `CHANGELOG.md`: nine bullets added at the top of "Unreleased". The existing bullets are untouched.
- `docs/plan/m2-task-23-report.md`: this file (new; `docs/` is gitignored).

Line endings: all three edited files are CRLF with 0 bare LF (counted with PowerShell). No BOM. No U+2014 (counted). `nonAscii` is 0 in the two READMEs. The CHANGELOG keeps its existing non-ASCII characters.

Provider names: `nodes/README.md` has none. The mods folder is exempt from `no-provider-name.test.ts`. Its only hits are two existing lines (`openai-chat` in the example, `CLAUDE.md` in the CLI section), which I did not write. The CHANGELOG hits are on existing lines 19 to 91. My bullets have none.

## Checked in code (grep or read)

- Manifest keys and rules: `packages/server/src/mods/kinds.ts` (`providesProblems`, `viewProblems`, `shapeProblems`, `dataProblems`, `codeProblems`, `commonProblems` in `loader.ts`) and `types.ts` (`Manifest`, `Provides`, `ModApi`, `ModKind`).
- Limits: names 40 characters (`NAME`), 50 names (`MAX_NAMES`), view 32 KB (`MAX_VIEW`, counted as JSON text), view `fields` and `line` 50 each, turn 4 KB in bytes (`MAX_TURN`), status 200 characters, fill 1000 and prompt 16 KB (`data-block.ts`). Guard caps: heading 200, count key 40, printed line 300 (`LINE_MAX`), message 200 (`WHY_MAX`), in `guard.ts`.
- `api` members: `types.ts:114-125`. `api.core` is exactly `checkMode`, `turnInstr`, `policyOf`.
- Refusal texts: the Task 16a table (`the api can only be used while the mod activates.`, the `provides` lines). `kind "say" is already registered` and `op "TURN" is a core op` are in `nodes/index.ts:197,199`.
- Data block: `data-block.ts` (`fillTurn`, `turnNames`, `dataBlock`, no ops, `validate.early: checkMode`).
- Template formats: `app/src/template.ts:8` (`usd` = `dollars(n, 4)`, `count` = `toLocaleString('en-US')`). `$0.0123` is the example in the file's own comment (line 6).
- Built-in orders: kinds `nodes/index.ts:206` (10 to 130); conditions `conds/index.ts:26` (10 to 110). `use` is 80 in the registry and 130 in `use.view.ts:4`.
- Built-in views: `core/src/views.ts` (`BUILTIN_VIEWS`); route `server.ts:391` (`GET /api/kinds`); `kinds-view.ts` (sorted by view order, then manifest order; mod views never take a built-in name).
- Start and carry: `loader.ts:471-483` (carried mod: no second activation, a stale one gets "applies after a restart."), `loader.ts:603-618` (carried but not met: notice or stand-in), `engines.ts:30`.
- Trust and preview: `actions.ts:291-342` (the `adds` lines and the clash line), `actions.ts:799` (`CODE_PROMPT`, quoted exactly), `actions.ts:968-973`. `importLines.ts:65-66` (button labels).
- Region rules and `manyNext`: `validate.ts:306-336`, `validate.ts:214`, `compile.ts:144`, `nodes/index.ts:76` and `:174`, `fields.ts:20`.
- `starts`: only in the test fixtures `split.ts:54` and `split-share.ts:36`. `tracks.start(` is in no non-test file, so no shipped block starts tracks.
- Toy fixtures: `toy-beep/mod.json` and `index.js`, `toy-ask/mod.json` (quoted exactly in the guide). `beep.ts` (quoted exactly in the nodes guide).
- CLI usage: `cli.ts:24-28` (`reins run <file>`, `reins doctor [--no-probe]`).

## Claims I could not verify in code (not guessed; the guide states them anyway, so please check)

1. **Start-time rule for a new mod (a deviation from the plan).** The plan says start-time only. The code registers a block, condition or card that was not registered yet at the reload that loads it. That happens when it is trusted or turned on. Reading `loader.ts` (a disabled mod returns before activation) and the Task 20 test (trust, then registered) supports this. No test is named for it. Task 16b's open point 2 asks you to decide. The guide describes what the code does.
2. **Settings words.** The guide says Settings shows "`<id>`: applies after a restart." The loader pushes that line and `actions.ts:282` sorts it as a notice. I did not open `Providers.tsx` to confirm how it is drawn.
3. **Worked example, UI names.** "Protocols and other mods", the row layout and the Export and Import buttons come from the existing guide and the Task 20 report. I did not read the app code for them. The two import button labels are in `importLines.ts`.
4. **Worked example, the trust route.** The guide says Reins refuses a trust sent with another hash. That comes from the Task 20 test (409). I did not read the route body or re-run the test.
5. **Worked example, restart and output.** "The block registers at start with no prompt" comes from the Task 16b test (real `mod-trust.json`). "`beeped x2`" and "`beeps 1`" come from the test name and the Task 8/16a reports. I did not read the test assertions. `reins doctor --no-probe` lists the mods, per the CLI usage line.
6. **Import preview registers nothing.** From the Task 20 test. Not re-run.
7. **Data block in Settings.** The guide says a data block needs no trust, which the loader does. The Task 19 report says `mod.trusted` stays false for a user data block. I did not check what Settings shows for it.
8. **Hooks and containment details.** "Hooks get a copy", "a throw from a mod op pauses its track" and the output caps are from the Task 16c report and its tests. I read the constants in `guard.ts` but not the copy and pause code.
9. **Card kinds.** The guide says a mod can add a card kind (`registerCard`, `CardType`). I did not check what a card does at run time.
10. **Question cards.** The guide says the eight question cards are not in the card registry, so no mod can replace them. That is from the Task 15 report. I did not grep `CARDS` for them. Task 18 is running; the guide says "see Task 18" for the details, as the brief asks.
11. **Built-in block views and their import rule.** The guide keeps "A view file imports only types, and the field helpers from `./fields.js`", and the views test checks the same key rule (`views.test.ts:152`). I did not find a test of the import rule, and the text no longer names one.
12. **Sections I kept as they were.** "Ops and VmCtx", "Blocks with their own session", "count and print" and "What stays core" are the old text. I did not re-check them line by line against the code.
13. **CHANGELOG claims from reports.** "Parallel tracks in the engine", "per-track pauses and money", "Allow answers for the track that paused" (Tasks 8, 11, 12), "the run view shows each track" (Task 21) and "cost chips no longer cover blocks or arrows" (Task 22, and the commit message). The Task 11 and 12 reports first stopped on a pin conflict. The pin at `m2-tracks-money.test.ts:216` now uses `trackSpendKey`, which I saw in the tree. I did not run the tests to confirm the conflict is resolved.
14. **"Nothing is registered before you choose" on import, and "an unknown kind is drawn as unknown block".** The second is from the Task 17b report, not re-run.

## Mismatches found in other reports (not changed; no code edited)

- Tasks 17b and 19 say the data block file is `packages/core/src/nodes/data-block.ts`. It is `packages/core/src/data-block.ts`, and `index.ts:18` exports it from there. The 17b note about a failing `nodes-registry` test for `nodes/data-block.ts` may be stale. I did not run the test to check.
- Task 17b's open point: the server's view check does not look at `sub` or `rows`. The guide says so.
- Task 20's open point: a trusted block imported into a second home while the first still has it fails there with "already registered". That is a limit of one process, not of a user's setup. The guide does not mention it.

## Not done

- No test, lint, typecheck or build run (the brief says write docs only).
- No mutation round (the brief says ignore the mutation rules for this task).
- No commit.
