# Reins Core Design Notes & Ambiguity Resolutions

1. Block workflows: Identified by `block: <name>` in frontmatter, represented with `block?: string` in Workflow model, printed with `block:` and omitting budget.
2. YAML strings containing colons: Strings with colons or special characters (such as task descriptions) are quoted in frontmatter to ensure valid YAML parsing.
3. Step conditions in model: Attribute `until:` is parsed into `step.cond` and deleted from `step.attrs` to prevent duplicated condition state.
4. Step label in compileTurn header: Uses `step.title` when present, otherwise falls back to `step.kind`.
5. Glob validation: Checks balanced brackets and compilation via `picomatch.makeRe` with strict slashes.
6. Associativity in printCond: Right-nested `and`/`or` subexpressions are wrapped in parentheses when having the same operator to preserve exact AST associativity on round-trip.
7. Nested container else blocks: Line scanner checks depth `parent.depth + 1` so inner `if` containers do not accidentally consume an outer `else`.
8. Live edit continuation: When modifying a workflow after a step finished, execution resumes at the instruction immediately following the finished step; removing the current step pauses with `step-deleted`.
9. Automated gate evaluation: Gates with automated conditions (tests, commands, diffs) evaluate immediately and only pause if unsatisfied or if condition is `you approve`.
10. Same error twice condition: Evaluates to true only when the last two consecutive commands failed with matching normalized output (a successful command resets the error streak).
11. Safe refactor turn counting: When the loop test command passes on the first attempt, the fix step is bypassed and total executed turns is 4.
12. Auto-card condition evaluation restriction: For `whenever` auto cards, conditions only evaluate atoms that do not initiate shell commands or model calls (`same`, `attempts`, `diff`, `touches`, `drift`, `done`), plus `and`/`or`/`not` of these. Auto cards never start a command or model query on their own.
13. Card single-dispatch delivery: Cards queued prior to turn compilation are injected into the turn text and marked `next-turn`, then removed from pendingCards to guarantee they are never re-delivered mid-turn.
14. Recall context single-turn lifetime: Retrieved recall context from injected `recall()` is scoped strictly to the next turn prompt and cleared immediately after compilation.
15. Store and handoff turn semantics: STORE and HANDOFF compile and dispatch an agent turn to elicit decision or handoff summaries, stripping `REINS:` status headers prior to calling the injected store callback or emitting the handoff event.
16. Loop limit extensions: Rather than decrementing attempt counters upon `allowMore(n)`, the loop limit is extended via a dedicated `loopLimitExtensions` map, ensuring receipt reporting reflects actual attempt history.
17. `next` after a container: a `next` on a `repeat` means "when the whole group is done"; the jump is compiled after the container's last instruction.
18. Link budgets: `verify`, `run` and `next` share one budget mechanism, keyed `${step}->${index}` (`on-fail`) and `${step}~next->${index}` (`next`). A link pause remembers its jump in `pauseReason.to`, and `allowMore` takes that jump.
19. Deprecated wires: `retry`, `on-pass`, `verify-against` and the `hand-off` link are still parsed and printed, but the validator warns that they have no effect.
20. Unresolved `next`: a `next` whose target id does not exist falls through to the next instruction instead of jumping.
21. Unreachable steps: a step is unreachable when its entry instruction (the first instruction compiled for it) is never visited by walking the compiled program from the start.
22. Rename gap: `renameStep` does not rewrite a `use` block's inner `against:`, which refers to the parent's id and is not prefixed when the block is inlined.
