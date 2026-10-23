## Row M2-2 Stop with a tool approval open (claude CLI) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0000
- counts: toolCardsOpenAtStop=2, stopToEndMs=1640, runEnded=run_stopped, openQuestionsAfter=0, newClaudeProcessesDuringRun=4, processesLeftAfter=none, closedWhy=["the turn ended"]
- swept: 0 hits (11 files)
- the branches ran on the claude CLI engine (Haiku 5.5)

## M2 live checks, Task 25b: status of this file (written by the implementer)

- The API key file `$LOCALAPPDATA/Temp/live/keys.env` does not exist on this machine, and no REINS_LIVE_* variable or ANTHROPIC_API_KEY is set. Rows M2-1, M2-3 and M2-4 (API version) therefore did NOT run for real. Nothing is claimed for them. Their dry versions are green.
- Row M2-2 ran for real on the claude CLI only (its branches never touch the API); the harness was started with an inert, made-up key so that it could start. The block above is that run.
- Spend by the receipts: three earlier real attempts at row M2-2 whose premise was wrong (the CLI never asked): two CLI turns each, $0.0103, $0.0104 and $0.0104 (the third was a Write-tool variant, also without a card); the passing run was stopped before any turn ended. About $0.04 in all.
- What those attempts showed (facts about the product): the claude CLI engine runs with `--permission-mode acceptEdits` (engine.ts:107), so on a branch a `Write` of a file and a read-only `PowerShell` command (`Write-Output`) run with NO approval card. A web request (`Invoke-WebRequest`) does open a card. Row M2-2 uses that.
- Product bug found by the dry run of row M2-1, fixed with one line (run.ts, `!this.parked(t)`): a block MOD whose op starts tracks was paused at once with "The block ... did not move on" (Task 25a's check took the parked track for an op that forgot `vm.next()`). Test: packages/core/test/m2-mod-park.test.ts (red without the line, green with it). Without it no block mod could start tracks at all.
- Not run: the claude-CLI variant of row M2-4a (REINS_M2_ROW4=cli), because the tool call that would run it was refused by the permission layer.
## Row M2-1 two branches, two engines (API + claude CLI) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0022
- counts: trackStarted=2, trackEnded=2, aReply="ALPHA\nREINS: done", bReply="BRAVO", aEndedText="ALPHA", bEndedText="BRAVO\n\nResult of subagent \"b\" (step b). ", trackAUsd=0.002227, trackBUsd=0.004748, sumUsd=0.006975, totalCostUsd=0.007, totalTurns=2, budgetOwnCountUsd=0.002227, subagentStarted={"model":"claude-haiku-5-5","label":"Haiku 5.5"}, runMs=38302, claudeProcessesLeft=none
- swept: 0 hits (12 files)
- the API branch's price: claude-haiku-5-5: {"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25} USD per million, ASSUMED by this harness (the catalog manifest has no price for it)
- branch B (subagent step with model claude-code:claude-haiku-5-5) ran on the CLI; its dollars come from the CLI, not from a conversation file

## Row M2-2 Stop with a tool approval open (claude CLI) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0000
- counts: toolCardsOpenAtStop=2, stopToEndMs=1606, runEnded=run_stopped, openQuestionsAfter=0, newClaudeProcessesDuringRun=4, processesLeftAfter=none, closedWhy=["the turn ended"]
- swept: 0 hits (11 files)
- the branches ran on the claude CLI engine (Haiku 5.5)

## Row M2-3 USD limit crossed, one pause (Haiku 5.5 on the API) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0453
- counts: limitUsd=0.03, allowUsd=0.02, usdCards=1, budgetReachedRows=1, firstCardTrack=b, otherCardTracks=[], mostCardsOpenAtOnce=1, firstTrackWentOnAfterAllow=true, budgetWarningRows=0, ended=run_finished, receiptTotalUsd=0.0453, ownCountUsd=0.045276, trackUsd=[["a",0.022165],["b",0.023111]]
- swept: 0 hits (27 files)
- price: claude-haiku-5-5: {"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25} USD per million, ASSUMED by this harness (the catalog manifest has no price for it)
- the limit is the workflow usd; the split block says share: yes, so each branch has half of it as its slice

## Row M2-4a restore mid-split after a hard server kill (Haiku 5.5 on the API) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0229
- counts: claudeProcessesLeftByTheKill=n/a, finishedBeforeKill=["a1/a1","b1/b1"], costBeforeKillUsd=0.011252, stepsAnswered=["a1/a1","a1/a2","b1/b1","b1/b2"], trackStarted=2, trackEnded=2, requestsAfterResume=n/a, resumeToEndMs=5261, receiptTotalUsd=0.0229, sumOfTurnCostsUsd=0.022936, ownCountUsd=0.022936, cutOffCallsUsd=0.000036, trackUsd=[["a1",0.010672],["b1",0.012264]]
- swept: 0 hits (15 files)
- the server was killed with taskkill /F /T while both branches had a tool card open; the second process was started on the same home and the run resumed through POST /resume

## Row M2-4b restore after the mod's version changed (API) | 2026-10-23 | real | claude-haiku-5-5 | PASS
- cost by the Budget's own count: $0.0123
- counts: pausedWith="This run was saved with other blocks (split); Stop it, or Resume to run it with the blocks you have now.resume [note] / stop ", questionKind=resume, turnsBeforeKill=2, turnsRunAfterResume=0, requestsToProviderAfterResume=n/a, endedBy=Stop
- production wiring: the second process was `reins serve` from dist/cli.js (cli.ts -> serve.ts -> server.ts deps.kinds = kindVersions(mods)); mod.json version 1.0.0 -> 1.0.1 and the trust file rewritten

