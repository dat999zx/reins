// P0.4: permission-prompt-tool waits for Reins. argv[2]=deny|allow, argv[3]=hold seconds.
import fs from 'node:fs';
import path from 'node:path';
import { startClaude, record, gitDiff, gitReset } from './lib.mjs';

const mode = process.argv[2] || 'deny';
const holdS = Number(process.argv[3] ?? 5);
const id = mode === 'deny' ? 'P0.4a' : 'P0.4b';
const PEND = path.join(import.meta.dirname, 'pending');
fs.rmSync(PEND, { recursive: true, force: true }); fs.mkdirSync(PEND, { recursive: true });
const cfg = path.join(import.meta.dirname, 'tmp', 'mcp.json');
fs.mkdirSync(path.dirname(cfg), { recursive: true });
fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { approve: { command: 'D:/nodejs/node.exe',
  args: [path.join(import.meta.dirname, 'approve-mcp.mjs').replace(/\\/g, '/')] } } }));

await gitReset();
const c = startClaude(['--permission-prompt-tool', 'mcp__approve__approve', '--mcp-config', cfg],
  { fixture: `claude-2.1.281-approval-${mode}${holdS > 10 ? '-hold' : ''}.jsonl` });
const p = c.turn('Edit src/upload.mjs to add a retry loop so upload() retries flakyPut() until it succeeds (max 5 attempts).', (holdS + 240) * 1000);
let seen = null, t0 = 0, diffWhileWaiting = null, waitedMs = 0;
const poll = setInterval(async () => {
  if (seen) return;
  const f = fs.readdirSync(PEND).find((x) => x.endsWith('.json'));
  if (!f) return;
  seen = f; t0 = Date.now();
  const req = JSON.parse(fs.readFileSync(path.join(PEND, f), 'utf8'));
  console.log('pending request:', JSON.stringify(req).slice(0, 300));
  setTimeout(async () => {
    diffWhileWaiting = await gitDiff('src/');
    waitedMs = Date.now() - t0;
    const ans = mode === 'deny' ? { behavior: 'deny', message: 'Reins says no.' } : { behavior: 'allow' };
    fs.writeFileSync(path.join(PEND, f.replace('.json', '.answer')), JSON.stringify(ans));
  }, holdS * 1000);
}, 300);
let r;
try { r = await p; } catch (e) { r = { result: 'ERR ' + e.message }; }
clearInterval(poll); c.close();
const diff = await gitDiff('src/');
const req = seen ? JSON.parse(fs.readFileSync(path.join(PEND, seen), 'utf8')) : null;
const toolResults = c.lines.filter((m) => m.type === 'user').flatMap((m) => m.message?.content ?? []).filter((x) => x.type === 'tool_result');
const pass = !!seen && diffWhileWaiting === '' && (mode === 'deny' ? diff === '' : diff !== '') && r.subtype === 'success';
record(id, pass, `mode=${mode} hold_s=${holdS} waited_ms=${waitedMs} request_seen=${!!seen} request_keys=${JSON.stringify(req && Object.keys(req))} ` +
  `tool=${req?.tool_name} diff_during_wait_empty=${diffWhileWaiting === ''} diff_after=${diff ? 'changed' : 'unchanged'} result_subtype=${r.subtype} ` +
  `tool_result=${JSON.stringify(toolResults.map((t) => t.content).slice(0, 2)).slice(0, 200)} cost=${r.total_cost_usd} reply=${JSON.stringify(String(r.result).slice(0, 120))}`);
await gitReset();
c.child.kill();
process.exit(0);
