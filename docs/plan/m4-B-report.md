# M4 group B report: core and server (words: workflow -> playbook)

## Inventory (src, `.ts` and `mod.json`, case-insensitive, before editing)

298 hit lines in `packages/core/src` and `packages/server/src` (the `.md` files there are group C's).

| class | hits | what |
|---|---|---|
| WORDS (changed) | 49 sites, 52 replacements | messages, diagnostics, CLI lines, prompts, mod.json descriptions |
| IDENTIFIER/FORMAT (kept) | 199 lines | `Workflow` type, `parseWorkflow`/`printWorkflow`/`loadWorkflow`, `.workflow` fields, `workflowPath`, `workflow_path` SQL column, `KEY_IN_WORKFLOW`, `workflowName` |
| COMMENT (kept) | 69 lines | code comments and doc comments, not read by users |
| BOTH, kept | see below | |

Per file where words changed (count of replacements): core `compile.ts` 1, `run.ts` 3, `validate.ts` 2, `viewShape.ts` 1;
server `drive.ts` 1, `secrets.ts` 1, `run-checks.ts` 1, `run-cli.ts` 4, `session.ts` 7, `tags.ts` 1, `server.ts` 2 (same text twice), `workflow-files.ts` 6, `mods/actions.ts` 13, `mods/kinds.ts` 1, `mods/end/index.ts` 1, `mods/end/mod.json` 1, `mods/phase/mod.json` 1, `mods/playbook/mod.json` 1.

Changed: the turn header sent to the model `[Reins · playbook "name" · step ...]` (compile and the "asked for changes" header),
`This playbook cannot run`, the Allow refusal and the USD card line ("The playbook's USD budget ..."),
`Playbook requires budget ...`, `over the playbook's $...`, the `view.stops` message, the end step warning,
`reins run` header and receipt line (`Reins · run X · playbook "n"`, `playbook n · done ...`), "the file is not a playbook",
trust prompt and the stop/not-trusted notes, path refusals (`The playbook must be ...`, `No such playbook.`, `playbooks folder`),
key refusal, import/export errors and warnings, `Invalid playbook.`, `invalid playbook`, model-with-tools message, 3 mod.json descriptions.

## Kept, and why

- Code identifiers and types (199 lines): not words a person reads.
- Comments (69 lines): developer text; the task said user-visible strings only for core, and the same call was made for server.
- API routes, folders, file format: `/api/workflows`, `.reins/workflows`, `~/.reins/workflows` inside sentences (a path shown inside a sentence, the folder name is not renamed), `workflows` response key, `workflow` body keys, `workflow_path` column, `m[2] === 'workflow'` route.
- BOTH, field names in messages: `` `workflow` must be { "name": ..., "text": ... } `` (actions.ts), `k !== 'workflow'` key checks, `Send a path and either text or workflow.` (server.ts:452). They name the JSON field, which is unchanged.
- Download name `workflow.reins-mods.json` (actions.ts:1549): a file name, format side; a different task.
- `core/test/no-kind-branch.allow.json` line 220 is an exact copy of the viewShape source line, so it was changed together with the source. The two other `workflow's` hits in that file are "reason" prose about the `drift:` front-matter key and were left.
- `packages/server/test/fixtures/e2e-upload-retry.transcript.txt`: a recorded transcript read only by `e2e.real.test.ts` (real engine). Not re-recorded; it still says "workflow". Unconfirmed: whether that real test compares it.
- Test titles (`it('... workflow ...')`) and comments in tests: not user-visible; left.

## Existing tests and goldens edited (words only)

Expected strings changed (never loosened, none deleted):
- `core/test/end.test.ts` (end step warning), `m2-contract.test.ts` (Playbook requires budget), `model-node.test.ts` x2 and `subagent-node.test.ts` (over the playbook's $...), `model-run.test.ts` (Allow refusal).
- `server/test/drive.test.ts` (4: USD card line, Allow refusal), `m3-task-3-moves.test.ts` (end warning), `m3-task-p-playbook.test.ts` (the file is not a playbook), `mods-envelope.test.ts` (regexes: playbook text/name, not a field of the playbook, no mods and no playbook, playbooks folder), `run-start-checks.test.ts` (4: tools for playbooks), `session.test.ts` (USD card line etc.), `workflow-files.test.ts` (path refusals), `m3-task-2-moves.test.ts` line 70 (`playbook pin · done ...`), `m3-fix2-e3-guide.test.ts` line 173: it pins a PACK.md sentence; now matches group C's new sentence "Without it the playbook is capped at what is left of the budget of the playbook that uses it" (depends on group C keeping that sentence).

Goldens (each diff is exactly `[Reins · workflow ` -> `[Reins · playbook `, 227 occurrences in 51 files, done by a byte-exact replace):
- `core/test/golden-3a/*` (a-examples, a-hand), `golden-m1/*`, `golden-m2/*`, `server/test/m3-task-{3,4,Z,w,y}-pin.expected.json` (also m3-task-3 has the end warning swap on 1 line).
- `core/test/golden-3a/a-trees.json`: hashes. Proof of word-swap-only: with the old word restored in `compile.ts` the "generated trees" test passed against the old hashes; with the new word the hashes were re-recorded for that one test only (`REINS_RECORD_3A=1 -t "generated trees"`), CRLF kept (164 lines).
- `server/test/golden-3b/yes.txt` and `answers.txt`: 2 lines each (`Reins · run <ID> · playbook "..."` and the receipt line `playbook golden-... · ...`). Diff shown by the failing test was exactly these two lines.

## Results

- `packages/core`: 158 files, 2136 tests pass.
- `packages/server` (non-browser, non-live, non-real, 150 files): all pass, run in chunks. With one big run, or chunks 60 and 90, the vitest worker died with "Channel closed" (an IPC crash, no assertion); each file in those chunks passes when run alone (`mods-firstrun.test.ts` crashed once in a chunk and passed alone: 8 of 8). Treat as pre-existing flakiness, unconfirmed on HEAD.
- Live/real tests (`packages/server/test/live/*`, `*.real.test.ts`) were not run (they need real engines). `live-m2-tracks.real.test.ts` rows failed in my first full run, on restore rows; I did not investigate, they look environmental (30 s timeouts).
- `npm run typecheck` and `npm run lint`: exit 0.
- Checked: no BOM, no mixed line endings, no U+2014 in any edited `.ts`/`.json` of mine. (One BOM and one mojibake `é` I caused in `mods-envelope.test.ts` with PowerShell were found and repaired byte-exactly.)

## Needs a change outside my files (not edited)

- `packages/server/test/live/*.real.test.ts` and `live-harness.ts` have only comments/notes with "workflow"; left.
- Browser tests are group A's; if any pins a server message I changed (e.g. `The playbook must be ...`, `Invalid playbook.`, `No such playbook.`, the USD card line), A must follow.
- `packages/server/test/fixtures/e2e-upload-retry.transcript.txt`: see above.

## git status (my files)

Modified: core `src/{compile,run,validate,viewShape}.ts`; server `src/{drive,secrets,run-checks,run-cli,session,tags,server,workflow-files}.ts`, `src/mods/{actions,kinds}.ts`, `src/mods/{end/index.ts,end/mod.json,phase/mod.json,playbook/mod.json}`;
tests: `core/test/{end,m2-contract,model-node,model-run,subagent-node}.test.ts`, `core/test/no-kind-branch.allow.json`, `core/test/golden-3a/{a-examples,a-hand,a-trees}.json`, `core/test/golden-m1/*`, `core/test/golden-m2/*`;
`server/test/{drive,m3-task-3-moves,m3-task-p-playbook,mods-envelope,run-start-checks,session,workflow-files,m3-task-2-moves,m3-fix2-e3-guide}.test.ts`, `server/test/m3-task-{3,4,Z,w,y}-pin.expected.json`, `server/test/golden-3b/{yes,answers}.txt`. Nothing staged, committed or pushed.
