# M4 group C (docs) report

## Inventory (case-insensitive `workflow`, my files, before edits)

| File | Hits | WORDS (changed) | Kept |
|---|---|---|---|
| README.md | 8 | 7 | 1 (path) |
| CHANGELOG.md | 10 | 9 | 1 (`### Workflows` heading of released 0.1.0) |
| packages/core/NOTES.md | 2 | 2 | 0 (but see kept: `Workflow model` is inside a changed line) |
| packages/core/src/nodes/README.md | 2 | 2 | 0 |
| packages/server/src/mods/PACK.md | 29 | 25 | 4 |
| packages/server/src/mods/README.md | 6 | 6 | 0 |
| examples/** | 0 | 0 | 0 |

Total: 57 hit lines; every changed line was edited with a script that touched only lines containing the word, protecting the keep list below. Several lines held more than one hit.

## Kept, and why (remaining hits after the edit)

- Folder paths: `.reins/workflows/` (README.md:49, PACK.md:261, PACK.md:435 `<home>/workflows/`).
- Envelope JSON key `workflow` (PACK.md:413 and :419): format key the importer reads. The sentence around it now says playbook.
- Code type `Workflow model` (NOTES.md:3): identifier.
- CHANGELOG `### Workflows` (released 0.1.0 section) and the two other released sections (0.1.x): history, left as written. The new entry says how to read them.
- CHANGELOG:7 is the new rename entry; it names the word and the folder.

## Edits beyond the swap (rewritten for sense)

- PACK.md: "A playbook can use another playbook through the playbook block."; "The used playbook" / "The playbook that uses it (the outer one ...)"; the `usd:` row says "the budget of the playbook that uses it"; "the id of the playbook block in front"; "A playbook block names a file"; "Whoever imports the outer playbook"; `workflow` key bullet.
- CHANGELOG: same "budget of the playbook that uses it" fix; new entry at the top of Unreleased (what users see, what did not change, how to read old notes).

## Tests / goldens

- `packages/server/test/m3-fix-c-guide-examples.test.ts`: run, 23 passed, NOT edited (it pins no changed doc sentence; the fenced examples were not touched). No other test or golden edited.

## Checks

- Line endings: all six files CRLF-only before and after (counts equal CR LF, no change in the other lines). No U+2014 in any of them.
- `git status --short` (my files): `M CHANGELOG.md`, `M README.md`, `M packages/core/NOTES.md`, `M packages/core/src/nodes/README.md`, `M packages/server/src/mods/PACK.md`, `M packages/server/src/mods/README.md`, `?? docs/plan/m4-C-report.md`.

## Package descriptions

- `packages/server/package.json:4`: "Scratch for agent loops: workflows with gates, loops and live cards for Claude Code." NEEDS a change to "playbooks with gates ..." (not edited: outside my list; for the orchestrator).
- Root `package.json` and the other `packages/*/package.json`: no `workflow` in the description.

## Unconfirmed

- Did not run lint on the md files (none). `spike/results.md`, `spike/tmp/*.md` and `packages/core/test/fixtures/blocks/*.md` are not docs I own; grep showed no `workflow` word in the md set I searched, but I did not search the spike folder.
