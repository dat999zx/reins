// Minimal hand-rolled stdio MCP server (newline-delimited JSON-RPC), one tool `approve`.
// Hand-rolled because `npm i` was not pre-approved; the wire format is small. Throwaway.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PEND = path.join(import.meta.dirname, 'pending');
fs.mkdirSync(PEND, { recursive: true });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;

async function approve(args) {
  const id = `${Date.now()}-${++n}`;
  fs.writeFileSync(path.join(PEND, `${id}.json`), JSON.stringify(args, null, 2));
  const ans = path.join(PEND, `${id}.answer`);
  while (!fs.existsSync(ans)) await new Promise((r) => setTimeout(r, 200));
  const a = JSON.parse(fs.readFileSync(ans, 'utf8'));
  return a.behavior === 'allow'
    ? { behavior: 'allow', updatedInput: a.updatedInput ?? args.input }
    : { behavior: 'deny', message: a.message ?? 'Denied by Reins spike' };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'approve', version: '0' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'approve', description: 'Permission prompt tool',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
        required: ['tool_name', 'input'] } }] } });
  } else if (m.method === 'tools/call') {
    const r = await approve(m.params.arguments);
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
  }
});
