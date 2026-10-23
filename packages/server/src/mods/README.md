# Providers are mods

> Writing a block, a condition, a card or a playbook, the default pack, Customize, the `fork` block and the Share file are in [`PACK.md`](PACK.md). This file covers providers, protocols, and the rules every mod follows.

A provider is one folder in `<home>/mods/<id>/` with a `mod.json`. The home is `~/.reins` unless `REINS_HOME` says otherwise. Reins reads the folder when it starts and again after every change in Settings. A mod that has a mistake is listed with the reason, and nothing else stops.

There are two kinds you need here:

- A **provider** is data. It names a protocol, an address, a key variable and the models. It runs no code.
- A **protocol** is code. It turns Reins' neutral request into one API's request and the stream back into events. Two ship with Reins, for the two common chat styles. Write your own only when your API speaks neither.

## A data provider in 10 lines

```json
{
  "reins": 1, "id": "acme", "kind": "provider", "version": "1.0.0", "label": "Acme",
  "protocol": "openai-chat",
  "baseUrl": "https://api.acme.example/v1",
  "auth": { "style": "bearer", "keyEnv": ["ACME_API_KEY"] },
  "defaultModel": "acme-1",
  "models": [{ "id": "acme-1", "context": 128000, "maxOutput": 8000, "tools": true, "price": { "input": 1, "output": 2 } }]
}
```

- The folder name and `id` must be the same: lowercase letters, digits and dashes.
- Prices are USD per million tokens. A model with no price has an unknown cost, and Reins will not hold a USD budget on it. A provider-level `price` covers every model that has none (use `0` and `0` for a program on your own machine).
- `keyEnv` names must end in `_API_KEY`, `_KEY` or `_TOKEN`. The key itself never goes in a mod.
- `modelsUrl` is optional and must be on the same address as `baseUrl`.
- Run a session as `acme:acme-1`: the provider, a colon, the model.

## Add a custom endpoint from Settings

1. Open Settings, then Providers, then **Add custom endpoint**.
2. Fill in the label, the id, the protocol, the base URL and how the key is sent (bearer, a named header, or none).
3. Add at least one model: its id, its window, and its prices if you know them.
4. Save. Reins writes the same `mod.json` as above. A mistake is shown next to the field.
5. Set the key (or set the variable in your environment), then press **Test connection**. Reins asks first: "Allow Reins to send your key, and your prompts and files in sessions on this provider, to <host>?" The yes is for that address and for sessions as well as the test, so a session on this provider does not ask again. Say yes only for an address you trust.

## A custom wire (a protocol mod)

A protocol mod is a folder with a `mod.json` and one file of code:

```json
{ "reins": 1, "id": "toy-echo", "kind": "protocol", "version": "1.0.0", "label": "Toy echo wire", "main": "index.js" }
```

`main` must default-export a function. Reins calls it once with `{ env, registerProtocol }`. It registers a protocol with `conversation: 'reins'` (Reins keeps the history and runs the agent loop; the wire only makes one model call). The other value, `'own'`, is for a program that keeps its own conversation, and is not covered here.

The wire has one required method. `call(req, provider, host, signal)` is an async generator of events: `text`, `thinking`, `tool_call` (once, complete, with `args` as JSON text), `usage`, and a last `done`. `host.send` is the only way to reach the network: it adds the key, asks for consent and hides the key in errors. `host.redact` cleans any text you put in an error. A stream that ends before it is complete must throw (it is tried again, and nothing of it is kept). A reply that carried no usage at all yields `{ type: 'usage', usage, unknown: true }`: its cost is then unknown, never 0, and a USD budget stops honestly. The loop cuts a reply over 4 MiB or a call over 30 minutes. A provider's `body` (and a model's, and a reasoning level's) is merged into every request, but it cannot name `model`, `messages`, `tools`, `stream` or `stream_options`: Reins writes those.

The whole toy wire from `test/fixtures/mods/toy-echo/index.js` is the minimal complete example. Round one answers with a shell call. Round two, after the result, answers with text and a usage count, so a cost is worked out.

```js
import fs from 'node:fs';
import process from 'node:process';

const marker = process.env.TOY_MARKER;
if (marker) fs.appendFileSync(marker, 'toy-echo loaded\n');

const usage = (input, output) => ({ type: 'usage', usage: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });

const wire = {
  async *call(req, p, h, signal) {
    if (!h.send) throw new Error('This host cannot send requests to a provider.');
    const res = await h.send(p, `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: req.model, messages: [] }),
      signal,
    }, 'chat');
    const said = await res.text();
    if (!res.ok) throw new Error(`The toy provider answered ${res.status}.`);

    const last = req.messages.at(-1);
    const result = last?.blocks.find((b) => b.type === 'tool_result');
    if (!result) {
      const shell = req.tools?.find((t) => t.name === 'Bash' || t.name === 'PowerShell');
      if (!shell) throw new Error('The toy wire needs a shell tool.');
      yield { type: 'tool_call', id: 'toy-1', name: shell.name, args: JSON.stringify({ command: 'echo toy-ok' }) };
      yield usage(100, 20);
      yield { type: 'done', stop: 'tool_use' };
      return;
    }
    yield { type: 'text', text: `echo-1 saw: ${result.content}\nprovider said: ${said}\nREINS: done` };
    yield usage(200, 30);
    yield { type: 'done', stop: 'end_turn' };
  },
};

export default function activate(api) {
  api.registerProtocol({ id: 'toy-echo', conversation: 'reins', wire });
}
```

Write the file as an ES module. Node 22.12 and later reads `export default` in a `.js` file by itself. If yours does not, name the file `index.mjs` and set `main` to match.

A provider then uses it with `"protocol": "toy-echo"`. The provider needs the protocol installed (and trusted) first, or it is listed as invalid.

Reins has no unload for code. When a mod's files change, Reins loads the new copy only after a restart, and Settings says so.

### What a code mod may touch

Node has no sandbox. A trusted code mod runs in the Reins server process with the user's rights: it can read every file, every key in `secrets.json`, and the network. The trust prompt promises only this: Reins shows what the mod is, runs exactly the bytes you trusted, asks again when any file changes, and never runs untrusted code. It does not promise the code is safe. Data-only mods run no code.

## What is confined and what is not

The agent in a loop session has file tools (read, write, edit, glob, grep) and a shell tool.

**The file tools are confined.**
- A path is refused before any disk call when it is a network path (`\\` or `//`), a device path, a drive-relative path like `C:foo`, a Windows device name (`CON`, `NUL`, `COM1` and so on), or a short name like `PROGRA~1`. These checks run on every system.
- Other paths are resolved to their real place (links followed) and compared with the project folder. Inside the project: reads run, and writes run after the usual checks. Outside it: every file tool asks you first.
- The Reins home is always refused, even if you would say yes.
- Glob and grep do not follow links, stop at depth 20, skip `node_modules` and `.git`, and drop any result outside the project.

**The shell is NOT confined to the project folder.** It is a real shell with your rights. A command can read or write anything you can. Its guards are only these:
- every shell command asks for your yes (auto-approve answers it for you);
- a command that names the Reins home (`~/.reins`, `$HOME/.reins`, `%USERPROFILE%\.reins`, its full path) or `secrets.json` is refused by a word scan, which a determined command can get around;
- its environment has no provider key variable, no `REINS_*` variable, and no variable whose value holds a known key.

Do not treat the approval as optional. Read the command before you say yes.

## Things that differ from the CLI program provider

- Loop sessions (API providers) read `AGENTS.md` from the project folder, not `CLAUDE.md`. They do not read `.claude/` settings either. Put shared rules in `AGENTS.md`.
- The CLI program provider keeps its own environment. It needs its own login variables, so Reins does not strip them. If you set an API key variable that the program reads, the program uses it and bills that key. The probe warns about it.
- A conversation with a loop session is a file in `<home>/conversations/`. Switching between two loop providers keeps it. Switching between a loop provider and the CLI program is not allowed in one session.

## Test a provider with the fake server

`test/fake-provider.ts` starts a scripted server on `127.0.0.1` that speaks both common chat styles and a model list.

```ts
const fake = await startFakeProvider();
fake.push({ text: 'hello', usage: { prompt_tokens: 10, completion_tokens: 5 } });
// point the provider's baseUrl at `${fake.url}/v1`, run a session, then read what was sent:
fake.requests; // { path, headers, body } of every request, in order
fake.list.data = [{ id: 'm1' }]; // the model list it answers with
await fake.close();
```

- One `push` is one model reply. A reply can hold `text`, `reasoning`, `toolCalls`, `usage`, a `status` with a `body` for an error, or `hangMs` to be slow.
- The requests show the `authorization` header, so a test can check that the key arrived and nowhere else.
- `test/toy-provider.test.ts` is a complete example: it installs the toy wire and the toy provider, runs a workflow with an approval, checks the cost, exports to a second home, disables, enables and removes.

## Export, import and the trust prompt

- **Export** (Settings > Providers > Export) gives one JSON file with the mod's text files. It never holds a key, `secrets.json` or any file of the home. Reins refuses to export a file that holds a key it knows.
- **Import** shows a preview first: the id, the kind, the files, and whether it replaces a built-in. Then you import.
- A mod with code has two import buttons. **Trust and import** runs the code at once. **Import without running its code** installs it but does not run it: it waits as "needs trust" until you press Trust on its row under "Protocols and other mods" in Settings > Providers. Trust asks the same question first. The prompt says: "This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author." Say yes only to code you have read or whose author you trust.
- Trust is by hash of every file. If one byte of one file changes, Reins asks again, and the new code does not run until you do. Removing a mod removes its trust, so the same files imported again ask again.
- A data mod has no prompt, because it runs nothing. It still never carries a key: export it, send it, import it, and the new home has to set its own key and give its own consent.

- Switching off or removing a protocol that providers use asks first and names those providers: "Providers that use it will stop working: ...". The server itself does not refuse it.
- Before you import a provider, the preview says where it sends your prompts and files ("sends your prompts and files to <host>", with "over plain http" when it applies), whether Reins already holds a key saved for that id ("uses the key saved for <id>"), and which key variables are set now ("reads <NAME>"). A mod file cannot make itself the default provider; choose that in Settings.

## Money limits you should know

- A USD budget is held only when Reins knows what the session has spent. A reply with no usage, a call that failed after the provider began to answer, or a session whose file lost a line makes the spend **unknown**, and Reins does not guess zero.
- When the spend is unknown and a dollar limit is set, the next call is not sent and the pause says: "Reins cannot tell what this session has spent, so Allow cannot raise the dollar limit. Start a new session or remove the limit."
- Stop in the middle of a reply may leave a partly billed call uncounted: the provider bills what it generated, but Reins only counts a call whose usage it received.

## Where keys live

- A key you set in Settings is stored in plain text in `<home>/secrets.json`. The file is private to your user on systems that support it, and is not encrypted. Programs running as you can read it.
- An environment variable (the name in `keyEnv`) always works instead, and is the safer choice on a shared machine.
- Reins hides every known key in what it shows, logs and saves: events, the conversation file, error text, command output and exports. Hiding is a safety net, not a promise: a command you approve can still print a key it finds.
- Removing a provider keeps its key in `secrets.json`, so installing it again finds it. Clear the key first if you want it gone.

## Block, condition and card mods

A mod can add a **block** (a kind of step), a **condition** (a test that a `gate`, `if` or `repeat` can make, such as `tests pass`) or a **card** (a card kind). It is one folder, `<home>/mods/<id>/`, with a `mod.json`. The folder name and the `id` must be the same: lowercase letters, digits and dashes, starting with a letter or a digit, at most 40 characters.

A block has code (`main`) or no code at all (`turn`, see Data blocks). A condition and a card always need code.

### The manifest

| Field | Rule |
|---|---|
| `reins`, `id`, `kind`, `version`, `label` | Required, as for every mod. `kind` is `block`, `condition` or `card`. |
| `description` | Optional text. |
| `main` | The code file, inside the folder. A block has `main` or `turn`, never both. |
| `turn`, `statusLine` | Data blocks only (see below). |
| `order` | Required, a number. It sets where the kind or condition sits in core's registry. The default pack's blocks use 10 to 140 (their views, 10 to 150), and its conditions use 10 to 110. Pick a number above 150 for a new block. |
| `provides` | Required. It lists everything the mod may add (below). |
| `view` | Blocks only. The block's face, as JSON (below). |
| `tracks` | Blocks only, optional, `true` or `false`. Says the block's ops may start tracks (several sessions at once, spending USD). A block with code that says it, or whose code calls `tracks.start`, gets one more line under the trust prompt: "This mod may run several sessions at once and spend money on them." |
| `reads` | Blocks only, optional: `{ "noun": a name, "folder": a name, "name": [1 to 4 field names] }`. Says the block reads files from a folder of this computer, named by the step's `title` or attributes. The Share file does not carry those files and says so with the `noun` (the playbook says `{ "noun": "playbook", "folder": "blocks", "name": ["title", "playbook"] }`). |

`provides` takes these keys:

- A block: `kinds`, `ops`, `attrs` and `events`. A data block lists exactly one kind and no ops.
- A condition: `conditions`.
- A card: `cards`.

Each list holds at most **50 names**. A name starts with a letter, and holds only letters, digits, `-` and `_`. It is at most 40 characters. A name may not repeat. Any other key in `provides` is refused.

`view` is an object of at most **32 KB** of JSON text. Its `kind` must be one of `provides.kinds`. Its `fields` and `line` lists are required, with at most 50 entries each. `fresh` (an object) and `order` (a number) are optional. No text in the view may hold a control, line-break or direction-changing character. A zero-width one counts too. Keys count as text.

A view may also carry `status` (what an event of the block does to the run's marks, one rule for each event in `provides.events`: `state`, `why`, `attempts`, `cursor`, `gate`, `opens`, `label`, `when`; the types are `StatusRule` in `packages/core/src/nodes/fields.ts`) and `hidden` (a list of the block's events that draw no row). Both are plain data, checked by the same shared check as the rest of the view, and an event core logs itself cannot be named in either. An event with a `status` rule draws no row of its own (the feed takes it as part of the step's knot); an event you want drawn gets a `rows` entry and no `status` rule.
The server checks the fields above. It does not check the other view keys (`colour`, `card`, `sub`, `rows`). Those are the `KindView` type in `packages/core/src/nodes/fields.ts`.

A manifest that fails a check is listed with the reason, in plain words. Its code is never read.

The app gets the views of every block mod from `GET /api/kinds`, built from the manifest only. A mod cannot give a view to a built-in block name, except the Customize copy of that block (see `PACK.md`). The block list sorts by the view's `order`, and falls back to the manifest's `order`.

### The code: `activate(api)`

The default export of `main` is `activate(api)`. Reins calls it once. The `api` is built for this mod, limited to what `provides` lists, and frozen.

- `registerBlock(node)`: one argument, a `NodeType` (see `packages/core/src/nodes/README.md`). The block's view is the manifest's `view`. Code cannot give a view.
- `registerCondition(c)`: a `CondType`.
- `registerCard(c)`: a `CardType`.
- `core`: exactly nine functions (`buildApi` in `loader.ts`; the object is frozen). Nothing else: not `register`, `NODES`, `CONDS`, `CARDS` or `opOf`. They are plain functions of core; none of them registers anything or reads a registry for you to change.

  | Function | What it does | Safety |
  |---|---|---|
  | `checkMode(step, ctx)` | A `validate` hook: pushes an error when the step's `mode:` is not `read-only` or `write`. | Pure. |
  | `turnInstr(step)` | The `TURN` instruction for a step: a turn under the step's own mode and cards. A block pushes it from `compile`. | Builds data; calls `policyOf`. |
  | `policyOf(step)` | What the step's turn may do (`mode`, `guards`, `allowShell`), from its `mode:` and its cards. | Runs the `policy` hook of each card on the step, which is other mods' code. |
  | `parseCond(src, pos?)` | Reads condition text into `{ cond }` or `{ diag }`, for a block that takes a condition in its heading (like `if`). | Runs the `parse` of the registered condition atoms. |
  | `printCond(cond)` | Prints a condition back to text. | Runs the `print` of the atoms. |
  | `driftFound(events)` | True when any drift signal fires in a run's events (the `drift` condition's test). | Pure; reads the array, never writes it. |
  | `globMatcher(glob)` | A function that tests a project-relative path against a workflow glob (picomatch's defaults). | Pure. A pattern it cannot read may throw, so check with `isValidGlob` first. |
  | `isValidGlob(glob)` | True when the text is a glob Reins accepts. | Pure. |
  | `relPath(path, cwd)` | A tool path with `\` turned into `/`, `.` and `..` resolved, and made relative to `cwd` when it lies inside it. | Pure; touches no file. |

  The last four exist so that a condition or a card can do its work without importing a package: a mod may not import `@reins/core` or the glob package itself. The default pack uses them (`cond-touches` uses `globMatcher` and `relPath`, `cond-drift` uses `driftFound`, `card-guard` uses `isValidGlob`).
- `env` and `registerProtocol`, as for a protocol mod.

When `activate` returns or throws, the registrars refuse with "the api can only be used while the mod activates." `core` stays callable, because a block calls `turnInstr` when it runs.

Each registrar refuses, and the line names the mod:

- a kind, op, attribute, condition or card the mod did not list;
- a `heading.owns` key, or a `count` or `print` event, the mod did not list;
- a registrar its kind does not allow (a condition mod that calls `registerBlock`);
- one of the core ops `TURN`, `JUMP`, `END` or `NODE`;
- a kind that core already has (`kind "say" is already registered`).

The block's node is copied once, before the check, and core stores that copy. A getter that changes the original later changes nothing.

The eight question cards belong to core. They are not in the card registry, so no card mod can replace them. They are plain data; see "Conditions, cards and question cards" below.

### Templates

Two places use a template. Both use `{...}` placeholders. Neither runs code.

- A data block's `turn`, in the manifest. `{attr}` is replaced by the step's attribute of that name. `{a|b}` uses `a` if the step sets it, and `b` if not. Each name must be in `provides.attrs`. A filled value is one line of at most 1000 characters, and the whole prompt is at most 16 KB. A turn has no formats.
- A view's `sub` (the small text on the face) and `rows` (feed rows). `{path}` reads a value by dots, such as `{attrs.playbook}`. `{a|b|c}` takes the first one that has text. `{path:usd}` shows dollars, such as `$0.0123`. `{path:count}` shows a number with separators, such as `1,234`. A template that does not parse is shown as its own text. The filler reads only the object's own values, never a getter.

### Data blocks

A block with `turn` and no `main` runs no code. Its step compiles to one prompt turn, filled from the template. The turn runs under the step's own mode, so `mode: read-only` in the workflow makes it read-only. The manifest cannot set `policy`, `mode`, `allowShell` or `tools`. The block has no ops and no heading. A data block needs no trust, because it runs nothing. Its `statusLine` is optional: one line, at most 200 characters, with no hidden character.

This is the whole `toy-ask` mod (`packages/server/test/fixtures/mods/toy-ask/mod.json`):

```json
{
  "reins": 1,
  "id": "toy-ask",
  "kind": "block",
  "version": "1.0.0",
  "label": "Toy ask",
  "description": "A data block for tests: no code, one prompt about `topic` (and `mode`, if given).",
  "order": 150,
  "provides": { "kinds": ["ask"], "attrs": ["topic", "mode"] },
  "turn": "Answer about {topic} in one line. Mode: {mode|topic}.",
  "statusLine": "REINS: done | blocked: <reason>",
  "view": {
    "kind": "ask",
    "order": 150,
    "colour": "soft",
    "fields": [{ "key": "topic", "label": "Topic", "input": "text" }],
    "line": ["ask", { "field": "topic" }],
    "card": { "label": "ask", "section": "Flow" },
    "fresh": { "attrs": { "topic": "cats" } }
  }
}
```

A workflow step that uses it:

```
## ask
topic: dogs
mode: read-only
```

The prompt is "Answer about dogs in one line. Mode: read-only." Without `mode`, `{mode|topic}` falls back to the topic, so the prompt reads "Mode: dogs."

### Conditions, cards and question cards

A condition or card mod gives its editor data in the manifest `view`, keyed by each name in `provides.conditions` or `provides.cards`. A condition view is `{ label, fresh, param? }`; `param.key` must be one of `cmd`, `q`, `n`, `glob`. A card view is `{ section, add }`. The app builds its menus from the served list, so a mod condition shows up in the menu with no app change.

The eight question cards (gate, budget, usd, tool, trust, switch, judge, resume) belong to core. A mod cannot register, replace or switch one: a manifest that names one is refused. They are plain data in `packages/server/src/questions/`, one file each, and the app reads them from the same served list.

### When a change applies

Reins registers each block, condition and card in core once, when the server starts. A registration stays until the server stops. So a reload (after a change in Settings) never registers a mod twice, and never removes it.

- A mod that is registered and unchanged stays as it is.
- A mod whose `mod.json` or code changed, that was switched off, that is no longer trusted, or that was removed keeps its old registration. Settings says `` `<id>`: applies after a restart. ``
- A mod that was not registered yet (a new one, or one trusted or turned on after start) registers at once. It does not wait for a restart.
- A user mod with the id of a bundled block, condition or card mod replaces it (that is what Customize makes: see `PACK.md`). The copy may cover only what the bundled mod itself `provides`: a copy of `say` may replace `say`, never `end` or `gate`. Reins enforces this (`mayShadow` in `loader.ts`). The copy's `view` may also say `stops` and `coreRows` (the feed rows of events core logs) only as far as the built-in's view does; see `PACK.md`. A copy of a built-in waits for a restart.

### Trust

Before any of its code runs, the row in Settings (and the import preview) shows:

- what the mod adds, as lines such as ``adds the block `beep` ``, `its operations: BEEP`, `may log the events: beeped`, `may use the attributes: times`, and `shown in the block list as "beep" under "Flow"`;
- a warning when Reins already has a block, condition or card of that name, because its code would be refused at start;
- the block's face, from its `view`. The block list draws it marked as not trusted, and nothing of it runs.

Trust then asks the code prompt: "This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author."

Trust is by hash of every file in the folder, `mod.json` included. A change to `provides`, to `view` or to any byte of code asks again. The new code does not run until you trust it.

### What is contained

Reins limits what a mod's code can do to core, through its hooks and ops.

- A hook that throws does not break Reins. Saving, printing, reading and checking carry on. A throw in `compile` or in a check shows as an error on the step.
- The print, count and check hooks get a copy of the step, the instruction or the event. A compile hook builds the program, so what it pushes is the program; Reins checks the program after it is compiled (see below).
- A node is copied once, before the check. The copy is what core runs.
- A stuck op does not hold Stop. Stop returns at once, and the op's late writes are dropped.
- A mod op's `vm` is the run's own hands, fenced. These members are checked: `vm.log` (only the event names the mod listed), `vm.command` (only the commands the op lists in `commands`), `vm.goto` and `vm.tracks.start` (to a place in the program). These are also there and act with the run's own authority: `vm.pause`, `vm.takeLink`, `vm.turn`, `vm.ensureSession`, `vm.setRecall` and `vm.handBack`. A mod you trust can therefore pause its track, run a turn and hand text back; trust one only if you would let it do that.
- The program is checked after it is compiled. A jump or a start to a place outside the program is refused, and the run does not start.
- Output is capped: a heading at 200 characters, a count key at 40, a printed line at 300, and an error message at 200.
- A throw from a mod op pauses its track.

### What is not contained

A trusted mod's code runs in the Reins server process, with the server's rights. It can read your files, the keys in `secrets.json`, and use the network. The limits above cover only how core calls a block. They are not a sandbox. Trust a mod only if you trust its author.

These are not stopped either:

- a loop that never waits, and `process.exit`;
- a condition's `parse` or `evaluate`, and a card's hooks, when they throw. They throw into core. Only a condition's `commands` is read safely;
- the store, recall, session and turn functions that a block gets from the run. A block runs turns by design;
- a mod that imports `@reins/core` itself.

### A worked example: toy-beep

This walks through `packages/server/test/fixtures/mods/toy-beep`, from install to a second home.

1. **Install.** Copy `mod.json` and `index.js` from that fixture folder into `<home>/mods/toy-beep/`. The home is `~/.reins`, or `REINS_HOME`. Reins reads the folder when it starts and after each change in Settings. The row says "needs trust".
2. **Preview.** Open Settings > Providers. The row under "Protocols and other mods" lists what the mod adds: the block `beep`, its operation `BEEP`, the event `beeped`, the attribute `times`, and its place under "Flow". Nothing has run.
3. **Trust.** Press Trust, read the prompt, and say yes. Reins sends the hash the row showed. A different hash is refused. The block now runs, and `beep` is in the block list under Flow.
4. **Restart.** Stop Reins and start it again. The block registers at start. Its hash still matches, so there is no prompt.
5. **Use.** Save a workflow and check it:

   ```
   ---
   reins: 1
   name: toy
   budget: { turns: 5, minutes: 5 }
   always: []
   ---

   ## beep
   times: 2

   ## phase one
   > go
   ```

   `reins doctor --no-probe` lists the loaded mods, with no model call. `reins run toy.reins.md` runs the workflow with your provider. The terminal prints `  beeped x2`, and the receipt counts `beeps 1`.
6. **Export.** In Settings > Providers, press Export on the toy-beep row. You get one JSON file with `mod.json` and `index.js`. It holds no key and nothing from the home.
7. **Import elsewhere.** On another machine, or with another `REINS_HOME`, open Settings > Providers and choose Import. The preview shows the same lines and the same hash, and nothing is registered yet. Press "Import without running its code" to install it as "needs trust", or "Trust and import" to run it at once.

A data block needs the same steps, except the trust. `toy-ask` runs no code, so it has no prompt.
