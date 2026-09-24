// The approval MCP server (plan 15b 2.3): wire format from spike/approve-mcp.mjs, no MCP SDK.
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { serveMcp } from '../src/mcp.js';
import { startHookServer } from '../src/hooks.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function server(decide: (tool: string) => { behavior: 'allow' | 'deny'; message?: string }) {
  const s = await startHookServer({
    cwd: '.', nonce: 'n', pendingCards: () => [], onEvent: () => {},
    policy: () => ({ mode: 'write', guards: ['migrations/**'], allowShell: true }),
    onApprove: async (r) => decide(r.tool),
  });
  close = s.close;
  return s;
}

function client(input: PassThrough, output: PassThrough) {
  const lines = readline.createInterface({ input: output });
  const waiting = new Map<number, (m: any) => void>();
  lines.on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  let id = 0;
  return (method: string, params?: unknown) => new Promise<any>((resolve) => {
    waiting.set(++id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

describe('approval MCP server', () => {
  it('speaks initialize, tools/list and tools/call, forwarding to the run', async () => {
    const s = await server((tool) => (tool === 'Edit' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no shell' }));
    const input = new PassThrough();
    const output = new PassThrough();
    serveMcp(input, output, s.approveUrl);
    const call = client(input, output);

    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.281' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'reins' } });
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await call('tools/list', {});
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['approve']);
    expect(list.result.tools[0].inputSchema.required).toEqual(['tool_name', 'input']);

    const allow = await call('tools/call', { name: 'approve', arguments: { tool_name: 'Edit', input: { file_path: 'a' }, tool_use_id: 't' } });
    expect(JSON.parse(allow.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { file_path: 'a' } });
    const deny = await call('tools/call', { name: 'approve', arguments: { tool_name: 'PowerShell', input: { command: 'x' } } });
    expect(JSON.parse(deny.result.content[0].text)).toEqual({ behavior: 'deny', message: 'no shell' });

    const unknown = await call('resources/list', {});
    expect(unknown.error.code).toBe(-32601);
  });

  it('fails closed: an unreachable Reins means deny', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveMcp(input, output, 'http://127.0.0.1:1/approve/00');
    const call = client(input, output);
    const r = await call('tools/call', { name: 'approve', arguments: { tool_name: 'Edit', input: {} } });
    expect(JSON.parse(r.result.content[0].text).behavior).toBe('deny');
  });

  it('runs as its own process from source, the way Claude starts it', async () => {
    const s = await server(() => ({ behavior: 'allow' }));
    const file = fileURLToPath(new URL('../src/mcp.ts', import.meta.url));
    const child = spawn(process.execPath, [file], { env: { ...process.env, REINS_APPROVE_URL: s.approveUrl }, stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      const call = client(child.stdin as unknown as PassThrough, child.stdout as unknown as PassThrough);
      const r = await call('tools/call', { name: 'approve', arguments: { tool_name: 'Edit', input: { file_path: 'b' } } });
      expect(JSON.parse(r.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { file_path: 'b' } });
    } finally {
      child.kill();
    }
  });
});
