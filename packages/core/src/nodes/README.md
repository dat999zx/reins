# Adding a block

A block is a kind of step in a playbook, like `run` or `gate`. **A block is a mod.** The default pack is the only source of kinds: core registers none. The 14 blocks you see in the palette (`phase`, `say`, `run`, `gate`, `repeat`, `if`, `verify`, `recall`, `store`, `model`, `subagent`, `end`, `fork`, `playbook`) are mod folders in `packages/server/src/mods/<id>/`, each with a `mod.json` that says `"pack": "default"`, and the loader registers them when the server starts. A block of yours is the same thing, in `<home>/mods/<id>/`.

- Walkthrough with a block you can run: `packages/server/src/mods/PACK.md`, "Write a block".
- The manifest, `provides`, `api`, trust and what is contained: `packages/server/src/mods/README.md`, "Block, condition and card mods".
- This file: the `NodeType` a block hands to `api.registerBlock`, what an op can do with the run, and the `KindView` data in a block's `mod.json`.

## What still lives in core

`packages/core/src/nodes/`, `conds/` and `cards/` hold the registries and the pieces every block shares, and nothing else. Six files, and `packages/core/test/no-kind-branch.test.ts` fails when there is any other:

| File | What it is | Why it stays |
|---|---|---|
| `nodes/index.ts` | The `NodeType`, `OpType` and `VmCtx` types, and the registry (`register`, `NODES`, `opOf`, `defaultId`, `nodeAttrs`, `headingOwns`). The registry starts empty. | The loader and the tests need one place to register into. |
| `nodes/fields.ts` | The `KindView` and `Field` types, and a few field helpers. | A view is data, and the app and the server check it by this one shape. |
| `nodes/turn.ts` | `checkMode`, `policyOf`, `turnInstr`. | Every block that sends a turn needs them. A mod gets them through `api.core`. |
| `nodes/README.md` | This guide. | |
| `conds/index.ts` | The condition registry (`CONDS`, `registerCondition`). It starts empty. | The parser needs it; the 11 conditions are `cond-*` mods. |
| `cards/index.ts` | The card registry (`CARDS`, `registerCard`). It starts empty. | The 3 cards are `card-*` mods. |

Nothing in core, in the server outside a pack mod's folder, or in the app may look a block, a condition, a card, one of their instructions or one of their events up by name: `no-kind-branch.test.ts` builds the list of names from the pack manifests and scans for them. The forms that look a block up (`step.kind === 'x'`, `['x'].includes(step.kind)`, `NODES.get('x')`, `KINDS.x`, `c.t === 'x'`, `case 'OP'`) fail anywhere, and no list excuses them. Some names are also plain words (`end`, `run`, `model`, `now`, `stop`, `done`, `gate` and a few more), so those uses are allowed one line at a time: `packages/core/test/no-kind-branch.allow.json` holds the exact text of each allowed line, per word and file, with a reason per word. A new line with such a word fails until you either use another word or add the line there; a line you change must be changed there too. A new block never needs an edit in core.

Core's tests get the pack from `packages/core/test/setup-pack.ts` and `pack.ts` (they activate each pack mod with a test `api`, at the `order` its manifest gives). The server's tests use `usePack()` (`packages/server/test/pack-helper.ts`) and the app's use `packages/app/test/setup-kinds.ts`. A test that needs a toy kind registers it straight with `register`: `packages/core/test/fixtures/beep.ts` and `split.ts` are two.

## A minimal example

`packages/core/test/fixtures/beep.ts` is a whole working block for a core test. A step like this

```
## beep
times: 2
```

beeps twice. The file is:

```ts
// The toy block of the guide (packages/core/src/nodes/README.md): a `beep` kind in one file, core half and view.
// Every import is `import type`, so the view needs no runtime import; the app test and the server test both load this file.
import type { NodeType } from '../../src/nodes/index.js';
import type { KindView } from '../../src/nodes/fields.js';

declare module '../../src/model.js' {
  interface NodeKinds { beep: true }
}
declare module '../../src/compile.js' {
  interface Instrs { BEEP: { step: string; times: number } }
}
declare module '../../src/run.js' {
  interface RunEvents { beeped: { step: string; times: number } }
}

// The core half: parse a `times:` line, compile it to a BEEP instruction, run it, count it, print it.
export const beep: NodeType = {
  kind: 'beep',
  attrs: ['times'],
  compile(step, ctx) { ctx.push({ op: 'BEEP', step: step.id, times: parseInt(step.attrs.times || '1', 10) }); },
  ops: {
    BEEP: {
      async exec(i, vm) {
        vm.log('beeped', { step: i.step, times: i.times });
        vm.next();
      },
    },
  },
  count: { beeped: () => 'beeps' },
  print: { beeped: (d) => `  beeped x${d.times}` },
};

// The view half: how the block looks and edits in the app.
export const beepView = {
  kind: 'beep', order: 140, colour: 'soft',
  fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }],
  line: ['beep', { field: 'times' }],
  card: { label: 'beep', section: 'Flow' }, fresh: { attrs: { times: '1' } },
  rows: { beeped: { text: 'beeped x{times}', className: 'sx-sub' } },
} satisfies KindView;
```

The `declare module` blocks teach the types about the new kind, the new instruction and the new event. In a mod the core half is the object you pass to `api.registerBlock` (in `index.js`, with no types), and the view half is the `view` object in `mod.json`. The pack mods put the `declare module '@reins/core'` lines in their `index.ts`: see `packages/server/src/mods/fork/index.ts`.

## The NodeType fields

| Field | What it does |
|---|---|
| `kind` | The kind's name. A step `## <kind>` is one of these. |
| `attrs` | The lines the block body accepts, such as `times`. |
| `mod` | Set by the loader for a mod block. Do not set it yourself. |
| `container` | `kids` or `kids+else`: the block holds nested steps. |
| `fails` | True when the step can fail, so an `on-fail` link can fire. |
| `manyNext` | True when the block takes several `next` links and compiles them itself. See below. |
| `sendsTurn` | True when `exec` runs a turn built from the step's own prompt, so a preview can show it. |
| `heading` | `parse`, `print` and `owns`: the text after `## <kind>`. |
| `defaultId(step)` | The id a new step of this kind gets. Undefined gives `<kind>-<n>`. |
| `validate` | `early`, `late`, `links` and `program` checks. `program` runs last, and only when there is no error. |
| `compile(step, ctx)` | Pushes the instructions. `ctx.linkTo` and `ctx.linkLater` link to other steps. |
| `ops` | The instructions this kind compiles to, by name. See "Ops and VmCtx". |
| `exec(step, ctx)` | For a block with its own session, in place of `ops`. See "Blocks with their own session". |
| `count`, `print` | The receipt name and the `reins run` line, by event type. |
| `defaultPrompt(step)` | The prompt a new step starts with. |
| `statusLine` | The status line of the block's replies. |
| `chatTurn` | True on the one kind a chat message is wrapped in (`phase`). Only the default pack, or a Customize copy of one of its blocks, may claim it. |
| `tag` | How a chat tag builds a step: `place` (`after` or `wrap`), `arg`, `argRequired`, `lines`. |

## Order

The `order` in a mod's manifest is the block's place in core's registry. The blocks of the default pack use these numbers, and the view's own `order` (the palette order) differs for six of them:

| Block | `order` (registry) | view `order` (palette) |
|---|---|---|
| phase | 10 | 10 |
| say | 20 | 20 |
| run | 30 | 30 |
| gate | 40 | 40 |
| repeat | 50 | 50 |
| if | 60 | 60 |
| verify | 70 | 70 |
| recall | 90 | 80 |
| store | 100 | 90 |
| model | 110 | 100 |
| subagent | 120 | 110 |
| end | 130 | 120 |
| fork | 135 | 135 |
| playbook | 140 | 150 |

A new block picks a free number above 150 in both places (the guide's `ping` uses 200). Conditions use 10 to 110, in their own manifests.

## Ops and VmCtx

`ops` maps an instruction name (`BEEP`) to what the run does with it. The run calls `exec(instr, vm)`. Here `vm` is a `VmCtx`, the run seen from inside the op. Two rules matter.

- Almost every member is live. `vm.program`, `vm.running()`, `vm.next()` and `vm.goto()` read or move the run's own state right now. A user can edit the playbook while your op waits, so the program you read after an `await` may not be the one you read before.
- Only `vm.at` is a copy. It is the counter when the op started. After a long `await`, do not use `vm.at + 1` to move on. Call `vm.next()`, which moves the live counter.

Always check `vm.running()` after every `await`. The user may have pressed Stop while you waited. If it is false, return and touch nothing:

```ts
const passed = await vm.judge(i.cond);
if (!vm.running()) return;
```

The pack's recall, store, verify and run ops deliberately skip the check after some awaits (the session open, the store write, the recall, a run command with no repeat). Tests pin them as they were before M1. A new op should check after every await, and must not copy those.

`vm.pause(reason)` pauses the run and logs nothing. If the pause should show in the log, the op sets the pause first and then logs its own event. The CLI saves a snapshot inside the event handler, and that snapshot must already say `paused`.

An op that can jump can say where, with `next: (i, at) => [at + 1, i.target]`, so the checker knows what is reachable. An op that runs a shell command lists it with `commands: (i) => [i.cmd]`, so the user is asked to trust it.

`vm.outputs` (what each step answered, by step id), `vm.lastReply()`, `vm.handBack(text)` (the next turn of this track carries `text`; quote it as data) and `vm.tracks` are the members `fork` and `playbook` use. See "Tracks".

## Blocks with their own session

A kind can also define `exec(step, ctx)` instead of ops. Its `compile` pushes a `NODE` instruction, and the run calls `exec` with an `ExecCtx` (switch model, slice, pause, stop, subagent). It returns `'next'` to move on or `'stay'` when the run paused or stopped. `model` and `subagent` do this; `packages/server/src/mods/model/index.ts` is the small example.

## Several next links (`manyNext`)

A block that takes several `next` links sets `manyNext: true`. Its face then has the grey `next` handle, and each drag adds a wire. Core does not compile those links into a JUMP. The block's `compile` links them itself, with `ctx.linkTo`. The one-`next` rule skips such a block. `on-fail` stays one link. The only pack block that does this is `fork`; the `next` handle is drawn only on a block whose view says `manyNext`, so a plain block has none (a file with a `next:` line on a plain block still loads and runs).

## Tracks: `starts` and the region rules

An op that starts tracks lists the instructions where they begin, with `starts(instr)`. Its `next(instr, at)` lists them too, so the reach walk sees the whole reach. At run time the op calls `vm.tracks.start(group, [{ key, at, title, ... }])`, which parks the main line on the instruction; when every track of the group has ended, the op runs again, and `vm.tracks.take(group)` returns their results. A `TrackSpec` can carry a `seed` (texts the track's first turn carries), a `usd` (a budget of its own) and `share: true` (an equal part of the room).

Each start begins a region: the steps it reaches without starting another track. The checker (`validate.ts`) gives an error when:

- a branch can be reached from the main line. Put the branch behind an end, and let nothing else lead into it;
- a region leads back into the main line;
- a step is in two regions. Put an end under each branch.

Only steps count in a region. A block that compiles to a bare END is not one. The `validate.program` checks run only when there is no error.

Two pack blocks start tracks:

- `fork` (`packages/server/src/mods/fork/index.ts`): one track for each `next:` branch, all at once. The main line waits until every branch ended, then hands their results to the block under the fork.
- `playbook` with `session: own` (`packages/server/src/mods/playbook/index.ts`): one track for the whole playbook file. An inline playbook starts none.

The test fixtures `split` (`packages/core/test/fixtures/split.ts`) and `split-share` are two more, for core tests that need a track and no pack.

## count and print

`count` and `print` are tables keyed by event type, like `beeped`.

- `count` feeds the receipt. Return a name, here `'beeps'`, and the receipt counts one for each event. The receipt then shows `beeps 1`, in the app and as the last line before `run id` in the terminal. Return `undefined` to skip an event. A run with no counted event has no counts at all. The receipt also has fixed fields; a name that is one of `gatesHeld`, `loopAttempts`, `verifyResults.passed`, `verifyResults.failed`, `knowlRecalls`, `knowlStores`, `knowlSkipped` adds one to that field instead of going to `counts`.
- `print` is the terminal line of `reins run`. Return the text to print for the event (here `  beeped x2`). Return `undefined` to keep the default.

## The view

A view is plain JSON. It holds no function. In a mod it is the `view` object of `mod.json`. The keys are these.

- `kind`, `order`, `colour` (`soft`, `hard`, `gate`, `loop`, `verify`, `hand`, `mem` or `mine`), `icon` (`round`), `slice`, `group`, `fails`, `manyNext`, `stops`, `against` and `cards`: how the face looks and behaves.
- `coreRows`: a list of events that core itself logs (`subagent_started`, `refusal`, `run_paused`, ...) whose feed row this view draws. A view may cover such an event in `rows` only if it lists the event here; any other event is free. Only a block of the default pack may use `coreRows` (and `stops`). A mod that takes the place of a built-in, which is what a Customize copy is, may list only the events the built-in lists (fewer is fine) and may say `stops` only if the built-in does; a mod with an id of its own that has either key is refused. The shipped use is `subagent`: `"coreRows": ["subagent_started", "subagent_result"]`.
- `fields`: the editable lines.
- `line`: what the face shows. A word prints as it is, and `{ field: 'times' }` prints the value.
- `card`: the palette card's `label` and `section` (`Flow` or `Memory`).
- `sub`: a template for the small text on the face.
- `fresh`: the fields of a new block, as plain data. It is copied each time a block is made.
- `rows`: feed rows by event type. Each has `text` (a template), and optionally `details` and `className` (`sx-sub` or `faint`).
- `status` and `hidden`: what an event of the block does to the run's marks, and which events draw no row (see the mod guide).

A field is one editable line on the block. Its `key` is the attribute name (`times`). Two optional words help:

- `check` says what a good value is. `'count'` is a whole number of 1 or more, so `applyField(step, 'times', 'x')` (in `packages/app/src/panelEdit.ts`) says no and `'3'` says yes. `'usd'` is an amount above 0, and empty means none.
- `unset` is the value that means "not set". The panel shows it when the attribute is empty, and typing it clears the attribute, so it is left out of the file. For example, `mode` has `unset: 'write'`, because write is the default.

The same key must carry the same `check` and `unset` in every view. `packages/app/test/views.test.ts` checks that for the pack.

The server checks a mod's view for `kind`, `order`, `fields`, `line`, `fresh` and hidden characters. The mod guide has the template syntax for `sub` and `rows`. The app builds its block list from `GET /api/kinds`, which the server fills from the manifests.

## What stays core, and is not a block

Some instructions belong to the run itself, not to any block:

- `TURN`, `JUMP`, `END` and `NODE`, the four core instructions. `register` refuses an op with one of these names.
- The pause types, such as `stop` and `budget-used`.
- The gate answers, approve and request changes.
- The budget questions ("Allow more").

Several blocks share these, so no block owns them.

## Checklist

- A new block: a folder `<home>/mods/<id>/` with a `mod.json` (`kind: "block"`, `provides`, `order`, `view`) and an `index.js` that calls `api.registerBlock(node)`. No core file, no server file, no app file. List everything the code registers in `provides`. Walkthrough: `packages/server/src/mods/PACK.md`.
- A block with no code: `mod.json` alone, with a `turn` template (a data block). See the mod guide.
- A block for the default pack itself (a change to Reins, not a user mod): the same folder in `packages/server/src/mods/<id>/`, with `"pack": "default"`, an `index.ts` and its `declare module '@reins/core'` lines. The guard test, the palette and the served list read the manifest, so nothing else needs the name. The tests that list the pack's kinds by name (for example `packages/core/test/kind-order.test.ts`) need the new one.
- Tests for a core-only toy kind: copy `packages/core/test/fixtures/beep.ts` and `register` it in the test.
