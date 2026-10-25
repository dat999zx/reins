# M2 Task 18 report: core question cards as data; condition and card editor data

Worktree `D:/coding/reins-wt-fork`, branch `feat/fork-playbook`, HEAD 2b011c3. Nothing committed, added, stashed or reset. Task 23 (docs) ran at the same time; its files (`CHANGELOG.md`, the two READMEs) are not mine and I did not touch them.

## Things for the orchestrator first

1. **Edits outside the brief's list, all forced by the move:**
   - `packages/app/src/BlockPanel.tsx`: it is the add-card menu (`CARD_LABEL[CARD_KINDS[0]]`, `.add`, `.section`) and also had the unguarded `KINDS[step.kind]` read that the 17b report flagged. Now `viewOf(step.kind)`, and the cards section is drawn only when the server has sent a card (`card && cardKind`). Without this the panel throws before the first reply.
   - `packages/app/src/Palette.tsx`, `editorState.ts`, `App.tsx`: the palette lists conditions; `cleanCond` checked `c.t in COND_KINDS`; App has the one fetch (`setConds`, `setCards`, `setQuestions` beside `setKinds`).
   - `packages/app/test/setup-kinds.ts` (17b's file): also fills conditions, cards and question cards from the same builder.
   - `packages/server/src/mods/loader.ts`: the api door (see 3) and `viewless` (a condition or card handed over by code loses a `view` it carries).
   - `packages/core/src/cond.ts`, `cards/index.ts`, `cards/guard.ts`, `conds/index.ts`, the 11 `conds/*.ts`: the data itself.
2. **`default?` is not built.** The brief's `CondType.view?` shape lists `{ label, fresh, param?, default? }`. `fresh` is already the default atom, so `default` would be a second copy of it. I did not add the field; a manifest that carries one is refused ("not part of a condition's view"). Say if you meant something else by it.
3. **The api-level refusal is defence in depth only.** `loader.ts` `has()` now also calls `questionRefusal`, but it can only be reached after `provides` passed `validateMod`, which already refuses the same names. So an api call naming a question card is refused today by the existing `provides ... does not list` words (tested end to end), and mutation M25 (my new api line removed) survives. Equivalent: `provides[key].includes(name)` is false whenever the manifest check would have refused it.
4. **Brief said `Allow` with `0.5` sends `allow 0.5`.** At HEAD the money card sends `allow $0.5` (the `$` is part of the answer the server parses); the turns card refuses `0.5`. I kept HEAD (the brief also says the app must show the same answers). The pin records both.
5. **The `gate` name.** `gate` is both a question card and a built-in block kind. A mod block that provides the `gate` kind (Customize shadowing, M3) must not be refused by this rule, so `questionRefusal('kinds', n)` skips names that are built-in block kinds. `cards` and `conditions` refuse every question name, `gate` included.
6. **Where a mod condition's view comes from.** Like a block mod's view: the manifest's `view` (an object keyed by each name in `provides.conditions` / `provides.cards`), checked when the mod loads, recorded in the per-load registry (`cond-view`, `card-view`). Code cannot hand one over. The served list holds only conditions and cards that are in core now (an untrusted or failed mod is not offered); the manifest's data wins over the built-in's for the same atom. Order is core's registry order (`CONDS` / `CARDS`), so a mod condition at `order` 25 sits between `tests` and `cmd`.
7. **Plan notes.** The plan said `GET /api/kinds` replies with `generation`; still not added (it was not needed here). The reply now is `{ kinds, conds, cards, questions, problems }`.
8. Pre-existing and unchanged: the app's `Workspace.tsx` / `TextTab.tsx` drop and click handlers and the `App.tsx` fetch have no DOM test harness (as 17b noted); my changes there are guarded one-liners covered by typecheck only.

## What I built

- **Question cards:** `packages/server/src/questions/{budget,gate,judge,resume,switch,tool,trust,usd}.ts` (one plain-data file each, `satisfies QuestionCard`), `types.ts`, and `index.ts` (`QUESTIONS`, deep-frozen; `questionRefusal`). Data form: each action has `label`, `primary?`, `answer`, and an optional `field { placeholder, initial?, check?: 'usd' | 'count', empty? }`. `{text}` in `answer` is the trimmed typed text; `empty` is what an empty box sends (resume: `resume`, tool Deny: `n`), without it the button is off. `count` = whole number of 1 or more, sent without leading zeros (`007` -> `allow 7`, as HEAD); `usd` = HEAD's `parseBudget('usd')`. No register call, no registry a mod can reach, no mod kind for questions.
- **Refusal:** `kinds.ts` `providesProblems` (shared by block, condition and card) refuses a question name in `provides.cards`, `provides.conditions`, `provides.kinds` with words; `loader.ts` `has()` repeats it at the api.
- **Condition and card editor data:** `CondView`, `CondParam`, `COND_PARAM_KEYS` (`cmd q n glob`), `COND_PARAM_LOOKS` in `core/src/cond.ts`; `CondType.view?` on the 11 built-ins (moved verbatim from `condKinds.ts`); `builtinCondView`. `CardView`, `CardType.view?` (guard: Guards / Add guard), `builtinCardView`. `kinds.ts` checks a mod's `view` when it loads: only keys in `provides`, label and words at most 60 characters, `fresh.t` equal to the name and only text/number/boolean values, `param` exactly `{ key, look, optional? }` with `key` one of the four and `look` one of four, size cap 32 KB, no hidden character anywhere (keys too). A `view` is optional.
- **Served:** `kinds-view.ts` `servedKinds` returns `{ kinds, conds, cards, questions, problems }`. Every value is a JSON copy; every string (keys too) goes through `hasHiddenChars`; a failing entry is left out and named in `problems` with `\uXXXX`. `t` / `kind` of a served condition or card is the registry's, never the view's. Questions are copies (editing a reply cannot touch the frozen data).
- **App:** `questions.ts` has no glob; `setQuestions(list)` builds the same `{ label, primary, field, build }` the card component already used (so `QuestionCard.tsx` is unchanged). An entry with an unknown check or a missing word is left out and its kind gets the generic card. Names are looked up in a `Map`, checks with `Object.hasOwn`. `condKinds.ts` keeps `applyParam` and `OK`; `COND_VIEWS` (null-prototype) and `setConds`, `freshCond(t)` (a copy, `undefined` for an unknown name: no `!` reads). `canvasKinds.ts`: `CARD_KINDS` and `CARD_LABEL` filled by `setCards`. `COND_KINDS` is gone, so `condKinds.ts:8`'s `'tests'` is no longer in the app program.
- **Deleted:** the eight `packages/app/src/questions/*.ts` (their data is now the server files).

## Tests

New: `packages/app/test/questionsPin.test.ts` (16) with `fixtures/head-questions.json`, `packages/app/test/servedMenus.test.ts` (18), `packages/server/test/questions-cards.test.ts` (45).

- **Pin recorded from HEAD first:** before moving anything I ran a throwaway test against the HEAD code that wrote `fixtures/head-questions.json`: for every button of the eight cards (and the generic card) the label, primary flag, field, and the answer it built for 18 typed texts, plus `COND_KINDS` (label, fresh, param, order) and `CARD_LABEL`. `questionsPin.test.ts` compares the served data to it and has never been edited to fit. The throwaway file is deleted.
- **Red at HEAD:** all three new files (the modules, `setConds`, `setCards`, `setQuestions`, `CondType.view`, `QUESTIONS`, the refusals and the reply keys did not exist). Not run at HEAD (no checkout allowed); red by construction. The pin's question half uses only `actionsFor` / `detailFor`, which HEAD has with the same signature, and it holds the data recorded from them. **Already green at HEAD:** nothing in them, except that pin's behaviour part.
- Covered: gate sends `approve`, `changes <note>`, `stop`; `Allow` with `x` sends nothing (money and turns cards); money `0.5` -> `allow $0.5`; turns `007` -> `allow 7`; `$&` / `$1` in the typed text sent as typed; each card's buttons and templates equal the recorded HEAD data (server table and app answers); the list is frozen to the leaves and an edit throws; the route and `servedKinds()` serve the eight; a served copy is its own; a registry entry named `question` changes nothing; a mod of kind `question` is not a kind; manifest refusal for a condition, a card and a block mod (and `gate` as a block kind is not refused for this); an api call naming `usd` / `budget` is refused and registers nothing; `param.key` `x`, `constructor`, `3` refused with words, `cmd q n glob` accepted and served; 15 other bad views refused (look, optional, extra param field, extra entry field e.g. `default`, no label, long label, wrong `fresh.t`, object/list in `fresh`, name not provided, bad entry, list view), hidden character in a label, a fresh value and a key, over 32 KB; a card view with an extra field or a missing word; a condition mod with no view loads but is not offered; built-in conditions served in core's order with their views (and the guard card); a mod condition served at its place; code-supplied `view` ignored for conditions and cards; untrusted mods not offered; manifest view wins over built-in's; served `t` is the registry's; hidden-character label not served (condition and card) with `\u` words and none in the reply; a hidden character in a view key; a non-JSON view; a second mod that names a taken condition leaves no view behind; the Blocks pane menu and the palette list exactly the served labels (and a changed served list changes both); an empty list does not throw; a condition the app has no entry for draws as its name; names of `Object` are not conditions, cards or questions; `setConds`, `setCards`, `setQuestions` filters; the block panel draws the served section and add words, and nothing before the reply.

## Existing tests edited (exception approved by the orchestrator)

- `packages/app/test/condKinds.test.ts`: imported `COND_KINDS` (deleted). Now reads `COND_VIEWS` and `freshCond`; same assertions (exactly the core atoms, unique labels, every fresh atom prints and reads back, a new object per call; `applyParam` block untouched).
- `packages/app/test/setup-kinds.ts` (17b's file, not a test): also fills conditions, cards and question cards.
- No other existing test edited. `questions.test.ts`, `answers.test.ts`, `canvasKinds.test.ts` (checks `CARD_KINDS` and `CARD_LABEL.guard`), `blockPanel.test.ts`, `unknownKind.test.ts`, `views.test.ts`, `editorState.test.ts`, `blocks*.test.ts`, `kinds-route.test.ts`, `toy-block*.test.ts`, `catalog-mods.test.ts`, `core/test/wires.test.ts` pass unedited (369 tests in the last run of those 15 files). No existing test imported the eight deleted files (they were only reached by `import.meta.glob`).

## Mutations (hand-applied by string replace in a script, restored from the saved bytes, SHA-256 compared equal after each; no git command)

Each was run against my three files plus `condKinds.test.ts` and `kinds-route.test.ts`.

| # | Mutation | Red (first) |
|---|---|---|
| M1 | budget template `allow  {text}` | data table, route, app pin |
| M2 | gate loses its Stop button | data table, route, app pin |
| M3 | usd field check `usd` -> `count` | data table, route, app pin |
| M4 | manifest refusal of question names removed | 3 mod-refusal tests |
| M6 | `param.key` check removed | `x`, `constructor`, `3` |
| M7 | served conditions reversed | served order, route, mod-at-place |
| M8 | `freshCond` without guard | empty-list test |
| M8b | `actionsFor` without the generic card | 3 tests |
| M9 | question list not frozen | frozen-to-the-leaves test |
| M10 | hidden-character check removed in the builder | 3 tests |
| M11 | `setConds` accepts any param | filter test |
| M12 | unknown check allowed in `setQuestions` | 2 tests |
| M13 | `count` allows 0 | budget pin |
| M14 | `replace('{text}', v)` (a `$&` pattern is read) | pattern test |
| M15 | code can hand over a condition `view` | code-view test |
| M16 | built-in view beats the manifest's | manifest-wins, hidden tests |
| M17 | `t` taken from the view | served-t test |
| M18 | `setCards` takes an entry with no `add` | filter test |
| M19 | `cleanStep` accepts any condition | 2 tests |
| M20 | block panel draws the cards section with no card | empty-cards test |
| M21 | block kind `gate` also refused | refusal table, block test |
| M22 | manifest view hidden-character check removed | hidden-character test |
| M23 | questions served uncopied | copy test |
| M24 | setup file skips questions | 12 tests |
| M26 | `primary` flag dropped in the app | 8 tests |
| M27 | `param.key in OK` instead of `Object.hasOwn` (survived until I added `toString` and `look: constructor` entries to the filter test) | filter test |
| M28 | `fresh.t === name` check removed | wrong-`t` test |
| M29 | label length unlimited | long-label test |
| M30 | view name not in `provides` allowed | not-provided test |
| M32 | card view extra field allowed | card-view test |
| M33 | `viewless` not applied to cards | card code-view test |
| M35 | manifest views not recorded | 3 tests |

Survivors and why:
- **M25** (api door `questionRefusal` removed): equivalent, see 3 above.
- **M31 / M34** (my own undo code for the recorded views) survived, which showed the code was dead: the host's registry already writes down every `register`, so dispose and a failed activation remove the views anyway. I deleted `recordNamed` and its try/catch; `recordWith` is now four lines. The two tests that guard the behaviour (the view is gone after `dispose`; a second mod that fails on a taken name leaves no view) stay and pass; M35 shows they go red when views are not recorded.
- Not covered by any test (no DOM harness): the `onChange` / drop / click handlers in `BlocksPane.tsx`, `TextTab.tsx`, `Workspace.tsx` (guarded `freshCond` results) and the `App.tsx` fetch wiring.
- Not mutated: `usd` check `r.value !== undefined` removal is equivalent (an empty text then reaches `empty ?? null`, which is null).

## Gate-style checks run (my files only)

`tsc --noEmit` (root) and `tsc -p packages/app`: no errors. `eslint` on `packages/app`, `packages/server/src`, `packages/core/src` and my test file: clean (the app may not import runtime values from `@reins/core`, so `condKinds.ts` checks `param.key` with its own `OK` table, which is exhaustive over core's key list by type). All touched and created files CRLF with 0 bare LF, no U+2014, no non-ASCII in the new source. No provider product name in `packages/*/src`.

## git status --short (my files)

```
 M packages/app/src/{App,BlockPanel,BlocksPane,Palette,TextTab,Workspace}.tsx
 M packages/app/src/{canvasKinds,condKinds,editorState,questions}.ts
 D packages/app/src/questions/{budget,gate,judge,resume,switch,tool,trust,usd}.ts
 M packages/app/test/condKinds.test.ts
 M packages/app/test/setup-kinds.ts
 M packages/core/src/cards/{guard,index}.ts
 M packages/core/src/cond.ts
 M packages/core/src/conds/{approve,attempts,cmd,diff,done,drift,index,llm,review,same,tests,touches}.ts
 M packages/server/src/mods/{kinds-view,kinds,loader}.ts
?? packages/app/test/fixtures/head-questions.json
?? packages/app/test/questionsPin.test.ts
?? packages/app/test/servedMenus.test.ts
?? packages/server/src/questions/        (types.ts, index.ts, and the eight card files)
?? packages/server/test/questions-cards.test.ts
?? docs/plan/m2-task-18-report.md
```
