#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json` (plan 15b 2.8).
// It replays recorded turns from spike/fixtures (real claude 2.1.281 streams, not invented shapes)
// and calls Reins's HTTP hooks and approval MCP server at the points the real CLI does:
//   PreToolUse before a tool runs, the permission-prompt tool after that, PostToolUse after it ran.
// A hook deny or an approval deny replaces the recorded tool_result with the real CLI's denial shape
// (from claude-2.1.281-hook-deny.jsonl / -approval-deny.jsonl); an interrupt ends the turn with the
// shape recorded in claude-2.1.281-interrupt-ctl.jsonl.
//
// Configure with FAKE_CLAUDE_SCRIPT=<json file>:
//   { "log": "<jsonl file>", "delayMs": 20, "turns": [{ "fixture": "claude-2.1.281-turns.jsonl", "turn": 0,
//     "approve": true, "text": "final text override", "ignoreInterrupt": false, "delayMs": 200 }] }
// Turns past the list replay claude-2.1.281-turns.jsonl turn 0.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../spike/fixtures');
const RECORDED_CWD = 'D:\\coding\\reins-scratch';
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.281 (Claude Code)\n');
  process.exit(0);
}
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const script = process.env.FAKE_CLAUDE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8')) : { turns: [] };
const delayMs = script.delayMs ?? 10;
const log = (o) => { if (script.log) fs.appendFileSync(script.log, JSON.stringify(o) + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (line) => process.stdout.write(line + '\n');

const settings = arg('--settings') ? JSON.parse(fs.readFileSync(arg('--settings'), 'utf8')) : {};
const note = arg('--append-system-prompt-file') ? fs.readFileSync(arg('--append-system-prompt-file'), 'utf8') : '';
log({ kind: 'args', args: argv, cwd: process.cwd(), note, settings, pid: process.pid });

// ---- one-shot mode (probe): `claude -p "<prompt>" ...` with no stream-json input
if (!argv.includes('--input-format')) {
  for (const l of fixtureTurns('claude-2.1.281-turns.jsonl')[0]) out(l);
  process.exit(0);
}

// ---- the approval MCP server named in --mcp-config, started the way the CLI starts it
let mcp;
const mcpCfg = arg('--mcp-config') ? JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')) : { mcpServers: {} };
const reins = mcpCfg.mcpServers?.reins;
if (reins) {
  const child = spawn(reins.command, reins.args ?? [], { env: { ...process.env, ...(reins.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  mcp = { child, call };
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  await call('tools/list', {});
}

function fixtureTurns(name) {
  const cwdJson = JSON.stringify(process.cwd()).slice(1, -1);
  const recJson = JSON.stringify(RECORDED_CWD).slice(1, -1);
  const lines = fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean).map((l) => l.split(recJson).join(cwdJson));
  const turns = [[]];
  for (const l of lines) {
    turns[turns.length - 1].push(l);
    if (JSON.parse(l).type === 'result') turns.push([]);
  }
  return turns;
}

const interruptShape = fixtureTurns('claude-2.1.281-interrupt-ctl.jsonl')[0].map((l) => JSON.parse(l));
const shape = {
  controlResponse: interruptShape.find((m) => m.type === 'control_response'),
  rejected: interruptShape.find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result'),
  interrupted: interruptShape.find((m) => m.type === 'user' && m.message.content[0].type === 'text'),
  result: interruptShape.find((m) => m.type === 'result'),
  init: fixtureTurns('claude-2.1.281-interrupt-ctl.jsonl')[1].map((l) => JSON.parse(l)).find((m) => m.type === 'system' && m.subtype === 'init'),
};

function matcher(event, tool) {
  return (settings.hooks?.[event] ?? []).filter((h) => !h.matcher || new RegExp(`^(?:${h.matcher})$`).test(tool)).flatMap((h) => h.hooks);
}
async function hook(event, tool, input) {
  let res = {};
  for (const h of matcher(event, tool)) {
    const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: event, tool_name: tool, tool_input: input, session_id: sessionId, cwd: process.cwd() }) });
    res = await r.json();
    log({ kind: 'hook', event, tool, status: r.status, response: res });
  }
  return res;
}

const sessionId = arg('--session-id') ?? arg('--resume');
let totalCost = 0;
let turnIndex = 0;
let interruptReq;
const queue = [];
let wake;

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    log({ kind: 'interrupt', request_id: m.request_id });
    interruptReq = m.request_id;
  } else if (m.type === 'user') {
    log({ kind: 'user', text: m.message.content });
    queue.push(m);
  }
  wake?.();
}).on('close', () => { queue.push(null); wake?.(); });

const WRITE_OR_SHELL = /^(Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell)$/;

async function playTurn(spec) {
  const turns = fixtureTurns(spec.fixture);
  const lines = turns[spec.turn ?? 0];
  const prevTotal = (spec.turn ?? 0) > 0 ? JSON.parse(turns[spec.turn - 1].at(-1)).total_cost_usd : 0;
  const denied = new Map();
  const toolNames = new Map();
  let pendingTool;
  for (const raw of lines) {
    await sleep(spec.delayMs ?? delayMs);
    if (interruptReq && !spec.ignoreInterrupt) {
      out(JSON.stringify({ ...shape.controlResponse, response: { ...shape.controlResponse.response, request_id: interruptReq } }));
      if (pendingTool) {
        const rej = structuredClone(shape.rejected);
        rej.message.content[0].tool_use_id = pendingTool;
        out(JSON.stringify(rej));
      }
      out(JSON.stringify(shape.interrupted));
      totalCost += 0.001;
      out(JSON.stringify({ ...shape.result, total_cost_usd: totalCost }));
      out(JSON.stringify(shape.init));
      interruptReq = undefined;
      return;
    }
    const m = JSON.parse(raw);
    if (m.type === 'control_response') continue;
    if (m.type === 'result') {
      totalCost += m.total_cost_usd - prevTotal;
      out(JSON.stringify({ ...m, total_cost_usd: totalCost, ...(spec.text !== undefined ? { result: spec.text } : {}) }));
      return;
    }
    if (m.type === 'user' && Array.isArray(m.message?.content) && m.message.content[0]?.type === 'tool_result') {
      const block = m.message.content[0];
      pendingTool = undefined;
      const d = denied.get(block.tool_use_id);
      if (d) {
        out(JSON.stringify({ ...m, message: { ...m.message, content: [{ type: 'tool_result', content: d, is_error: true, tool_use_id: block.tool_use_id }] } }));
      } else {
        out(raw);
        await hook('PostToolUse', toolNames.get(block.tool_use_id), {});
      }
      continue;
    }
    out(raw);
    if (m.type === 'assistant') {
      for (const b of m.message.content.filter((x) => x.type === 'tool_use')) {
        toolNames.set(b.id, b.name);
        pendingTool = b.id;
        const pre = await hook('PreToolUse', b.name, b.input);
        if (pre.hookSpecificOutput?.permissionDecision === 'deny') {
          denied.set(b.id, `PreToolUse:${b.name} hook error: ${pre.hookSpecificOutput.permissionDecisionReason}`);
        } else if (spec.approve && mcp && WRITE_OR_SHELL.test(b.name)) {
          const r = await mcp.call('tools/call', { name: 'approve', arguments: { tool_name: b.name, input: b.input, tool_use_id: b.id } });
          const decision = JSON.parse(r.result.content[0].text);
          log({ kind: 'approve', tool: b.name, decision });
          if (decision.behavior === 'deny') denied.set(b.id, decision.message);
        }
      }
    }
  }
}

for (;;) {
  while (!queue.length) await new Promise((r) => (wake = r));
  const m = queue.shift();
  if (m === null) break;
  interruptReq = undefined;
  await playTurn(script.turns[turnIndex++] ?? { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 });
}
mcp?.child.stdin.end();
mcp?.child.kill();
process.exit(0);
