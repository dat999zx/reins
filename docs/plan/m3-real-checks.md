## M3 live checks of fork and playbook: status of this file (written by the implementer)

- Test file: `packages/server/test/live/live-m3-fork-playbook.real.test.ts`. Six rows, each with a dry version (the scripted fake, always run) and a real version (`REINS_LIVE=1`, `REINS_LIVE_ANTHROPIC_KEY` in the environment, and `claude` logged in for the CLI branches of rows 1 and 2).
- Real runs append one block per row below this section (the harness's `record`, which refuses a block that holds a key). Dry runs write to the harness's own dry file, never here.
- Run: `node node_modules/vitest/vitest.mjs run packages/server/test/live/live-m3-fork-playbook.real.test.ts --maxWorkers=1`, with `REINS_LIVE=1` for the real rows. Row 6 needs `packages/server/dist/cli.js` (built from this tree) and skips without it.
- Rows: M3-1 fork over the API and the claude CLI, then a turn that sees both. M3-2 a fork whose second branch fails (an unknown model id on the other provider), then Stop. M3-3 an inline playbook with `input: who=Ann`. M3-4 a playbook with `session: own` and `usd:`. M3-5 an envelope (code mod, data mod, workflow) from one home to a fresh one, and a tampered copy. M3-6 a hard kill of the server in the middle of a fork, restart, Resume.
- Spend caps (the Budget's own count of API conversation files; the CLI's dollars are on the receipt): row 1 $0.12, row 2 $0.05, row 3 $0.08, row 4 $0.08, row 5 $0.05, row 6 $0.12 (workflow `usd:` and the world Budget). The caps add up to $0.50; the expected spend of all six is about $0.05 to $0.10 on Haiku 5.5.
- Real rows not yet run: nothing is claimed here until a block appears below.
## Row M3-1 fork over two engines (API + claude CLI) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0050
- counts: forkStarted=1, forkDone=1, trackStarted=2, trackEnded=2, sessionsSeen=2, mainSessionDifferent=true, aReply="ALPHA branch acknowledged; no project files were needed for ", bReply="BRAVO branch confirmed: this step is complete.\n\nResult of su", finalReply="ALPHA AND BRAVO BOTH REPORTED IN: THE ALPHA BRANCH ACKNOWLEDGED WITHOUT NEEDING ", trackAUsd=0.002325, trackBUsd=0.008107, finalTurnUsd=0.002717, totalCostUsd=0.0131, budgetOwnCountUsd=0.005042, runMs=45183, processesLeft=none
- swept: 0 hits (9 files)
- the API branch's price: claude-haiku-5-5: {"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25} USD per million, ASSUMED by this harness (the catalog manifest has no price for it)
- branch b (subagent step with model claude-code:claude-haiku-5-5) ran on the CLI; its dollars come from the CLI, not from a conversation file

## Row M3-3 inline playbook with an input (Haiku 5.5 on the API) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0022
- counts: stepIds=["pb","pb/hello","pb/say"], playbookStarted=1, playbookDone=1, tracks=0, trustListed=["echo hi Ann","npm test"], hashChangesWithInput=true, injectedCommandListed=true, replyMentionsAnn=true, receiptTotalUsd=0.0022, ownCountUsd=0.002244
- swept: 0 hits (9 files)
- price: claude-haiku-5-5: {"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25} USD per million, ASSUMED by this harness (the catalog manifest has no price for it)

## Row M3-4 playbook session: own, usd 0.05 (Haiku 5.5 on the API) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0047
- counts: capUsd=0.05, trackUsd=0.002277, trackTurns=1, afterTurnUsd=0.00242, receiptTotalUsd=0.0047, ownCountUsd=0.004697, trackSessionDiffersFromMain=true, processesLeft=none
- swept: 0 hits (10 files)
- price: claude-haiku-5-5: {"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25} USD per million, ASSUMED by this harness (the catalog manifest has no price for it)

## Row M3-2 fork with a failed branch (API + claude CLI with an unknown model) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0023
- counts: branchAEnded=true, forkDone=0, finalTurns=0, pauseRowsOfOtherTracks=0, resumeCardsOpen=1, reason="reply was an error (There's an issue with the selected model (claude-no-such-model-0). It may not exist or you may not have access to it. Run --model to pick a ", stopToEndMs=19, runEnded=run_stopped, openQuestionsAfter=0, newClaudeProcessesDuringRun=0, processesLeftAfter=none
- swept: 0 hits (7 files)
- branch b asked the model claude-code:claude-no-such-model-0, which its provider does not have

## Row M3-6 restore mid-fork after a hard server kill (Haiku 5.5 on the API) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0191
- counts: forkStarted=1, forkDone=1, trackStarted=2, trackEnded=2, stepsAnswered=["a/a","b/b","main/after"], afterTurnStarted=1, turnsEndedBeforeKill=0, costBeforeKillUsd=0.004908, requestsAfterResume=n/a, resumeToEndMs=8066, receiptTotalUsd=0.0191, sumOfTurnCostsUsd=0.019142, ownCountUsd=0.019142, cutOffCallsUsd=0.000042, trackUsd=[["a",0.008207],["b",0.008012]]
- swept: 0 hits (12 files)
- the server was killed with taskkill /F /T while both branches had a tool card open (a turn in flight in each); the second process was started on the same home and the run resumed through POST /resume

## Row M3-2 fork with a failed branch (API + claude CLI with an unknown model) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0023
- counts: branchAEnded=true, forkDone=0, finalTurns=0, pauseRowsOfOtherTracks=0, resumeCardsOpen=1, reason="reply was an error (There's an issue with the selected model (claude-no-such-model-0). It may not exist or you may not have access to it. Run --model to pick a ", stopToEndMs=21, runEnded=run_stopped, openQuestionsAfter=0, newClaudeProcessesDuringRun=0, processesLeftAfter=none
- swept: 0 hits (7 files)
- branch b asked the model claude-code:claude-no-such-model-0, which its provider does not have

## Row M3-5 envelope round trip between two homes (Haiku 5.5 on the API for the one turn) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0032
- counts: modsInFile=2, summaries=1, codeModsToTrust=1, codePromptShown=true, trustAnswer={"m3tag":"trusted"}, workflowSaved=true, previewWroteNothing=true, wrongHashStatus=409, trustOnNoCodeModStatus=400, ranThere=true, m3tagranRows=1, tamperedHashDiffers=true, tamperedTrustedBefore=false, oldHashOnTamperedStatus=409, homeAfterRefusal=unchanged, receiptTotalUsd=0.0032
- swept: 0 hits (25 files)
- both homes are in-process worlds of the harness, talked to over their real HTTP routes (POST /api/mods/bundle, /api/mods/import/preview, /api/mods/import); home 2 started with no mod, no trust file and no workflow

