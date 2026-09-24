import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Decision, Engine, EngineEvent, EngineProbe, EngineSession, OpenOptions, ToolRequest, TurnResult } from '@reins/core';
import { startHookServer } from '../hooks.js';
import { killTree } from '../proc.js';
import { newNonce, trustNote } from './cards.js';
import { claudeCommand } from './find.js';
import { createStreamParser } from './stream.js';

export interface ClaudeConfig {
  /** The real claude binary (findClaude), or '' when none was found. */
  bin: string;
  model?: string;
  effort?: string;
  /** Asks the user about a tool call Claude Code would prompt for (plan 8.2 approvals). */
  onApprove: (req: ToolRequest) => Promise<Decision>;
  /** Every engine event as it happens, for live output. */
  onLive?: (ev: EngineEvent) => void;
  /** How long an interrupt may take before the process tree is killed (plan: 10 s). */
  interruptTimeoutMs?: number;
}

const CAPABILITIES = { midTurnSteer: 'hook', preToolDeny: true, resume: true } as const;
// PreToolUse only needs the tools that write; Windows names its shell tool PowerShell.
const GUARDED_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell';
// Run mcp.ts from source under tests and mcp.js from dist; Node runs either directly.
const MCP_SCRIPT = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../mcp.ts' : '../mcp.js', import.meta.url));

export function claudeEngine(cfg: ClaudeConfig): Engine {
  return {
    id: 'claude',
    probe: () => probeClaude(cfg.bin),
    open: (opts) => openSession(cfg, opts),
  };
}

async function openSession(cfg: ClaudeConfig, opts: OpenOptions): Promise<EngineSession> {
  if (!cfg.bin) throw new Error('claude was not found. Install Claude Code, or set REINS_CLAUDE to the claude binary.');
  const cwd = opts.cwd ?? process.cwd();
  const sessionId = opts.sessionId ?? randomUUID();
  const nonce = newNonce();

  let turnEvents: EngineEvent[] = [];
  const emit = (ev: EngineEvent) => {
    turnEvents.push(ev);
    cfg.onLive?.(ev);
  };
  const hooks = await startHookServer({
    cwd,
    policy: opts.policy,
    pendingCards: opts.pendingCards ?? (() => []),
    nonce,
    onApprove: opts.onApprove ?? cfg.onApprove,
    onEvent: emit,
  });

  // Settings, MCP config and the trust note go in as files: inline JSON breaks on Windows quoting.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-'));
  const hook = { type: 'http', url: hooks.hookUrl, timeout: 30 };
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: GUARDED_TOOLS, hooks: [hook] }],
    PostToolUse: [{ hooks: [hook] }],
  } }));
  const mcpFile = path.join(dir, 'mcp.json');
  // The approve URL (and its token) goes in env, not on the command line.
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { reins: {
    command: process.execPath, args: [MCP_SCRIPT], env: { REINS_APPROVE_URL: hooks.approveUrl },
  } } }));
  const noteFile = path.join(dir, 'reins-card-note.md');
  fs.writeFileSync(noteFile, trustNote(nonce));

  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...(opts.sessionId ? ['--resume', opts.sessionId] : ['--session-id', sessionId]),
    // Edits are allowed by Claude and enforced by our PreToolUse hook; the rest asks via approve.
    '--permission-mode', 'acceptEdits',
    '--permission-prompt-tool', 'mcp__reins__approve',
    '--mcp-config', mcpFile,
    '--settings', settingsFile,
    '--append-system-prompt-file', noteFile,
    ...(opts.model ?? cfg.model ? ['--model', (opts.model ?? cfg.model)!] : []),
    ...(cfg.effort ? ['--effort', cfg.effort] : []),
  ];
  const [cmd, cmdArgs] = claudeCommand(cfg.bin, args);
  // shell: false, always: through a shell or the npm shim an interrupt orphans claude.exe.
  const child = spawn(cmd, cmdArgs, {
    cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
  let dead: string | undefined;
  let lastTotal = 0;
  let current: { resolve: (r: TurnResult) => void; reject: (e: Error) => void } | undefined;
  let exited = false;
  const exit = new Promise<void>((resolve) => child.on('close', () => { exited = true; resolve(); }));

  const endTurn = (r: TurnResult) => {
    const c = current;
    current = undefined;
    c?.resolve(r);
  };
  const failTurn = (why: string) => {
    dead = why;
    const c = current;
    current = undefined;
    c?.reject(new Error(why));
  };

  child.on('error', (e) => failTurn(`claude could not start: ${e.message}`));
  child.on('close', (code) => failTurn(dead ?? `claude exited (code ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`));
  child.stdin.on('error', () => {}); // a write after exit is reported through 'close'

  const parse = createStreamParser();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const out = parse(m);
    for (const ev of out.events) emit(ev);
    if (out.result) {
      const cost = Math.max(0, out.result.totalCostUsd - lastTotal);
      lastTotal = out.result.totalCostUsd;
      const events = turnEvents;
      turnEvents = [];
      endTurn({ text: out.result.text, cost, events });
    }
  });

  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
  let interrupts = 0;

  return {
    sessionId,
    turn(text) {
      if (dead) return Promise.reject(new Error(`the claude session is dead: ${dead}`));
      if (current) return Promise.reject(new Error('a turn is already running'));
      return new Promise<TurnResult>((resolve, reject) => {
        current = { resolve, reject };
        send({ type: 'user', message: { role: 'user', content: text } });
      });
    },

    async interrupt() {
      if (!current || dead) return;
      const pending = current;
      send({ type: 'control_request', request_id: `reins-int-${++interrupts}`, request: { subtype: 'interrupt' } });
      const ended = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), cfg.interruptTimeoutMs ?? 10_000);
        const done = () => { clearTimeout(t); resolve(true); };
        const { resolve: r0, reject: j0 } = pending;
        pending.resolve = (r) => { done(); r0(r); };
        pending.reject = (e) => { done(); j0(e); };
      });
      if (await ended) return;
      // No result in time: kill the whole tree and end the turn with an error.
      const events = turnEvents;
      turnEvents = [];
      dead = 'claude did not stop after an interrupt, so Reins killed it';
      events.push({ type: 'error', message: dead });
      endTurn({ text: '', cost: 0, events });
      killTree(child.pid);
    },

    events: {
      // ponytail: live events go to ClaudeConfig.onLive; nothing in Phase 2 reads this stream.
      async *[Symbol.asyncIterator]() {},
    },

    async close() {
      dead ??= 'closed';
      child.stdin.end();
      const t = setTimeout(() => killTree(child.pid), 5_000);
      if (!exited) await exit;
      clearTimeout(t);
      await hooks.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `claude --version`, then a one-turn call; login state comes only from the CLI's own output (plan D4). */
export async function probeClaude(bin: string): Promise<EngineProbe> {
  const base = { capabilities: { ...CAPABILITIES } };
  if (!bin) {
    return { ...base, installed: false, loggedIn: false, problems: ['claude not found. Install Claude Code (npm i -g @anthropic-ai/claude-code), or set REINS_CLAUDE to the claude binary.'] };
  }
  const v = await capture(bin, ['--version'], 30_000);
  if (v.code !== 0) return { ...base, installed: false, loggedIn: false, problems: [`${bin} --version failed: ${v.err.trim() || v.out.trim()}`] };
  const version = /\d+\.\d+\.\d+/.exec(v.out)?.[0];

  const r = await capture(bin, ['-p', 'Reply with the word OK.', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], 120_000);
  const lines = r.out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const init = lines.find((m) => m.type === 'system' && m.subtype === 'init');
  const result = lines.find((m) => m.type === 'result');
  const text = `${result?.result ?? ''} ${r.err}`;
  // ponytail: the logged-out shape was never recorded (plan D4 forbids touching the login to make one), so this matches on words.
  const authError = /authenticat|log ?in|401|invalid api key/i.test(text) && result?.is_error !== false;
  const loggedIn = result && result.is_error === false ? true : authError ? false : 'unknown';
  const problems: string[] = [];
  if (loggedIn === false) problems.push('Not logged in. Open a terminal and run `claude`, then log in. Reins uses Claude Code\'s own login.');
  if (loggedIn === 'unknown') problems.push(`Could not tell whether claude is logged in: ${text.trim().slice(0, 200)}`);
  if (init && init.apiKeySource && init.apiKeySource !== 'none') problems.push(`claude is using an API key (${init.apiKeySource}), not the subscription login.`);
  return { ...base, installed: true, ...(version ? { version } : {}), loggedIn, problems };
}

function capture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const [cmd, a] = claudeCommand(bin, args);
    const c = spawn(cmd, a, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => killTree(c.pid), timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: 127, out, err: e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, err }); });
  });
}
