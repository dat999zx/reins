# M3 Task 2 report: event-specific code and app defaults behind the loader; the type unions

Worktree D:/coding/reins-wt-fork, branch feat/fork-playbook, HEAD 65a0b35. Nothing committed, added, stashed or reset.

Result: after this task no core, server or app file outside `core/src/nodes/` names an event of a kind, except the two reserved-name lists that a test
pins (below). The receipt, the `reins run` lines, the step marks and the feed read those events through each kind's `count`, `print` and view data.
Every output I pinned at HEAD is byte for byte the same.

## What moved (old place -> new place)

| Old | New |
|---|---|
| `receipt.ts` cases `gate_paused`, `loop_iteration`, `verify_result`, `recall`, `store` | `count` hooks in `nodes/gate.ts`, `repeat.ts`, `verify.ts`, `recall.ts`, `store.ts`. A hook may return a fixed field name (`gatesHeld`, `loopAttempts`, `verifyResults.passed`, `verifyResults.failed`, `knowlRecalls`, `knowlStores`, `knowlSkipped`); `receipt()` adds one to that field. Any other name goes to `counts` as before. The fixed-name lookup is by own property, so a count named `constructor` is a count name. |
| `run-cli.ts` lines for `recall`/`store` skipped, `verify_result`, `loop_iteration`, `model_switched` (unsupported) | `print` hooks in `recall.ts`, `store.ts`, `verify.ts`, `repeat.ts`, `model.ts`. The existing `print` read in `printEvent` was already first. `subagent_started`, `subagent_result` stay (core logs them). |
| `stepStatus.ts` handlers `verify_result`, `gate_paused`, `model_switched`, `loop_iteration`, `loop_budget_exceeded` | `view.status` rules in `gate.view.ts`, `repeat.view.ts`, `verify.view.ts`, `model.view.ts`; one generic `applyRule` in `stepStatus.ts`. |
| `feed.ts` roles `gate_paused`, `loop_iteration`, `verify_result`, `loop_budget_exceeded` | the same `view.status` rules, read by `kindRole()` in `feed.ts`. |
| `rows/hidden.ts` `model_switched` | `view.hidden` in `model.view.ts`; `hidden` in `rows/hidden.ts` is now an object with `has` and iteration that reads the base list plus the served views. |
| `runState.ts` `gate_paused: setStep` (NOT in the plan) | the `cursor: true` flag of the gate's `status` rule. |
| `session.ts` read of `model_switched` from `snapshot.events` | the host's own record: `runSwitch` remembers `{ model, label }` of the last `switched` or `same` outcome and `withChose()` saves it beside the run's snapshot (`hostChose`); resume reads it back with `readChose()` (a damaged value reads as none). |
| `Workspace.tsx` stand-in `{ t: 'approve' }` | `standInCond()` in `condKinds.ts`: the first served condition, a new copy; none before the first reply (the drop is then not legal, nothing throws). |
| `BlockPanel.tsx` first card | Already done by M2 (`CARD_KINDS[0]`, undefined-safe). The plan's lines are stale. No change. |
| `repeat.ts` `kind === 'run'`, `t === 'cmd'`, `t === 'tests'` | lookups by name: the first child's kind has an op with `ranCommand` (`NODES.get`), and the loop's atom has the new `CondType.sameAsRun(c, cmd)` hook (`CONDS.get`), implemented in `conds/tests.ts` (`cmd === 'npm test' || !cmd`) and `conds/cmd.ts` (`c.cmd === cmd`). A throwing hook is "no". |

New data and checks: `KindView.status` and `KindView.hidden` (`nodes/fields.ts`, types `StatusRule`, `StatusWhen`, `StatusState`); the shared check
`viewShapeProblem` (`viewShape.ts`) validates both with the rest of the view; the server's served-view builder (`kinds-view.ts`) and the block mod
check (`kinds.ts`) already call that one function, so neither needed an edit. New `app/src/viewEvents.ts` reads the rules and the hidden list from `KINDS`.

Hostile-input rules for the new keys (all in `viewShape.ts`, same function in server and app): event and data names must match
`^[A-Za-z][A-Za-z0-9_-]{0,39}$` and not be an `Object.prototype` member or `prototype` (so `__proto__` and `constructor` are refused); at most 50 rules and
50 hidden entries; a hidden event may not repeat; a rule has only the listed keys; `state` is one of five; `why` text is 1 to 200 characters, a `words` table has
1 to 8 entries of at most 40 characters; a `when.is` list has 1 to 8 short texts, finite numbers or booleans; in a mod's scope the event must be in
`provides.events` and must not be an event core logs. The server's existing check for hidden characters in every string and key of the view (`clean()`,
`viewProblems`) covers the new keys. In the app every lookup is by own property and the label table has no prototype.

## What stayed in core, and why

- `RunEvents` (`run.ts`) and `CORE_EVENTS` (`viewShape.ts`) still list `gate_paused`, `loop_iteration`, `loop_budget_exceeded`, `verify_result`, `recall`, `store`,
  `model_switched`. `m2-fix-25a-a.test.ts` pins the second equal to the first, and I may not edit that test. The guard allowlists those 7 lines by exact text.
  They leave with each kind in Tasks 3 to 8 (see "open for the next tasks").
- Events core logs itself stay by name: `run_*`, `turn_*`, `step_started`, `refusal`, `card_*`, `engine_cost`, `subagent_started`, `subagent_result`, `gate_approved`,
  `link_budget_exceeded`, `command_result`, `track_*`, `budget_*`.
- The receipt's fixed fields (core's contract; the goldens hold them).
- `drive.ts` and `questions/gate.ts` use `approve`/`gate` as the answer and pause type, not an event or a kind branch (the old allowlist entries stay).
- Type unions: `StepKind`, `CardKind` and `Cond` are already open interfaces merged by each node, card and condition file (`keyof NodeKinds`, `keyof CardKinds`, `CondAtoms`).
  There was no closed kind-name union left to open (the other literal unions are question kinds and colours, not step kinds). The one place that needed the
  merged names was `repeat.ts`, now done by name. Root, core and app programs typecheck clean.

## Tests

New test files (all green):
- `packages/core/test/m3-task-2-receipt.test.ts`: the receipt of every variant of the moved events (pinned at HEAD), and a test node whose `count` names each fixed field.
- `packages/core/test/m3-task-2-repeat.test.ts`: the compiled loop for 10 shapes of run/condition (jump set or not), a test kind with `ranCommand`, an atom whose hook says yes, one that throws, one never asked.
- `packages/server/test/m3-task-2-moves.test.ts`: `startRunCli` over recall, verify fail then pass, model, repeat, store and a gate with a scripted engine: the kind lines, the receipt lines and the fixed fields (pinned at HEAD).
- `packages/server/test/m3-task-2-mod-events.test.ts`: a block mod made in a temp home (`tempHome`) through the real loader: it counts into `gatesHeld` and its own names, prints its line, serves `status` and `hidden`; 21 refused views.
- `packages/server/test/m3-task-2-session.test.ts`: the resume note from the saved host record (switched, same, none, no leak from the run before, 6 damaged records, no label).
- `packages/app/test/m3-task-2-view-events.test.ts`: a loaded mod's rules drive `stepStatus` and the feed, dispose takes them away, 14 hostile status values and 7 hostile hidden values refused and left out by the app, hostile row types and data, stand-in condition with a list that does not start with `approve`, nothing throws before the first reply.

Red at HEAD: I could not check out HEAD (not allowed), so I ran only what I could against the old code:
- Ran at HEAD: `m3-task-2-moves` (green: it is the pin) and the first block of `m3-task-2-receipt` (green: pin); the second block of `m3-task-2-receipt` was red (the fixed names went to `counts`).
- Red at HEAD by reading (the feature is absent there, so these cannot pass): the whole `m3-task-2-mod-events` file except its first lines (`status` and `hidden` are "not part of a view"), `m3-task-2-view-events`, the `hostChose` and "reads as none" tests of `m3-task-2-session`, the `sameAsRun` hook tests of `m3-task-2-repeat`, and the guard's main test (stepStatus, feed, hidden, runState, run-cli, receipt and session named the events; after the moves only the 7 allowlisted lines are left).

## Mutations (35 hand-applied; each shown red; file restored from its bytes, hash compared: all equal)

| # | Break | First red test |
|---|---|---|
| M01 | gate's fixed name bumps `loopAttempts` | m3-task-2-receipt |
| M02 | fixed-name lookup finds `Object` members (`FIXED[k]`) | m3-task-2-receipt (`constructor`) |
| M03 | fixed names go to `counts` | m3-task-2-receipt |
| M04 | gate `count` names `loopAttempts` | m3-task-2-receipt, m3-task-2-moves |
| M05 | verify pass/fail swapped | m3-task-2-receipt |
| M06 | recall skipped/recalls swapped | m3-task-2-receipt |
| M07 | store counts into `knowlRecalls` | m3-task-2-receipt |
| M08 | repeat counts into `gatesHeld` | m3-task-2-receipt, m3-task-2-moves |
| M09 | recall print words changed | m3-task-2-moves |
| M10 | model print condition flipped | m3-task-2-moves |
| M11 | repeat never sees a command child | m3-task-2-repeat (4) |
| M12 | repeat does not catch a throwing atom hook | m3-task-2-repeat |
| M13 | `tests` atom: no command no longer matches | m3-task-2-repeat |
| M14 | `cmd` atom matches any command | m3-task-2-repeat |
| M15 | event and data names not screened (`__proto__`, `constructor`) | view-events, mod-events |
| M16 | a mod may name a core event in `status` | mod-events |
| M17 | a hidden event may repeat | view-events, mod-events |
| M18 | any `state` accepted | view-events, mod-events |
| M19 | `when` ignored by `stepStatus` | view-events, stepStatus (11) |
| M20 | `why` words found through the prototype | view-events |
| M21 | label learnt for every outcome | view-events |
| M22 | feed evidence target swapped | feed (loop_budget_exceeded), view-events |
| M23 | a hidden event may be feed structure | view-events (SURVIVED first; test added; now red) |
| M24 | `hidden.has` ignores the views | registry, view-events |
| M25 | session: "same" not recorded | m3-task-2-session |
| M26 | session: the record of the run before leaks | m3-task-2-session |
| M27 | session: a damaged record is believed | m3-task-2-session |
| M28 | stand-in condition named `approve` | view-events |
| M29 | runState ignores `cursor` | runState (gate_paused sets the step) |
| M30 | stepStatus ignores `cursor` | view-events (SURVIVED first; test added; now red) |
| M31 | session does not save the record | m3-task-2-session |
| M32 | injected `t === 'verify_result'` in `viewEvents.ts` | guard |
| M33 | injected keyed `loop_iteration: ...` in `feed.ts` | guard |
| M34 | injected double-quoted `"store"` read in `session.ts` | guard |
| M35 | the guard's event rules switched off | guard (allowlist goes stale) |

Survivors: none. Two (M23, M30) survived on the first pass; I added a test for each and both are red now. One equivalence: replacing `Object.hasOwn` by `in`
inside `holds` and `own` (`viewEvents.ts`) changes nothing, because every data key that reaches them has passed the name check that refuses `Object.prototype` members.

## Existing tests edited

Only `packages/core/test/no-kind-branch.test.ts` (as the brief says): the event list (7 kind events plus every `provides.events` of a pack manifest, quoted or, for names with
an underscore, as an object key), two tests of the new matcher, the allowlist entries for the reserved-name lists (7 lines in `run.ts`, 2 in `viewShape.ts`),
and "a pack mod's own folder may name its own events". No test that types a kind outside the merged names needed an edit. No golden and no other test was touched.

## Other files touched beyond the brief's list (small)

`cond.ts` (the `sameAsRun` hook type), `conds/tests.ts`, `conds/cmd.ts`, `condKinds.ts` (`standInCond`), `runState.ts` (the missed `gate_paused`),
`nodes/fields.ts`, `nodes/index.ts` (comment on `count`), the two READMEs (`core/src/nodes/README.md`, `server/src/mods/README.md`: one paragraph each).

## Anything the plan got wrong, and behaviour I changed on purpose

1. `runState.ts` also names `gate_paused` (plan missed it). Covered by `cursor`.
2. `BlockPanel.tsx` was already done; the line numbers in the plan are stale everywhere.
3. The plan says `repeat` does `NODES.get(...)` and `CONDS.get(...)`. In Task 6 `repeat` becomes a mod that may use only `api.core`, which has no `NODES` or `CONDS`. Task 6 needs `api.core` to carry the two lookups (something like "does this kind's op run a command" and "is this atom the run's command"), by a reviewed edit. Until then `repeat.ts` imports `NODES` and `CONDS` (a cycle through `nodes/index.ts` that is only used at compile time; no test imports `repeat.ts` alone).
4. `isCoreEvent` is true for the 7 kind events. A pack mod that brings `gate`, `repeat`, `verify`, `recall`, `store` or `model` cannot name its own event in `view.status`, `view.hidden` or `view.rows` until that event leaves `CORE_EVENTS` and `RunEvents` (and `m2-fix-25a-a.test.ts`, which pins them equal, is edited). Tasks 4, 6, 7 must do this together with the move.
5. A run saved by an older build has no `hostChose`, so its first resume after upgrading does not say "This run's model block chose ...". Everything saved by this build does. A hard kill between the switch and the next snapshot save could also lose it; the same window existed for the event, since the model step logs `model_switched` right after the switch and every event saves.
6. Fixes found on the way, harmless to existing output: `stepStatus` looked the model words up with `MODEL_WHY[d.how]` on a plain object (`how: 'constructor'` found `Object`'s member); now by own property. `feed()` did `ROLE[key]` on a plain object (a row type `__proto__` threw "role is not a function"); now own property only.
7. A mod's `count` can name a fixed field and so raise `gatesHeld` and the like for its own events. The trust prompt is the gate (it could already put any number in `counts`).
8. A kind's event with a `status` rule is structure in the feed (not a bead), unless the event is also in `view.hidden` (then the rule still marks the run and the row is simply hidden, as `model_switched` is today). A mod that wants both a mark and a drawn row on one event cannot have it; it uses `rows` without `status`. Noted in the mods README.
9. The guard limits (also in the file): a quoted name or, for names with an underscore, an object key; `recall` and `store` are caught only when quoted, because they are common words.
10. Line endings: all files I edited keep their endings (verified by bytes: no mixed file). `rows/hidden.ts` was rewritten; I wrote it back with CRLF like its siblings (git stores LF; I could not read the old working-tree bytes any more). New test files are LF; `app/src/viewEvents.ts` is LF.

## Open for the next tasks

- Tasks 3 to 8: for each kind delete its names from `RunEvents`, `CORE_EVENTS` (and the guard's 7 allowlist lines), add the event to the mod's `provides.events`, and edit `m2-fix-25a-a.test.ts`'s pin.
- Task 6: `api.core` lookups for `repeat` (point 3).
- The guard already reads `provides.events` of every manifest with a `pack` key and skips a pack mod's own folder for events.

## git status --short (my files)

```
 M packages/app/src/Workspace.tsx
 M packages/app/src/condKinds.ts
 M packages/app/src/feed.ts
 M packages/app/src/rows/hidden.ts
 M packages/app/src/runState.ts
 M packages/app/src/stepStatus.ts
 M packages/core/src/cond.ts
 M packages/core/src/conds/cmd.ts
 M packages/core/src/conds/tests.ts
 M packages/core/src/nodes/README.md
 M packages/core/src/nodes/fields.ts
 M packages/core/src/nodes/gate.ts
 M packages/core/src/nodes/gate.view.ts
 M packages/core/src/nodes/index.ts
 M packages/core/src/nodes/model.ts
 M packages/core/src/nodes/model.view.ts
 M packages/core/src/nodes/recall.ts
 M packages/core/src/nodes/repeat.ts
 M packages/core/src/nodes/repeat.view.ts
 M packages/core/src/nodes/store.ts
 M packages/core/src/nodes/verify.ts
 M packages/core/src/nodes/verify.view.ts
 M packages/core/src/receipt.ts
 M packages/core/src/viewShape.ts
 M packages/core/test/no-kind-branch.test.ts
 M packages/server/src/mods/README.md
 M packages/server/src/run-cli.ts
 M packages/server/src/session.ts
?? docs/plan/m3-task-2-report.md
?? packages/app/src/viewEvents.ts
?? packages/app/test/m3-task-2-view-events.test.ts
?? packages/core/test/m3-task-2-receipt.test.ts
?? packages/core/test/m3-task-2-repeat.test.ts
?? packages/server/test/m3-task-2-mod-events.test.ts
?? packages/server/test/m3-task-2-moves.test.ts
?? packages/server/test/m3-task-2-session.test.ts
```
