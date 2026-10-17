# Adding a block

A block is a kind of step in a workflow, like `run` or `gate`. Adding one takes two files and one line in `index.ts` (one import and one entry in the list).

## The two files

- `<kind>.ts` is the core half: how the block is read, checked, compiled and run.
- `<kind>.view.ts` is the app half: how the block looks and edits on the canvas and in the panel.

Then change `index.ts` in two places: put one import at the top and one entry in the list that `register(...)` loops over (the line that starts `for (const n of [phase, say, ...`). Nothing else changes. The view file needs no line: the app finds every `*.view.ts` in this folder by itself.

## A minimal example

`packages/core/test/fixtures/beep.ts` is a whole working block. Here it is, shortened. A step like this

```
## beep
times: 2
```

beeps twice. The core file, `beep.ts`:

```ts
import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { beep: true }
}
declare module '../compile.js' {
  interface Instrs { BEEP: { step: string; times: number } }
}
declare module '../run.js' {
  interface RunEvents { beeped: { step: string; times: number } }
}

const beep: NodeType = {
  kind: 'beep',
  attrs: ['times'], // the lines the parser accepts in the block body
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
export default beep;
```

The three `declare module` blocks teach the types about the new kind, the new instruction and the new event. The view file, `beep.view.ts`:

```ts
import type { KindView } from './fields.js';

export default {
  kind: 'beep', order: 140, colour: 'soft',
  fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }],
  line: ['beep', { field: 'times' }],
  card: { label: 'beep', section: 'Flow' }, fresh: () => ({ attrs: { times: '1' } }),
  rows: { beeped: (d) => ({ text: `beeped x${d.times}`, className: 'sx-sub' }) },
} satisfies KindView;
```

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

## Blocks with their own session

A kind can also define `exec(step, ctx)` instead of ops. Its `compile` pushes a `NODE` instruction, and the run calls `exec` with an `ExecCtx` (switch model, slice, pause, stop, subagent). It returns `'next'` to move on or `'stay'` when the run paused or stopped. `model` and `subagent` do this; `model.ts` is the small example.

An op that can jump can say where, with `next: (i, at) => [at + 1, i.target]`, so the checker knows what is reachable. An op that runs a shell command lists it with `commands: (i) => [i.cmd]`, so the user is asked to trust it.

## count and print

`count` and `print` are tables keyed by event type, like `beeped`.

- `count` feeds the receipt. Return a name, here `'beeps'`, and the receipt counts one for each event. The receipt then shows `beeps 1`, in the app and as the last line before `run id` in the terminal. Return `undefined` to skip an event. A run with no counted event has no counts at all.
- `print` is the terminal line of `reins run`. Return the text to print for the event (here `  beeped x2`). Return `undefined` to keep the default.

## The view and its fields

A field is one editable line on the block. Its `key` is the attribute name (`times`). Two optional words help:

- `check` says what a good value is. `'count'` is a whole number of 1 or more, so `applyField(step, 'times', 'x')` says no and `'3'` says yes. `'usd'` is an amount above 0, and empty means none.
- `unset` is the value that means "not set". The panel shows it when the attribute is empty, and typing it clears the attribute, so it is left out of the file. For example, `mode` has `unset: 'write'`, because write is the default.

The same key must carry the same `check` and `unset` in every view. A test checks that.

`line` is what the block face shows: a word prints as it is, `{ field: 'times' }` prints the value. `rows` draws the block's events in the feed. `order` puts the block in the palette; built-in blocks use 10 to 130, so a first-party block's `order` goes after 130.

## The import rule

A view file imports types only (`import type`), or a field helper from `./fields.js`. It never imports runtime code from core. The browser build loads every view, and one runtime import would pull the whole of core into it. A test reads the view files and fails on any other import.

## What stays core, and is not a block

Some instructions belong to the run itself, not to any block:

- `TURN`, `JUMP`, `END` and `NODE`, the four core instructions. `register` refuses an op with one of these names.
- The pause types, such as `stop` and `budget-used`.
- The gate answers, approve and request changes.
- The budget questions ("Allow more").

Several blocks share these, so no block owns them.

## Checklist

- files you add: 2
- places you change elsewhere: 1 file, `index.ts` (an import and a list entry)
- tests: copy `packages/core/test/fixtures/beep.ts`
