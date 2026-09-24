// P0.5: (a) live card via PostToolUse additionalContext, (b) SIGINT, (c) stream-json control_request interrupt.
import { spawnSync } from 'node:child_process';
import { startClaude, record, gitReset } from './lib.mjs';
import { startHookServer, hooksBlock, writeSettings } from './hook-server.mjs';

const isTool = (m) => m.type === 'assistant' && (m.message?.content ?? []).some((x) => x.type === 'tool_use');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = arg => arg;
const only = process.argv[2]; // a|b|c

// ---- (a) card
if (!only || only === 'a') {
  await gitReset();
  const hs = await startHookServer();
  const f = writeSettings('p05.json', { hooks: hooksBlock() });
  const c = startClaude(['--settings', f, '--permission-mode', 'acceptEdits'], { fixture: 'claude-2.1.281-card.jsonl' });
  const first = c.next(isTool, 120_000);
  const p = c.turn('Read every file in src/ and test.mjs one at a time (one Read call per file, sequentially), then summarise them in two sentences.', 300_000);
  await first;
  await fetch(`http://127.0.0.1:${hs.server.address().port}/card?text=${encodeURIComponent('Reins card: end your final answer with the word PINEAPPLE.')}`, { method: 'POST' });
  let r; try { r = await p; } catch (e) { r = { result: 'ERR ' + e.message }; }
  const post = hs.log.filter((h) => h.hook_event_name === 'PostToolUse').length;
  c.close(); c.child.kill(); hs.close();
  const ends = /PINEAPPLE\W*$/i.test(String(r.result).trim());
  record('P0.5a', ends, `final_ends_PINEAPPLE=${ends} contains=${/PINEAPPLE/i.test(String(r.result))} postToolUse_calls=${post} cards_left=${hs.cards.length} cost=${r.total_cost_usd} tail=${JSON.stringify(String(r.result).slice(-100))}`);
}

// ---- (b) SIGINT via child.kill
async function interruptTest(id, fixture, how) {
  const c = startClaude(['--permission-mode', 'bypassPermissions'], { fixture });
  const first = c.next(isTool, 120_000);
  const p = c.turn('Run the shell command `ping -n 60 127.0.0.1` and then reply DONE.', 200_000);
  await first; await sleep(2000);
  const note = await how(c);
  const t0 = Date.now();
  let r = null;
  r = await Promise.race([p, sleep(20_000).then(() => null)]);
  const gotResult = !!r;
  let second = null;
  if (gotResult) {
    try { second = await c.turn('Reply with exactly the word AFTER and nothing else.', 90_000); } catch { /* recorded below */ }
  }
  const procs = spawnSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.trim();
  c.child.stdin.end();
  spawnSync('taskkill', ['/T', '/F', '/PID', String(c.child.pid)]);
  record(id, gotResult && /AFTER/.test(String(second?.result)),
    `${note} result_after_ms=${gotResult ? Date.now() - t0 : 'none in 20s'} result_subtype=${r?.subtype} is_error=${r?.is_error} next_turn=${JSON.stringify(second?.result ?? null)} claude_exe_procs_left=${procs.split('\n').length}`);
}
if (!only || only === 'b') {
  await interruptTest('P0.5b', 'claude-2.1.281-sigint.jsonl', async (c) => `child.kill(SIGINT) returned ${c.child.kill('SIGINT')};`);
}
// ---- (c) control_request interrupt on stdin
if (!only || only === 'c') {
  await interruptTest('P0.5c', 'claude-2.1.281-interrupt-ctl.jsonl', async (c) => {
    c.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'req_int_1', request: { subtype: 'interrupt' } }) + '\n');
    const resp = await c.next((m) => m.type === 'control_response', 10_000).catch(() => null);
    return `control_request interrupt; control_response=${JSON.stringify(resp)?.slice(0, 250)};`;
  });
}
process.exit(0);
