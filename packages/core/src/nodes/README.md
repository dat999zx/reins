# Adding a block

A block is a kind of step in a workflow, like `run` or `gate`. There are two ways to add one.

- **As a mod.** No core file. The node is code in the mod's `main` file, and the view is JSON in its `mod.json`. The mod guide is `packages/server/src/mods/README.md`, under "Block, condition and card mods".
- **Built in.** Two files in this folder, and two lines in other files. This guide covers that way. A mod block gives core the same `NodeType`, so the fields below apply to both.

## The built-in files

- `<kind>.ts` is the core half: how the block is read, checked, compiled and run. It default-exports a `NodeType`.
- `<kind>.view.ts` is the app half: how the block looks and edits. It default-exports one object, `satisfies KindView`. It is plain data (see "The view" below).

Then two more lines:

- `index.ts`: one import, and one entry in the list that `register` loops over (the line that starts `for (const [n, order] of [[phase, 10], [say, 20], ...`). The number is the block's place in core's registry.
- `../views.ts`: one import of the view file, and one entry in `BUILTIN_VIEWS`. The server serves this list at `GET /api/kinds`, and the app builds its block list from that.

The test `nodes-registry.test.ts` treats every `.ts` file here as a kind, except `index.ts`, `turn.ts`, `fields.ts` and the `*.view.ts` files. Put a helper in one of those, or outside this folder.

## A minimal example

`packages/core/test/fixtures/beep.ts` is a whole working block. A step like this

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

The `declare module` blocks teach the types about the new kind, the new instruction and the new event.

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
| `tag` | How a chat tag builds a step: `place` (`after` or `wrap`), `arg`, `argRequired`, `lines`. |

## Order

Built-in blocks use these numbers: phase 10, say 20, run 30, gate 40, repeat 50, if 60, verify 70, use 80, recall 90, store 100, model 110, subagent 120, end 130. The number is the block's place in core's registry. A mod block's place is its manifest's `order`.

The palette order comes from the view's `order`, and it is not always the same number. `use` is 80 in core's registry and 130 in its view.

## Ops and VmCtx

`ops` maps an instruction name (`BEEP`) to what the run does with it. The run calls `exec(instr, vm)`. Here `vm` is a `VmCtx`, the run seen from inside the op. Two rules matter.

- Almost every member is live. `vm.program`, `vm.running()`, `vm.next()` and `vm.goto()` read or move the run's own state right now. A user can edit the workflow while your op waits, so the program you read after an `await` may not be the one you read before.
- Only `vm.at` is a copy. It is the counter when the op started. After a long `await`, do not use `vm.at + 1` to move on. Call `vm.next()`, which moves the live counter.

Always check `vm.running()` after every `await`. The user may have pressed Stop while you waited. If it is false, return and touch nothing:

```ts
const passed = await vm.judge(i.cond);
if (!vm.running()) return;
```

The built-in recall, store, verify and run ops deliberately skip the check after some awaits (the session open, the store write, the recall, a run command with no repeat). Tests pin them as they were before M1. A new op should check after every await, and must not copy those.

`vm.pause(reason)` pauses the run and logs nothing. If the pause should show in the log, the op sets the pause first and then logs its own event. The CLI saves a snapshot inside the event handler, and that snapshot must already say `paused`.

An op that can jump can say where, with `next: (i, at) => [at + 1, i.target]`, so the checker knows what is reachable. An op that runs a shell command lists it with `commands: (i) => [i.cmd]`, so the user is asked to trust it.

## Blocks with their own session

A kind can also define `exec(step, ctx)` instead of ops. Its `compile` pushes a `NODE` instruction, and the run calls `exec` with an `ExecCtx` (switch model, slice, pause, stop, subagent). It returns `'next'` to move on or `'stay'` when the run paused or stopped. `model` and `subagent` do this; `model.ts` is the small example.

## Several next links (`manyNext`)

A block that takes several `next` links sets `manyNext: true`. Its face then has the grey `next` handle, and each drag adds a wire. Core does not compile those links into a JUMP. The block's `compile` links them itself, with `ctx.linkTo`. The one-`next` rule skips such a block. `on-fail` stays one link.

## Tracks: `starts` and the region rules

An op that starts tracks lists the instructions where they begin, with `starts(instr)`. Its `next(instr, at)` lists them too, so the reach walk sees the whole reach.

Each start begins a region: the steps it reaches without starting another track. The checker (`validate.ts`) gives an error when:

- a branch can be reached from the main line. Put the branch behind an end, and let nothing else lead into it;
- a region leads back into the main line;
- a step is in two regions. Put an end under each branch.

Only steps count in a region. A block that compiles to a bare END is not one. The `validate.program` checks run only when there is no error.

The only op that uses `starts` today is the test fixture `split` (`packages/core/test/fixtures/split.ts`). No shipped block starts tracks.

## count and print

`count` and `print` are tables keyed by event type, like `beeped`.

- `count` feeds the receipt. Return a name, here `'beeps'`, and the receipt counts one for each event. The receipt then shows `beeps 1`, in the app and as the last line before `run id` in the terminal. Return `undefined` to skip an event. A run with no counted event has no counts at all.
- `print` is the terminal line of `reins run`. Return the text to print for the event (here `  beeped x2`). Return `undefined` to keep the default.

## The view

A view is plain JSON. It holds no function. The keys are these.

- `kind`, `order`, `colour` (`soft`, `hard`, `gate`, `loop`, `verify`, `hand`, `mem` or `mine`), `icon` (`round`), `slice`, `group`, `fails`, `manyNext`, `stops`, `against` and `cards`: how the face looks and behaves.
- `fields`: the editable lines.
- `line`: what the face shows. A word prints as it is, and `{ field: 'times' }` prints the value.
- `card`: the palette card's `label` and `section` (`Flow` or `Memory`).
- `sub`: a template for the small text on the face.
- `fresh`: the fields of a new block, as plain data. It is copied each time a block is made.
- `rows`: feed rows by event type. Each has `text` (a template), and optionally `details` and `className` (`sx-sub` or `faint`).

A field is one editable line on the block. Its `key` is the attribute name (`times`). Two optional words help:

- `check` says what a good value is. `'count'` is a whole number of 1 or more, so `applyField(step, 'times', 'x')` says no and `'3'` says yes. `'usd'` is an amount above 0, and empty means none.
- `unset` is the value that means "not set". The panel shows it when the attribute is empty, and typing it clears the attribute, so it is left out of the file. For example, `mode` has `unset: 'write'`, because write is the default.

The same key must carry the same `check` and `unset` in every view. `views.test.ts` checks that.

`order` puts the block in the palette. Built-in views use the numbers in "Order" above.

The server checks a mod's view for `kind`, `order`, `fields`, `line`, `fresh` and hidden characters. The mod guide has the template syntax for `sub` and `rows`.

## The import rule

A view file imports only types, and the field helpers from `./fields.js`.

## What stays core, and is not a block

Some instructions belong to the run itself, not to any block:

- `TURN`, `JUMP`, `END` and `NODE`, the four core instructions. `register` refuses an op with one of these names.
- The pause types, such as `stop` and `budget-used`.
- The gate answers, approve and request changes.
- The budget questions ("Allow more").

Several blocks share these, so no block owns them.

## Checklist

- A built-in block: 2 files (`<kind>.ts`, `<kind>.view.ts`) and 2 lines (`index.ts`, and `views.ts` for the view). Tests: copy `packages/core/test/fixtures/beep.ts`.
- A mod block: no core file. A folder with `mod.json` and `index.js`, or `mod.json` alone for a data block. See the mod guide.
