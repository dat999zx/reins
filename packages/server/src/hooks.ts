import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { checkTool, type Decision, type EngineEvent, type Policy, type ToolRequest } from '@reins/core';
import { wrapCard } from './claude/cards.js';

export interface HookServerOptions {
  cwd: string;
  policy: () => Policy;
  pendingCards: () => string[];
  nonce: string;
  onApprove: (req: ToolRequest) => Promise<Decision>;
  onEvent: (ev: EngineEvent) => void;
}

// Claude's documented limit for a hook's additionalContext.
const CONTEXT_LIMIT = 10_000;

/**
 * The endpoint Claude's HTTP hooks and the approval MCP call (plan 15b 2.3). Localhost only,
 * a per-run token in the path, and an exact Host check against DNS rebinding.
 */
export async function startHookServer(o: HookServerOptions) {
  const token = randomBytes(32).toString('hex');
  let host = '';

  const server = http.createServer((req, res) => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const route = /^\/(hook|approve)\/([0-9a-f]+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || req.headers.host !== host || !route || !sameToken(route[2]!, token)) {
      req.resume();
      return reply(403, { error: 'forbidden' });
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let msg: any;
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        msg = {};
      }
      // Claude treats a hook's non-2xx reply as a non-blocking error and runs the tool anyway, so a
      // crash here would open every guard. Fail closed: any error becomes a deny.
      const handler = route[1] === 'hook' ? onHook(msg) : onApproveCall(msg);
      handler.then((out) => reply(200, out), (err) => {
        const reason = `Blocked by Reins: internal error (${String(err?.message ?? err)}).`;
        o.onEvent({ type: 'hook', event: String(msg.hook_event_name ?? 'approve'), tool: String(msg.tool_name ?? ''), decision: 'deny', reason });
        reply(200, route[1] === 'hook'
          ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
          : { behavior: 'deny', message: reason });
      });
    });
  });

  async function onHook(msg: any): Promise<unknown> {
    const event = String(msg.hook_event_name ?? '');
    const tool = String(msg.tool_name ?? '');
    if (event === 'PreToolUse') {
      const reason = checkTool(o.policy(), tool, msg.tool_input, o.cwd);
      o.onEvent({ type: 'hook', event, tool, decision: reason ? 'deny' : 'allow', ...(reason ? { reason } : {}) });
      return reason
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
        : {};
    }
    if (event === 'PostToolUse') {
      const cards = o.pendingCards();
      o.onEvent({ type: 'hook', event, tool, decision: cards.length ? 'card' : 'pass' });
      if (!cards.length) return {};
      // ponytail: cards past the size limit are cut, not re-queued; a human-typed card is far shorter.
      const budget = Math.floor(CONTEXT_LIMIT / cards.length) - 400;
      const wrapped = cards.map((c) => {
        o.onEvent({ type: 'card_delivered', card: c, channel: 'mid-turn' });
        return wrapCard(c.length > budget ? c.slice(0, budget) + ' […cut]' : c, o.nonce);
      });
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: wrapped.join('\n\n') } };
    }
    o.onEvent({ type: 'hook', event, tool, decision: 'pass' });
    return {};
  }

  async function onApproveCall(msg: any): Promise<unknown> {
    const tool = String(msg.tool_name ?? '');
    const input = msg.input ?? {};
    // The approval tool only runs after PreToolUse passed, but a guard must hold even if it didn't.
    const reason = checkTool(o.policy(), tool, input, o.cwd);
    const d: Decision = reason ? { behavior: 'deny', message: reason } : await o.onApprove({ tool, input });
    o.onEvent({ type: 'hook', event: 'approve', tool, decision: d.behavior, ...(d.message ? { reason: d.message } : {}) });
    return d.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: d.message ?? 'Denied by the user in Reins.' };
  }

  function sameToken(a: string, b: string) {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  host = `127.0.0.1:${port}`;
  return {
    hookUrl: `http://${host}/hook/${token}`,
    approveUrl: `http://${host}/approve/${token}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
