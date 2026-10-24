# M4 group A report (app): playbook rename

## Inventory (case-insensitive `workflow`, before editing)

Total 391 hits: `packages/app/src` 136, `packages/app/test` incl. fixtures 227, `packages/server/test/*.browser.test.ts` 28.

| Class | Count | Notes |
|---|---|---|
| WORDS (changed) | 22 src lines (23 replacements), 14 test lines | see below |
| IDENTIFIER/FORMAT (kept) | about 300 | type `Workflow`, `parseWorkflow`, `printWorkflow`, `WorkflowPanel`, `ShareWorkflow`, `.workflow` fields, `workflow:` keys, `/api/workflows`, `/workflow?path=`, `.reins/workflows/` paths, `WORKFLOW` consts |
| BOTH | 0 undecided | every shown word was changed together with the test that pins it |
| Comments and test titles (kept) | 30 comments, 16 `it`/`describe` titles, plus prose in test comments | developer text, not read by a user |

Per file, words changed (src): BlockPanel.tsx 1, BlocksPane.tsx 3, Composer.tsx 2, FeedView.tsx 1, ImportSummary.tsx 2, ShareWorkflow.tsx 2 (one line), menus.ts 1, runState.ts 1, TextTab.tsx 8, Workspace.tsx 1, rows/run_started.tsx 1. app.css has no `content:` string with the word (one comment only).

Changed strings: aria-labels `Playbook panel`, `Playbooks`, `Playbook name`, `Playbook text`, `Turns/Minutes/USD of the playbook`; placeholder `new-playbook-name`; button `New playbook`; `No playbooks yet.`, `No playbooks in this folder.`, `Pick a playbook, or make a new one.`, `A playbook with that name already exists.`; confirm text, loose-block hint, park menu label and note, Share tooltip, `Playbook {name}` hat of a run strand, `playbook <name>` divider row, `(not a playbook run)`, import summary `Playbook: ...` and `and the playbook <name>`.

## Kept, and why

- Types, functions, components, variables, CSS classes, `run.workflow`, `r.workflow`, `s.workflow`: identifiers.
- `workflow:` keys in API bodies and replies, `run_started` data, snapshot and editor-state (`restore.workflow`): format.
- `/api/workflows`, `${base}/workflow`, `.reins/workflows/${name}.reins.md`, `.reins/workflows` in test paths: routes and folder names.
- Comments in src (30, e.g. `ShareWorkflow.tsx:27`, `ImportSummary.tsx:21`, `stepStatus.ts:150`, `canvasKinds.ts:41`, `app.css:436`) and test titles/comments: developer text. Say so if you want them swapped too.
- `printWorkflow(...)`, `parseWorkflow(...).workflow` in tests: identifiers.

## Existing tests and fixtures edited (expected words only, no assertion loosened or deleted)

- `packages/app/test/blocksFace.test.ts` (10 lines): aria-labels `of the workflow` to `of the playbook`; the diagnostic fixture `over the workflow's $2.00` to `playbook's` (it is the core message, which group B changed in `validate.ts`).
- `packages/app/test/runState.test.ts` (3 lines): `PHASE.busy.words` expected `(not a playbook run)`; the note fixture `The playbook is not trusted, so it did not run.` (matches the server text now in `session.ts`).
- `packages/app/test/fixtures/run-with-gate.json` (1 line, a recorded fixture, not a golden): prompt `This playbook runs the commands below...`. Diff is exactly the word swap.
- `packages/server/test/smoke.browser.test.ts` (5 lines): `Playbook name`, `New playbook`, `Playbook text`, `Playbook panel`, and the negative `not.toContain("Set the playbook's USD budget first")`.
- `packages/server/test/live.browser.test.ts` (3 lines): `Playbook text`, `The playbook is not trusted...`, `Asked by the playbook's model block` (these two follow group B's server text in `session.ts`).

## Results

- `vitest run packages/app --maxWorkers=1`: 58 files, 898 tests passed.
- `npm run typecheck` and `npm run lint`: clean.
- App bundle rebuilt with vite (not `npm run build`), then browser tests run one at a time: smoke 2 passed, live 1 passed, canvas-chips 2 passed (8d.10 did not flake this time).
- Line endings: every edit was done on bytes at exact lines or exact strings; insert and delete counts match per file in `git diff --stat`, so CRLF is untouched. No U+2014 in app src.

## git status --short (my files)

```
 M packages/app/src/BlockPanel.tsx
 M packages/app/src/BlocksPane.tsx
 M packages/app/src/Composer.tsx
 M packages/app/src/FeedView.tsx
 M packages/app/src/ImportSummary.tsx
 M packages/app/src/ShareWorkflow.tsx
 M packages/app/src/TextTab.tsx
 M packages/app/src/Workspace.tsx
 M packages/app/src/menus.ts
 M packages/app/src/rows/run_started.tsx
 M packages/app/src/runState.ts
 M packages/app/test/blocksFace.test.ts
 M packages/app/test/fixtures/run-with-gate.json
 M packages/app/test/runState.test.ts
 M packages/server/test/live.browser.test.ts
 M packages/server/test/smoke.browser.test.ts
```

## Unconfirmed / for other groups

- Words the app shows that arrive from the server or core (group B): the `The run did not start: ...` note, `Asked by the ...` detail, trust prompt. The browser tests now expect `playbook`; they passed against B's current `session.ts`. If B changes those words again, these two browser tests need the same edit.
- Not checked: the file name `ShareWorkflow.tsx` and component names stay (identifiers).
- The `reins-mods` download file name and the `shareName` helper are unchanged (format).
