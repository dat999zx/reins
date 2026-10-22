# M2 Task 17b report: `GET /api/kinds`; the app built from it; test setup; app tsconfig

Worktree `D:/coding/reins-wt-fork`, branch `feat/fork-playbook`, HEAD 593b6ea. Nothing committed, added, stashed or reset.

## Two things for the orchestrator first

1. **One edit outside my file list: `packages/core/src/index.ts`** (two lines) plus a NEW file `packages/core/src/views.ts`. The brief says "the 13 `*.view.ts` that core exports"; core exported none (no `BUILTIN_VIEWS`, no `KindView` type). The server cannot import `../../core/src/nodes/*.view.ts` (its build has `rootDir: src`), so the only clean way is a core export. `views.ts` sits in `src/`, not in `src/nodes/`, because `core/test/nodes-registry.test.ts` treats every file in `nodes/` as a node kind. `index.ts` gained `export * from './views.js'` and `export type { Field, KindView, Token } from './nodes/fields.js'`. If you refuse the edit, revert those two lines and `kinds-view.ts` needs another source for the views. (Another task has since added `export * from './nodes/data-block.js'` on the line above; I did not touch it.)
2. **`packages/app/src/BlockPanel.tsx` is not in my list and still reads `KINDS[step.kind]` unguarded** (`:119`, then `k.fields.map` at `:132` and `k.cards` at `:144`). The plan's list of unguarded reads does not name it. A selected block of an unknown kind (or any block before the first reply) throws there if the panel is rendered. Fix is one line: `const k = viewOf(step.kind)`. I did not touch it (rule 1). `blockPanel.test.ts` passes (it uses known kinds).

## git status --short (my files)

```
 M packages/app/src/App.tsx            M packages/app/src/arrows.ts         M packages/app/src/Palette.tsx
 M packages/app/src/BlocksPane.tsx     M packages/app/src/blocks.ts         M packages/app/src/TextTab.tsx
 M packages/app/src/canvasKinds.ts     M packages/app/src/editorState.ts    M packages/app/src/Workspace.tsx   (2 reads only, not `measure`)
 M packages/server/src/server.ts       M vitest.config.ts                   M packages/core/src/index.ts      (see above)
?? packages/core/src/views.ts          ?? packages/server/src/mods/kinds-view.ts
?? packages/app/test/setup-kinds.ts    ?? packages/app/test/unknownKind.test.ts   ?? packages/server/test/kinds-route.test.ts
```

All touched and created files are CRLF with 0 bare LF (counted by bytes). No U+2014. `packages/app/tsconfig.json` NOT edited (see below). No existing test edited.

## What I built

- **`server/src/mods/kinds-view.ts`**: `servedKinds(mods?)` returns `{ kinds, problems }`. Built-ins from core's `BUILTIN_VIEWS`, then every `block-view` in the registry (the manifest's JSON, never code). Each view is copied through `JSON.parse(JSON.stringify())` (a function or getter does not come along; an unreadable view is left out and said in `problems`). Every string, keys included, goes through `hasHiddenChars`; a view that fails is left out and `problems` names it with the hidden characters written as `\uXXXX`. A mod view named like a built-in kind is left out (a mod cannot override a built-in). `trusted: false` is set on a mod view whose mod is not trusted (or not found); a `trusted` key a manifest carries is removed first. Sorted by `order` (view `order`, else the manifest's `order`, else last), ties in the order they came, built-ins first. Used by the route AND by `setup-kinds.ts`.
- **Route** `GET /api/kinds` in `server.ts` beside `/api/tags` (behind the same token check): `ok(hide(servedKinds(mods)))`. Reply shape `{ kinds: [...], problems: [...] }`. No `generation` yet (the plan's reply also lists conditions, cards and question cards: those are Task 18).
- **`canvasKinds.ts`**: glob gone. `KINDS` is a null-prototype object, empty until filled. New `setKinds(list)` (leaves out an entry without string `kind`, array `fields`, array `line`), `registerView` kept, `viewOf(kind)` (the view or the unknown face), `unknownView(kind)`, `ServedView` type (`trusted?: false`). `capKind` has no `!`: returns `''` until a kind that stops is known (`addStepAt` of `''` is a no-op, so `ensureEnd` returns the workflow as is). `wiresOf` uses `viewOf`.
- **Unknown face**: neutral (`colour: 'soft'`, no fields, no group, no stops), one bold word `unknown block <name>`, name through core's `showText` and cut at 40 characters. The `BlocksPane` aria-label uses `showText(kind)` too. `data-kind` stays the raw kind (an attribute is never drawn).
- **Readers** (grep `KINDS\[[^\]]+\]\.` now finds none): drawing code uses `viewOf` (`BlocksPane`: name, colour/icon/stops attributes, sub, field find, line, thinking, group, cap zone); logic code uses `?.` (`blocks.ts` x6, `arrows.ts`, `editorState.ts`, `Workspace.tsx:280` and `:400`, `TextTab.tsx:350`, `Palette.tsx` x3).
- **`TextTab.tsx`**: the `known` gate (a step of a kind the app has no entry for hid the Blocks tab with "This file does not parse") is removed: the unknown face is what draws it now. Before the first reply it would also have shown that false "does not parse" text.
- **`Palette.tsx`**: a card of an untrusted mod's block gets `data-untrusted` and a title "This block's code is not trusted yet, so it will not run."
- **`App.tsx`**: fetches `/api/kinds` once (beside `/api/mods`), `setKinds(r.kinds)`, then `kindsReady`. The editor-state load effect waits for `kindsReady` (deps `[cwd, kindsReady]`): without that, saved loose blocks of a mod's kind would be read as unknown and dropped by `cleanStep` (`raw.kind in KINDS`) and the saver would then overwrite them. A failed fetch still sets `kindsReady` (the app works with unknown faces; loose blocks of unknown kinds are then dropped with the existing "could not be read" note).
- **`vitest.config.ts`**: `test.projects` (vitest 3.2.7 has it, measured): `core`, `server` (also `test/**`), `app`, each `extends: true`, same includes as the old single `include`; `setupFiles: ['packages/app/test/setup-kinds.ts']` on `app` only.
- **`app/test/setup-kinds.ts`**: `setKinds(servedKinds().kinds)`.
- **`packages/app/tsconfig.json`: not edited.** Typecheck of the app program needs the mod files only once a mod file declares a kind or condition name that app code compares with (spike B: `repeat.ts:80`, `:83`, `condKinds.ts:8`). Nothing in `src/mods/*/index.ts` does that yet (only `claude-code-cli`), and `npm run typecheck` shows no error from my files. The edit belongs to M3 Task 1/2 when the first pack mod moves.

## Tests

New: `packages/server/test/kinds-route.test.ts` (18), `packages/app/test/unknownKind.test.ts` (14).

Red at HEAD: both files wholly (`kinds-view.ts`, `BUILTIN_VIEWS`, `setKinds`, `viewOf`, `unknownView`, the route (404) and the projects config did not exist). Already green at HEAD: nothing in them.

Covered: 13 built-ins in order and equal to core's JSON; 401 without a token; toy-beep (through `tempHome`, trusted via a real `mod-trust.json`) served with the manifest view, after `end`, not flagged, `NODES.has('beep')`; nothing of `index.js` in the reply and only manifest keys; untrusted copy served, flagged `trusted: false`, code not run; a manifest `view.trusted` claim ignored; manifest order used when the view has none; hidden character in a label, a key, a nested field, a kind name, a line break: not served, problem written in `\u` form, route reply holds no such character; mod view cannot take a built-in kind; order with ties and a view with no order; function in a view dropped; unreadable view (throwing getter) left out; `trusted` for a view with no mod is false; `vitest.config.ts` shape (setup on app only) and a server test sees an empty app `KINDS`; the app renders toy-beep from the served JSON (face, palette card, `addStep` from `fresh`); untrusted card flagged; `setKinds` filtering and order; the unknown face (plain, nested in `repeat`, visible-safe and cut name, aria-label, `constructor` / `__proto__` / `toString` / `hasOwnProperty` / `valueOf`, `wiresOf`); the readers in `blocks.ts`, `arrows.ts`, `editorState.ts`, `Palette` with unknown kinds; the same readers plus `capKind`, `ensureEnd`, `BlocksPane`, `Palette` with an EMPTY `KINDS`; the list arriving then drawing real faces.

Existing tests: **none edited.** `views.test.ts`, `canvasKinds.test.ts`, `blocks.test.ts`, `blocksFace.test.ts`, `editorState.test.ts`, `feed.test.ts` all pass unedited through the setup file (the plan expected edits to the first two; their KINDS checks read the built list, which is the same list). `--project app` whole run: 48 files, 757 passed.

Other runs: `kinds-route + unknownKind + views + canvasKinds`: 81 passed. `server.test.ts`, `toy-block.test.ts`: pass. `npm run lint` on my files: clean. `tsc --noEmit` (root) and `tsc -p packages/app`: no error in my files. Errors seen elsewhere, not mine: `Workspace.tsx(446)` `cr` (Task 22), earlier `actions.ts` / `tracksView` ones (other tasks); `core/test/nodes-registry.test.ts > data-block.ts` fails (Task 19's new `nodes/data-block.ts` has no default node export; not caused by `views.ts`, which is outside `nodes/`).

## Mutations (hand-applied by string replace in an inline script, restored from the saved bytes, SHA-256 compared equal after each; no git command)

| # | Mutation | Red |
|---|---|---|
| M1 | serve the original object, not a JSON copy | function-in-view test |
| M2 | hidden char label served | 3 tests (label, key/nested) |
| M3 | hidden char in a key not checked | key/nested test |
| M4 | kind order reversed | 11 tests |
| M5 | no order fallback from manifest | manifest-order test |
| M6 | a mod view may take a built-in kind | built-in-kind test |
| M7 | `trusted: false` never set | 3 tests (untrusted toy-beep, claim, no-mod) |
| M8 | a manifest can claim `trusted` | claim test |
| M9 | untrusted unless known untrusted | no-mod test |
| M10 | setup file on the server project | config shape + server KINDS-empty test |
| M10b | setup file on the core project | config shape test |
| M11 | `capKind` `!` back | empty-KINDS test |
| M12 | `viewOf` has no unknown face | 7 tests |
| M13 | unknown name not visible-safe | visible-safe test |
| M14 | KINDS has a prototype | prototype-name test, setup test |
| M15 | `setKinds` takes any entry | `setKinds` filter test |
| M16 | `wiresOf` reads KINDS unguarded | 7 tests |
| M17 to M23 | `?.` removed at `listIn`, `freshOf`, `addStepAt`, `bodyStart`, `nestPlace`, `setCond`, `stackEnd` | one or more tests each |
| M24 | `?.` removed in `arrows.ts` | the `then` arrow test |
| M25 | `editorState` `in KINDS` check removed | 3 tests |
| M27 | BlocksPane aria-label with the raw kind | visible-safe test (survived first; I added the aria-label assertion) |
| M28 | unreadable view throws out of the builder | unreadable-view test |

Survivors, and why:
- M26 (`BlocksPane` `sub` token reads `KINDS[s.kind]!`): equivalent. The `sub` token is only reached from a known kind's `line`; the unknown face has none.
- `editorState.ts` `KINDS[kind]?.group` and `Palette.tsx` x3 `KINDS[k]?.`: equivalent after the guard before them (`raw.kind in KINDS`; the palette's `k` comes from `Object.keys(KINDS)`). Kept as the plan asks.
- **Not covered by any test** (inside components, no DOM test harness in the app project): `Workspace.tsx:280` and `:400` `?.`, `TextTab.tsx:350` `?.`, and the `App.tsx` fetch and the `kindsReady` gate. A mutation there would survive. The `?.` ones are one token each; the gate is the load-order fix described above.

## Plan notes and open points

- The plan said core exports the views and that `views.test.ts` / `canvasKinds.test.ts` are edited; neither was true (see the top).
- Plan's list missed `BlockPanel.tsx` (top) and `rows.tsx`/`panelEdit.ts`/`runState.ts`/`feed.ts`/`FeedView.tsx` already read safely (`Object.values`, `?.`).
- View order on the wire is the views' own `order` (palette order: phase, say, run, gate, repeat, if, verify, recall, store, model, subagent, end, use), not the node registry order in section 2 (`use` 80 there, 130 in its view). I kept what the app sorts by today.
- The server still checks only that `view.fresh` is an object (`kinds.ts`); `sub` (string) and `rows` shape are not validated for a mod's manifest view (noted in the 17a report too). The app's template filler is safe on any value, so this is not a hole, but a mod `rows` entry with a wrong `className` would be passed to the DOM as a class name. Worth a check in `kinds.ts` `viewProblems`.
- `generation`, conditions, cards and the eight question cards are not in the reply (Task 18).
- Mod view data is served for a block mod even when disabled? The registry holds it only while the mod is loaded or previewed, so a removed or disabled mod's view is not there; I did not test that case.
