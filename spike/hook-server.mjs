// Hook server for P0.2/P0.3/P0.5: PreToolUse guard, PostToolUse card delivery. Throwaway.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startClaude, record, gitDiff, gitReset, FIX, SCRATCH } from './lib.mjs';

export const PORT = 47123;
const TMP = path.join(import.meta.dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

export function startHookServer(port = PORT) {
  const log = []; const cards = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let out = {};
      if (url.pathname === '/card') { cards.push(url.searchParams.get('text')); }
      else if (url.pathname === '/hook') {
        const body = JSON.parse(b || '{}');
        log.push(body);
        const fp = String(body.tool_input?.file_path ?? '');
        if (body.hook_event_name === 'PreToolUse' && /migrations[\\/]/.test(fp)) {
          out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
            permissionDecisionReason: 'Blocked by Reins: migrations/** is guarded.' } };
        } else if (body.hook_event_name === 'PostToolUse' && cards.length) {
          out = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: cards.splice(0).join('\n') } };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, log, cards, close: () => server.close() })));
}

export function writeSettings(name, obj) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
export function hooksBlock(port = PORT, type = 'http') {
  const h = type === 'http'
    ? { type: 'http', url: `http://127.0.0.1:${port}/hook`, timeout: 30 }
    : { type: 'command', command: `"D:/nodejs/node.exe" "${path.join(import.meta.dirname, 'hook-cmd.mjs').replace(/\\/g, '/')}"`, timeout: 30 };
  return { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [h] }],
    PostToolUse: [{ hooks: [{ ...h }] }] };
}

/** Run the "add column to migrations" prompt with the given settings. */
export async function runGuard(id, fixture, settings, hookType = 'http') {
  await gitReset();
  const hs = await startHookServer();
  const f = writeSettings(`${id}.json`, settings);
  const c = startClaude(['--permission-mode', 'acceptEdits', '--settings', f], { fixture });
  let r;
  try { r = await c.turn('Add a column retries to migrations/0001.sql.', 300_000); } catch (e) { r = { result: 'ERR ' + e.message }; }
  c.close();
  const diff = await gitDiff('migrations/');
  const tools = c.lines.filter((m) => m.type === 'user').flatMap((m) => m.message?.content ?? []).filter((x) => x.type === 'tool_result');
  const denied = tools.some((t) => /Blocked by Reins/.test(JSON.stringify(t.content)));
  const hookCalls = hs.log.filter((h) => h.hook_event_name === 'PreToolUse').map((h) => `${h.tool_name}:${h.tool_input?.file_path}`);
  hs.close(); c.child.kill();
  const blocked = diff === '';
  const mentions = /block|guard|denied|hook/i.test(String(r.result));
  record(id, blocked && denied && mentions,
    `hookType=${hookType} diff_empty=${blocked} denial_in_stream=${denied} reply_mentions_block=${mentions} preToolUse_calls=${JSON.stringify(hookCalls)} cost=${r.total_cost_usd} reply=${JSON.stringify(String(r.result).slice(0, 160))}`);
  await gitReset();
  return { blocked, denied, mentions };
}
