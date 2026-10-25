// The toy wire: a code mod with a fixed script and no thinking.
// Round 1 (no tool result in the history yet): one shell call that needs the user's yes.
// Round 2 (the result is there): an answer with the result and the provider's raw reply in it, and a usage count so a cost is worked out.
// It does send one request per round through `host.send`, so the key, the consent and the redaction are all in the path.
import fs from 'node:fs';
import process from 'node:process';

// The test sets TOY_MARKER in the env it starts the mods with; the file shows the code ran, and how many times.
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

// A code mod default-exports this; it is called once with `{ env, registerProtocol }`.
export default function activate(api) {
  api.registerProtocol({ id: 'toy-echo', conversation: 'reins', wire });
}
