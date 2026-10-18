// The approval MCP server Claude starts (`--permission-prompt-tool mcp__reins__approve`).
// Hand-rolled newline-delimited JSON-RPC, as proven in spike/approve-mcp.mjs; no MCP SDK.
// Node built-ins only, so Node can run this file straight from source (type stripping).
import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';

const TOOL = {
  name: 'approve',
  description: 'Permission prompt tool: asks the Reins user to allow or deny a tool call.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

/** Forward one approval to the run. node:http, not fetch: an approval may wait for the user far longer than fetch's timeouts. */
function forward(url: string, args: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const deny = (why: string) => resolve({ behavior: 'deny', message: `Reins could not ask the user (${why}), so this is denied.` });
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (res.statusCode === 200 && (d.behavior === 'allow' || d.behavior === 'deny')) resolve(d);
          else deny(`HTTP ${res.statusCode}`);
        } catch {
          deny('bad reply');
        }
      });
    });
    req.on('error', (e) => deny(e.message));
    req.end(JSON.stringify(args ?? {}));
  });
}

export function serveMcp(input: Readable, output: Writable, approveUrl: string): void {
  const send = (m: unknown) => output.write(JSON.stringify(m) + '\n');
  readline.createInterface({ input }).on('line', async (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return; // notifications need no answer
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'reins', version: '0.1.0' },
      } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [TOOL] } });
    } else if (m.method === 'tools/call' && m.params?.name === 'approve') {
      const decision = await forward(approveUrl, m.params.arguments);
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no such method: ${m.method}` } });
    }
  });
}

// Started directly by Claude (see the MCP config written in claude/engine.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveMcp(process.stdin, process.stdout, process.env.REINS_APPROVE_URL ?? '');
}
