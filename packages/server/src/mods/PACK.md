# The default pack, and how to write a block, a condition, a card, a playbook

This guide is for people who want to remove a built-in block, change one, or write their own. The general rules of mods (the manifest, `provides`, trust, what is contained) are in `README.md` next to this file, under "Block, condition and card mods". Read that first; this guide does not repeat it.

Every example below was run: `packages/server/test/m3-fix-c-guide-examples.test.ts` installs each one through the import path, and a last test in that file checks that the text in this guide is the text that ran.

## The default pack

Reins core registers no block, no condition and no card. Everything you see in the palette comes from mods that ship with Reins. 28 of them say `"pack": "default"` in their `mod.json`; together they are the **default pack**:

- 14 blocks: `phase`, `say`, `run`, `gate`, `repeat`, `if`, `verify`, `recall`, `store`, `model`, `subagent`, `end`, `fork`, `playbook`.
- 11 conditions, one folder each: `cond-approve`, `cond-attempts`, `cond-cmd`, `cond-diff`, `cond-done`, `cond-drift`, `cond-llm`, `cond-review`, `cond-same`, `cond-tests`, `cond-touches`.
- 3 cards, one folder each: `card-guard`, `card-now`, `card-stop`.

They live in `packages/server/src/mods/<id>/` and ship in the `reins-ai` package as `mods/<id>/`. They are ordinary mods: a `mod.json`, and an `index.js` that calls `activate(api)`. The only difference is two words that a built-in `mod.json` may say and yours may not (Reins refuses a user mod that says either):

- `"pack": "default"` says the mod is part of the pack. Only a pack mod can be customized (below).
- `"required": true` says the mod cannot be switched off. Two mods have it: `phase` and `end`.

### Switch off, remove

- A built-in cannot be removed ("is built in and cannot be removed. You can disable it.").
- **Disable** it on its row in Settings > Providers (under "Protocols and other mods"). The switch is written to `<home>/disabled-mods.json`. A workflow that uses a block, condition or card that is switched off fails its check. Like every change to a kind that is already in use, it applies after a restart; Settings says so.
- A required mod has no off switch: Reins answers "is required: Reins cannot run without it, so it cannot be switched off. You can customize it instead." If `disabled-mods.json` names a required id by hand, Reins ignores the line and says so on the row. `phase` is the step every workflow is built from, and `end` is how a workflow stops; core has no other copy of either.
- To take a block away from the palette, switch off the mod. To change how a block works, Customize it.

### Customize

**Customize** is a button on the row of a pack mod. It opens the import dialog on a copy of the built-in, with the same preview, the same trust question for code and the same "this replaces a built-in" confirm as any import. What it does:

- It copies every file of the built-in's folder into `<home>/mods/<id>/` (the same id), with `pack` and `required` taken out of `mod.json`. The copy is an ordinary user mod: its code asks for trust by hash, a change to any byte asks again, and Export includes it.
- It refuses when you already have a folder `<home>/mods/<id>/` ("You already have your own copy of ..."). Your copy is never replaced. Edit it, or remove it first.
- It takes the built-in's place after a restart. The built-in stays installed underneath: a copy may cover only the names the built-in's own `provides` lists, so a copy of `say` can replace `say` and nothing else.
- Remove the copy (Settings, Remove) and the built-in is back after a restart.
- A copy of `phase` or `end` is required too. Required follows the id, so the copy has no off switch either.

Change the copy's `mod.json` or `index.js` by hand, then restart. Keep the `version` you copied, or raise it.

### "The built-in is newer"

A copy remembers the version it was made from. When a later Reins ships a built-in whose `version` is higher than your copy's `version` (dotted numbers, compared left to right), the row says `the built-in is newer (1.1.0)`. Reins does not merge anything. If you want the new built-in, remove your copy and Customize again; if you want to keep yours, ignore the line.

## Write a block

A block is a kind of step. The model is the smallest block of the pack, `say` (`packages/server/src/mods/say/`): a `mod.json` and an `index.js` of about ten lines. Here is a block of your own, `ping`, which is a `say` whose prompt always starts with `Ping:`.

`<home>/mods/ping/mod.json`:

```json
{
  "reins": 1,
  "id": "ping",
  "kind": "block",
  "version": "1.0.0",
  "label": "Ping",
  "description": "A turn whose prompt starts with Ping:",
  "main": "index.js",
  "order": 200,
  "provides": { "kinds": ["ping"], "attrs": ["mode"] },
  "view": {
    "kind": "ping",
    "order": 200,
    "colour": "soft",
    "fields": [
      { "key": "prompt", "label": "Prompt", "input": "textarea" },
      { "key": "mode", "label": "Mode", "input": "mode", "unset": "write" }
    ],
    "line": ["ping", { "field": "prompt" }],
    "cards": true,
    "card": { "label": "ping", "section": "Flow" },
    "fresh": {}
  }
}
```

`<home>/mods/ping/index.js`:

```js
export default function activate(api) {
  const { checkMode, turnInstr } = api.core;
  api.registerBlock({
    kind: 'ping',
    attrs: ['mode'],
    validate: { early: checkMode },
    compile(step, ctx) {
      ctx.push(turnInstr({ ...step, prompt: `Ping: ${step.prompt ?? ''}` }));
    },
  });
}
```

A workflow that uses it:

```
## ping
> look at the logs
```

What happens, step by step:

1. The folder name and the `id` are the same. Reins reads the folder when it starts and after every change in Settings. The row says "needs trust" because the mod has code.
2. Press Trust (or import the mod with "Trust and import"). Reins shows what the mod adds (the block `ping`, the attribute `mode`, its place under "Flow") before any of its code runs.
3. `ping` is now in the palette, under Flow. The block list is built from the `view` in the manifest. The `order` of 200 puts it after the 14 blocks of the pack (they use 10 to 150).
4. The file parses, prints back byte for byte, and its check is clean. `compile` pushes one `TURN` instruction. `turnInstr(step)` is what builds it: a turn under the step's mode and cards. Here the step is copied with a longer prompt, and the run sends `Ping: look at the logs` (with the usual lines Reins adds to every turn).
5. `mode: sideways` is the error `mode must be read-only or write`, because `validate.early` is `checkMode`.

Notes:

- Everything the code registers must be listed in `provides`: the kind, its attributes, and (if it has any) its ops and events. The server refuses anything not listed.
- `attrs` are the lines the block body accepts. The two fields in the view are the editable lines of the block's panel; `prompt` needs no entry in `attrs`.
- A block with its own instructions (`ops`), events, a heading, or its own session is described in `packages/core/src/nodes/README.md` (the `NodeType` fields) and in `README.md` here. Models in the pack: `gate` (an op that pauses), `repeat` (a container), `model` and `subagent` (a block with its own session), `fork` and `playbook` (blocks that start tracks).
- A block that needs no code at all is a data block (`turn` in the manifest, see `README.md`).
- A block whose ops start tracks (as `fork` does, with `vm.tracks.start`) should say `"tracks": true` in its `mod.json`. The trust prompt then carries the line "This mod may run several sessions at once and spend money on them." (Reins also adds the line when it finds `tracks.start` in the code text.) A block that reads files from a folder of this computer, as `playbook` reads `blocks/`, says `reads` (see `README.md`), so the Share file can tell the importer that those files are not in it.
- Do not copy the `"pack"` or `"required"` words into your `mod.json`. Reins refuses the mod.

## Write a condition

A condition is a test that `gate`, `if`, `repeat` and `whenever` can make, such as `` `npm run lint` passes `` or `touches src/core/**`. The model is `cond-cmd` (`packages/server/src/mods/cond-cmd/`); `cond-touches` is the model for one that needs a glob. Here is `exists`: true when a file exists in the project folder.

`<home>/mods/cond-exists/mod.json`:

```json
{
  "reins": 1,
  "id": "cond-exists",
  "kind": "condition",
  "version": "1.0.0",
  "label": "Condition: file exists",
  "description": "True when a file exists in the project folder",
  "main": "index.js",
  "order": 200,
  "provides": { "conditions": ["exists"] },
  "view": {
    "exists": { "label": "file exists", "fresh": { "t": "exists", "glob": "README.md" }, "param": { "key": "glob", "look": "pill" } }
  }
}
```

`<home>/mods/cond-exists/index.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

export default function activate(api) {
  api.registerCondition({
    t: 'exists',
    parse(s) {
      if (!s.src.startsWith('exists', s.idx)) return null;
      s.idx += 'exists'.length;
      s.skipWs();
      const start = s.idx;
      while (s.idx < s.len && !/\s|[)]/.test(s.src[s.idx])) s.idx++;
      if (start === s.idx) return s.error('Expected a file name after "exists"', start);
      return { t: 'exists', glob: s.src.slice(start, s.idx) };
    },
    print(c) { return `exists ${c.glob}`; },
    judge: 'deterministic',
    globs(c) { return [c.glob]; },
    evalSync(c, ctx) { return fs.existsSync(path.join(ctx.cwd, c.glob)); },
  });
}
```

A workflow that uses it (the step runs only when `ready.txt` is in the project folder):

```
## if exists ready.txt

### phase Ship it
> ship it
```

The parts:

- `t` is the atom's name, the word the parser stores in the workflow. The `provides.conditions` list must name it.
- `parse(s)` reads the text at `s.idx`. If the text is not yours, return `null` and leave `s.idx` as it was: the parser tries the next atom. If it is yours but malformed, return `s.error(message, position)`. Atoms are tried in `order`, so pick words that no earlier atom starts with. `s.skipWs()` skips spaces; `s.quoted()` reads a quoted string.
- `print(c)` gives the text back. Printing what `parse` read should give the same condition again, because Reins prints the workflow whenever it saves it.
- `judge` says who decides: `deterministic` (your code, no model), `command` (a shell command), `you`, `agent`, `model` or `subagent`. `modelCall` (optional, a short name) makes the validator warn that the condition costs extra model calls.
- `evalSync(c, ctx)` or `evaluate(c, ctx)` (async) answers. `ctx` has `cwd`, `events` (the run's log, read only), `commandResults`, `lastTurnText`, `runCommand(cmd)` and a few more (the `EvalCtx` type in `packages/core/src/cond.ts`). With neither function the atom is always false.
- `globs(c)` lists globs for the validator to check. If your condition runs a command on its own, list it in `commands(c)`: the trust list shows those commands to the user. `auto: false` makes the atom always false inside an automatic `whenever` card (`not` flips it).
- The `view` in the manifest gives the editor its menu word, a new atom (`fresh`), and the one value box (`param`). `param.key` must be one of `cmd`, `q`, `n` or `glob` and must be a field of your atom, which is why `exists` keeps its file name in `glob`. `look` is `code`, `str`, `num` or `pill`.
- The code runs inside the Reins server with the user's rights; a throw in `parse` or `evaluate` goes into core (see "What is not contained" in `README.md`). Keep the code small and check what you read. The `exists` example joins a name from the workflow to the project folder, and a name like `../x` goes outside it; a real condition should refuse that.

`api.core` has helpers for conditions: `globMatcher`, `isValidGlob` and `relPath` for a glob (as `cond-touches` does), and `driftFound` for the drift signal. The full list is in `README.md`, under "The code: `activate(api)`".

## Write a card

A card is a line in a block that says something to the agent or to Reins, such as `guard: migrations/**`. The pack has three: `guard` (a path the agent may not touch), `now` and `stop` (delivered by a `whenever` block). The model for a card that does something small is `card-now` (`packages/server/src/mods/card-now/`, six lines of code); `card-guard` is the model for one with a policy and a check. Here is `noshell`: a step with this card may not run shell commands.

`<home>/mods/card-noshell/mod.json`:

```json
{
  "reins": 1,
  "id": "card-noshell",
  "kind": "card",
  "version": "1.0.0",
  "label": "Card: no shell",
  "description": "A step with this card may not run shell commands",
  "main": "index.js",
  "order": 200,
  "provides": { "cards": ["noshell"] },
  "view": {
    "noshell": { "section": "No shell", "add": "Add no-shell" }
  }
}
```

`<home>/mods/card-noshell/index.js`:

```js
export default function activate(api) {
  api.registerCard({
    kind: 'noshell',
    turnLine(card) { return `Do not run shell commands. (${card.text})`; },
    policy(card, policy) { policy.allowShell = false; },
  });
}
```

A step that uses it. The card is the line `noshell: <text>`:

```
## phase Read the code
noshell: this step only reads
> read the parser
```

The parts:

- `kind` is the word before the colon. It must be in `provides.cards`.
- `turnLine(card)` is the sentence added to the turn's prompt. Without it Reins writes `noshell: this step only reads`.
- `policy(card, policy)` changes what the step's turn may do. `policy.guards` is a list of globs (that is what `guard` pushes), `policy.mode` is `write` or `read-only`, and `policy.allowShell` false makes every shell command in the step answer `Blocked by Reins: shell commands are not allowed in this step.`
- `validate(card, ctx)` can push an error or a warning for a card line, with `ctx.push({ severity, message, pos })`.
- `delivery` (`now` or `stop`) is for a card that a `whenever` block fires into a running session. Such a card is allowed only inside a `whenever` block.
- The `view` gives the panel its section title and its add button. A card with no `view` is not offered in the panel, but it still parses and runs. Today the block panel has one add button, for the first card kind in `order` (`guard`, order 10); a card of yours is written as a line in the Text view, and the panel then lists it as a row you can edit or remove (read from `packages/app/src/BlockPanel.tsx`; not tried in a browser).
- The block's view must carry `"cards": true` for its panel to show the cards section: the `say` and `ping` views do.
- The eight question cards (gate, budget, usd, tool, trust, switch, judge, resume) belong to core and cannot be replaced by a card mod.

## Write a playbook

A playbook is a workflow file that another workflow uses as one block. Use it to keep a routine (a review, a release check) in one file and give it inputs.

**Where the file goes.** In a folder called `blocks/` next to the workflow file that uses it, named `<name>.reins.md`. A workflow in `<project>/.reins/workflows/ship.reins.md` finds its playbooks in `<project>/.reins/workflows/blocks/`. `reins run`, `reins check` and the app all look there.

**The playbook file** is a whole workflow file with its front matter. `{{name}}` marks an input:

`blocks/review.reins.md`:

```
---
reins: 1
name: review
budget: { turns: 5, minutes: 5 }
always: []
---

## phase Look
> Review {{area}}, {{depth}} pass.

## phase Write
id: report
> Write the findings for {{area}}.
```

**The workflow that uses it** (`ship.reins.md`, after its front matter):

```
## phase Plan
> Plan the change.

## playbook review
id: review
input: area = the API; depth = quick
session: own
usd: 0.50
output: report

## phase Wrap up
> Summarise the review.
```

The same playbook can run in the conversation you already have. Leave out `session:`, `usd:` and `output:`:

```
## playbook review
input: area = the parser; depth = deep
```

The lines of a `playbook` block:

| Line | Meaning |
|---|---|
| `## playbook <name>` | The file `blocks/<name>.reins.md`. |
| `input:` | `name = value; name = value`. Each `{{name}}` in the file is replaced by its value: in prompts, titles, attributes, card texts and conditions, before anything is compiled. So the commands you are asked to trust are the commands that will run. A `{{name}}` with no input is an error. An input the file never uses is a warning. A value is filled in one pass: a value that holds `{{other}}` stays as it is. |
| `session: own` | The playbook runs as a track of its own: its own conversation, its own approvals, its own Stop. Without it the steps are compiled into your workflow and run in the same conversation. No other value is allowed. |
| `usd:` | A USD budget for the playbook alone. An amount above 0, like `2.50`, and only with `session: own`. The run ignores anything else, and the playbook then has no budget of its own. |
| `output:` | Step ids of the file, separated by commas, only with `session: own`. Only those steps' last replies go back to the block under the playbook, each quoted as data. Without `output:` the track's last reply goes back. A named step that never ran says `<id> did not run.` |

How the steps are named: an inline playbook puts its steps in your workflow with the id of the playbook step in front, so the first step above is `review/look` (`playbook-1/look` if you give the block no `id:`). That is the id you see in the run and the id that `output:` names without the prefix. An `end` inside an inline playbook ends only the playbook. In a playbook with `session: own`, an `end` ends the track.

Limits (every one is checked and says so in words):

- A name is one plain file name: letters, digits, `-`, `_` and `.` only, at most 100 characters, starting with a letter or digit, and not a Windows device name. A path (`../x`, `a/b`) is refused.
- The file must be a plain file inside `blocks/` (a link that points outside is refused), at most 100,000 bytes, and a workflow.
- At most 30 inputs; a name is at most 40 characters (a letter first, then letters, digits, `-`, `_`); a value is at most 300 characters, holds no `;` and no hidden character.
- A playbook may use another playbook, up to 8 levels deep. A file that runs itself, directly or through others, is refused.
- One outermost playbook may put in at most 2,000 steps and 2 million characters, and one check reads at most 100 files.
- A `model` block cannot be inside a playbook with `session: own`. A `fork` cannot be inside any playbook.
- What the file's own check finds is shown on the playbook step, 20 problems at most.

A playbook file is somebody else's text, so a hostile one is refused with words and never trusted quietly. The commands inside a playbook are in the trust list like any command.

## The fork block

`fork` runs several branches at the same time, then hands their results to the block under it. A branch is a chain of blocks that starts at a block the fork points to with a `next:` line.

```
## phase Plan
> Plan the work.

## fork
next: api
next: db

## phase Build
> Build it from both results.

## end

## phase API research
id: api
mode: read-only
> Read the API docs.

## end

## phase DB research
id: db
mode: read-only
> Read the schema.

## end
```

Read it as: the main line is `Plan`, the fork and `Build`, then an `end`. Each `next:` names the first block of a branch. Each branch lies behind that `end`, ends with its own `end`, and nothing else leads into it. On the canvas, the `next` handle is only on the fork: drag a wire from it to the first block of each branch.

What happens when the main line reaches the fork:

- Each branch starts as a track titled `Branch <the title of its first block>`. It opens **a new conversation** of its own. Its first message carries the last reply of the main line, quoted as data (in a fence, the last 8,000 characters at most, with a line saying how much was cut). It does not see the main line's conversation.
- The branches run at the same time. They share the project folder: two branches that can both write get a warning, because nothing separates their edits.
- The main line waits on the fork. When every branch has ended, the block under the fork gets the results in the order of the `next:` lines: for each branch, `Result of <title> (step <id>)` and its last reply, quoted as data and cut at 8,000 characters. A branch that ended with no reply says `<title> finished without a reply.`

Money: each branch has its own spend and its own share.

- The share is the room divided equally: the room is what the workflow's USD budget has left, or the budget of the `model` block that is open at the fork (the smaller of the two, when there are both). `$1.00` over 3 branches is `0.333334` each, and `0.50` over 3 is `0.166667`: the share is rounded up to a millionth of a dollar.
- With no budget anywhere, a branch has no cap of its own.
- A branch that uses up its share is given what the other branches have not used, when that is a cent or more. Less than that, and the run pauses once, on the USD card for the whole run.
- Each branch has its own row in the receipt, with its turns and dollars; the run total counts every reply once.

Approvals: a gate inside a branch is a card of that branch, titled with the branch (`Branch Review the API`), and the other branches go on running.

A branch that fails (the model call throws) **pauses alone**, on its own card: `Branch API research failed: boom; Resume tries again`. The other branches finish, the fork waits, and Resume tries the failed branch again. Stop on that card stops the whole run.

Stop reaches every branch: all their sessions are closed, the fork never says it is done, and the run is stopped.

The checks Reins makes before it runs a fork, in the words it uses:

| Check | Severity |
|---|---|
| `fork <id> has no branches; drag a wire from it to the first block of each branch` | error |
| `fork <id> has one branch: it runs nothing in parallel` | warning |
| `fork <id> has two wires to <id>` | error |
| a branch can be reached from the main line, a step is in two branches, or a branch leads back into the main line | error (put an `end` under each branch) |
| `fork <id> must be in the main stack, not inside a branch or a playbook` | error |
| `a model block cannot be inside a branch; put it before the fork` | error |
| `branches <a> and <b> can both edit files in the same folder at once` | warning |
| `nothing after fork <id> gets the branch results` | warning |

## The Share file

Share is one file that holds a workflow and the mods it needs, so that someone else can import both with one click.

**Export.** Two places make the file:

- **Share** in the workflow menu of the Text view. It is off while the workflow has unsaved changes, because the file holds the saved workflow. It downloads `<name>.reins-mods.json`.
- **Export my mods** in Settings > Providers. It downloads `my-mods.reins-mods.json` with every mod that is not built in (the ones you installed and your Customize copies), the first 20 at most.

The file is JSON:

```json
{
  "reinsMods": 1,
  "mods": { "ping": { "mod.json": "...", "index.js": "..." } },
  "workflow": { "name": "ship", "text": "---\nreins: 1\n..." }
}
```

What is in it:

- `workflow`: the name (letters, digits, `-` and `_`, at most 60, never a path) and the text of the saved workflow, at most 256 KB.
- `mods`: for each block, condition (in a step's `until:` or `if`, or in a `whenever` block) and card that the workflow uses and that comes from a mod of yours (a user mod, or your Customize copy of a built-in), the mod's text files. The file never holds a key, `secrets.json` or any file outside the mod's folder; a file that holds a key Reins knows is refused.
- At most 20 mods and 1 MB in all.

What is NOT in it:

- **The built-in blocks, conditions and cards.** A workflow that uses only the pack's gives a file with `"mods": {}`. Whoever imports it already has them. The app says so ("no mods in the file (the blocks it uses ship with Reins)").
- **Playbook files.** A `playbook` step names a file in `blocks/`, and that file is not carried. The export says so, once for each file: `The playbook review is a file in your blocks folder and is not in this file. Whoever imports the file needs a playbook with that name.` Whoever imports the workflow needs the same `blocks/<name>.reins.md`; until they have it, the check says `Playbook "review" not found`. Send the playbook files yourself, or give the importer the folder. (The note comes from the `reads` word in the playbook's own `mod.json`: `{ "noun": "playbook", "folder": "blocks", "name": ["title", "playbook"] }`.)
- A block that no mod installed on your machine brings gets a note when you export (`The block "x" is brought by no mod installed here, so no mod for it is in the file. Whoever imports the file needs that mod.`). The file still holds the workflow.
- The `blocks/` folder, keys, consent, trust and settings.

**Import.** Choose Import in Settings > Providers and pick the file. Reins shows one preview for the whole file: each mod with what it adds (`ping: adds the block ping ...`), the hash of each code mod, and what the workflow would do. A workflow that uses a block the file brings is checked with that block in mind; one that uses a block nobody brings shows the `Unknown step kind` line.

- **One trust prompt for each code mod.** Trust is by hash of every file. You say yes to a mod by the hash you were shown: "Trust and import" trusts every code mod of the file, "Import without running its code" installs them as "needs trust". A data mod needs no prompt.
- A mod of the file with the id of a built-in needs its own confirm ("is part of what ships with Reins. The copy in this file takes its place after a restart.").
- **All or nothing.** Everything is checked first. Then the mods and the workflow are placed, and when one step fails, the ones already placed are taken back. A refused file leaves nothing behind.
- The workflow is saved as `<home>/workflows/<name>.reins.md`, new only. If a workflow of that name is already saved, the whole file is refused until you rename or remove one.
- A file with two mods that bring the same block, condition or card, a mod with a key in it, or a hidden character in the workflow text is refused.
- An old single-mod file (`reinsMod`) still imports as before.
