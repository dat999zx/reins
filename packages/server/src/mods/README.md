# Providers are mods

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
- A mod with code is imported but **does not run**. It waits as "needs trust". The prompt says: "This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author." Say yes only to code you have read or whose author you trust.
- Trust is by hash of every file. If one byte of one file changes, Reins asks again, and the new code does not run until you do. Removing a mod removes its trust, so the same files imported again ask again.
- A data mod has no prompt, because it runs nothing. It still never carries a key: export it, send it, import it, and the new home has to set its own key and give its own consent.

## Where keys live

- A key you set in Settings is stored in plain text in `<home>/secrets.json`. The file is private to your user on systems that support it, and is not encrypted. Programs running as you can read it.
- An environment variable (the name in `keyEnv`) always works instead, and is the safer choice on a shared machine.
- Reins hides every known key in what it shows, logs and saves: events, the conversation file, error text, command output and exports. Hiding is a safety net, not a promise: a command you approve can still print a key it finds.
- Removing a provider keeps its key in `secrets.json`, so installing it again finds it. Clear the key first if you want it gone.
