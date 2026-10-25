# M2 Task 19: data blocks

Base: 4a17220 (Task 16c), branch feat/fork-playbook. Not committed, added, stashed, reset, checked out or pushed. Task 17a WIP from another session is in the tree; it is not mine (see the core index note below).

## git status --short (my paths)

```
 M packages/core/src/index.ts        (one line is mine; two lines are 17a WIP: ./views.js and the fields type export)
 M packages/server/src/mods/kinds.ts
 M packages/server/src/mods/loader.ts
 M packages/server/src/mods/types.ts
?? packages/core/src/nodes/data-block.ts
?? packages/core/test/data-block.test.ts
?? packages/server/test/toy-ask.test.ts
?? packages/server/test/fixtures/mods/toy-ask/
```

`git diff --stat` (my files only): kinds.ts 62 lines changed, loader.ts +2, types.ts +6, core index +1 (mine). `actions.ts` and the import summary are untouched (Task 20).

Line endings: every file I touched or created is CRLF (counted with node: LF count equals CRLF count, bare LF 0). No U+2014 in any of them.

## What I built

- `packages/core/src/nodes/data-block.ts`: `dataBlock({ kind, attrs, turn, statusLine })` returns a NodeType like `say`: attrs from the manifest, `validate.early: checkMode`, and `compile` pushing ONE `turnInstr({ ...step, prompt: fillTurn(turn, step.attrs) })`. No ops, no exec, no heading. `fillTurn` is the filler; `turnNames` lists the names a template uses. Both are exported from core's index.
- `packages/server/src/mods/kinds.ts`:
  - `main` is no longer checked by the shared helper. Condition and card keep "needs code" through `codeProblems`, with the same words as before.
  - Block: `shapeProblems` (exactly one of `main` or `turn`), then for a data block `dataProblems` (one kind; no ops; no `policy`, `mode`, `allowShell` or `tools` key in the manifest; `turn` is text, at most 4 KB, no hidden character except a line break, and every placeholder names a listed attr; `statusLine` one line of at most 200 characters with no hidden character). Then `viewProblems` as before.
  - Block `data(raw)` builds the node with `dataBlock` and returns `(api) => api.registerBlock(node)`.
- `packages/server/src/mods/types.ts`: `Manifest.turn?`, `Manifest.statusLine?`, and `ModKind.data?` (the one new hook).
- `packages/server/src/mods/loader.ts` (2 lines): a mod with no code takes its activation from `kind.data?.(raw)`. That runs through the same `buildApi`, so `registerBlock` gets the same copy, the same `provides` check, the same mod mark and core's `guardNode`. A startOnly mod's core registrations go to `own`, so carry and dispose work as they do for code blocks.
- `packages/core/src/index.ts`: one export line.
- Fixture `packages/server/test/fixtures/mods/toy-ask/mod.json` (no `index.js`). Tests write it into a `tempHome` at run time.

## Decisions where the brief left room (please confirm or redirect)

1. **A line break is allowed in `turn`.** The brief says "no hidden characters", but `hasHiddenChars` counts LF, so a literal reading refuses every multi-line prompt. Only LF is allowed; every other hidden character is refused. To tighten, delete `.replaceAll('\n', '')` in `dataProblems`.
2. **`statusLine` is an optional manifest field** (one line, at most 200 characters, no hidden character), passed to `NodeType.statusLine`. I read "with an optional status line" this way.
3. **The step's own prompt lines are not sent.** The template is the prompt. A test pins this.
4. **One kind per data block.** `provides.kinds` must have exactly one entry; two is refused, not silently cut to `kinds[0]`.
5. **`{constructor}` and `{__proto__.x}`.** The filler fills them empty (core test). In a manifest they are refused earlier, by the attr rule: they are not listed attrs, and `__proto__` cannot be an attr name under the NAME rule. So the empty fill is only seen where the filler runs on a step's attributes.
6. **Trust.** A data block has no code: nothing is hashed, copied or trust-checked, and it loads with no trust (a test loads it with trust answered no). It is still fully validated before anything registers. `mod.trusted` stays `false` for a user data block, as for a user provider with no code. Task 20 may want to change how Settings shows it.
7. **Carry.** A data block's core registration goes in `own`, like a code block's. A test reloads with `startMods`: same node, one key, and a changed template says "applies after a restart" and keeps the old prompt.
8. **The `data` hook is a new `ModKind` member.** The plan named the `registerBlock` door, not how a code-less mod reaches it; this is the smallest route.

## The toy-block pin (not edited)

`packages/server/test/toy-block.test.ts:271` expects the substring "`bad`: a block mod needs code (`main`)." for a manifest with neither `main` nor `turn`. The new message is "`bad`: a block mod needs code (`main`). A block with no code needs a `turn` instead.", which contains that text, so the pin stays green unchanged. The brief said to stop if a pin had to change; it did not.

## Tests

Red at HEAD (before any implementation):
- `packages/core/test/data-block.test.ts`: the file failed to load (the module did not exist), so 0 tests ran.
- `packages/server/test/toy-ask.test.ts`: 19 of 20 failed at HEAD. The 20th (the untrusted copy) passed for the wrong reason: HEAD refuses it with "needs code". I then made that test name the placeholder, so it is red at HEAD now too. I did not re-run HEAD after that change.
- Added later, not run at HEAD: the carry test (reload) and the condition/card words test. The words test is green at HEAD on purpose: it pins the unchanged words.

Green now:
- `packages/core/test/data-block.test.ts`: 15 tests.
- `packages/server/test/toy-ask.test.ts`: 22 tests. Covers: loads with no code and no trust; parse, print back, validate, one TURN `['TURN', 'END']` with the filled prompt; write by default, read-only with `mode: read-only`; a manifest setting `policy`, `mode`, `allowShell` or `tools` is refused with words; both `main` and `turn` refused; neither refused; `ops` refused; more than one kind refused; placeholders naming an unlisted attr refused (`{colour}`, `{constructor}`, `{topic|colour}`, `{}`); a hidden character refused; a 5 KB template refused; a status line with a hidden character or over 200 characters refused; a multi-line template kept; a fake-engine run where the model receives "Answer about dogs in one line. Mode: read-only."; an untrusted copy still validated; dispose leaves nothing; shadowing `say` refused; reload carry; condition and card still need code, with the same words.
- Final run of my two files plus the pins: `toy-ask`, `data-block`, `toy-block` (46), `toy-block-hostile` (16c), `mods-loader` (16a): 5 files, 192 tests, all passed.
- Guards: `no-kind-branch`, `no-emdash`, `no-provider-name`: 6 passed.

Commands: `D:\nodejs\node.exe node_modules/vitest/vitest.mjs run <files> --maxWorkers=1`, foreground, one at a time.

Other gate items:
- `npm run typecheck`: exit 0 (root and app).
- `npm run lint`: exit 1, 4 errors, none in my files: `packages/app/src/canvasKinds.ts:20:7` (`isObj` unused), `:23:43` (`v` unused), `packages/app/test/tracksView.test.ts:37:7` (`idx` unused), `:159:31` (control character in a regex). These are in the app and look like the 17a WIP.
- Not run: build, `npm test`, the rest of the server and app suites (per the parallel rules).

## Mutation round

Hand-applied breaks, one at a time. A throwaway Node script read the break from stdin (nothing written to disk), replaced one unique string, ran my two test files plus the toy-block pins, wrote the original bytes back, and compared SHA-256 before and after. `restored true` for all 26.

| # | Break | First red test (file) |
|---|---|---|
| M01 | own-property check dropped (`attrs[name]`) | core: fills only own string properties |
| M02 | non-string value filled (`v !== undefined`) | core: an own value that is not text fills empty. **Survived the first round**: no test had an own non-string value. Added that test; red now |
| M03 | empty value counts as filled | core: `{a|b}` takes the first alternative |
| M04 | only the first alternative read | core: `{a|b}` (4 red, incl. compile) |
| M05 | value not run through `tame` | core: a hidden character is shown |
| M06 | value not capped | core: a value is cut to 1000 characters |
| M07 | whole prompt not capped | core: the whole prompt is cut to 16 KB |
| M08 | compile sends the step, not the filled prompt | core: compiles to exactly one TURN (6 red) |
| M09 | policy forced to read-only in the node | core compile test; toy-ask: parses and compiles |
| M10 | statusLine dropped | core: no ops, exec or heading; status line is the manifest's |
| M11 | `checkMode` dropped from the node | core: a bad `mode` on the step is an error |
| M12 | alternatives not split in `turnNames` | core: turnNames; toy-ask: loads |
| M13 | `main` and `turn` both allowed | toy-ask: refuses a block with both |
| M14 | neither allowed | toy-ask: neither; toy-block "no code" pin (expected: the check is gone) |
| M15 | `ops` allowed | toy-ask: refuses `ops` |
| M16 | only `policy` in the policy-key list | toy-ask: sets `mode`, sets `allowShell` |
| M17 | unlisted placeholder allowed | toy-ask: unlisted placeholder; untrusted copy |
| M18 | a line break refused in the template | toy-ask: a multi-line template keeps its breaks |
| M19 | hidden characters in the template not checked | toy-ask: hidden character in the template |
| M20 | 4 KB size not checked | toy-ask: more than 4 KB |
| M21 | more than one kind allowed | toy-ask: more than one kind |
| M22 | hidden characters in `statusLine` not checked | toy-ask: status line with a hidden character |
| M23 | condition or card without code allowed | toy-ask: condition or card still need code |
| M24 | loader never registers the data block | toy-ask: loads with no code (7 red) |
| M25 | data block validated as a code block | toy-ask: sets `policy`; untrusted copy (11 red) |
| M26 | data block's registration not in `own` (not carried) | toy-ask: reload carry; toy-block carry (9 red) |

## Plan notes and open points

- `actions.ts` and the import summary are untouched, as the brief asks. A data block has `hasCode: false`, so the summary has no code prompt for it; Task 20 adds the line.
- A user data block shows `trusted: false` (see decision 6).
- Not tested: a heading argument (`## ask something`); I did not check how the parser treats it, because `ask` has no heading.
- Not tested: a data block whose `order` changes across a reload (the carry test covers the template only).
- The brief's list said `heading`. A data block has no heading, the same as `say`; `## ask` parses with the default.

## Existing tests edited

None. The pins I ran unedited: `toy-block.test.ts` (46), `toy-block-hostile.test.ts` (16c), `mods-loader.test.ts` (16a), and the three guards.
