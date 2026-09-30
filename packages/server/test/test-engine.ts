import type { Decision, EngineEvent, EngineSession, OpenOptions } from '@reins/core';
import type { MakeEngine } from '../src/session.js';

export interface TestTurn {
  text?: string;                                                          // the result text (default 'ok')
  tools?: Array<{ tool: string; input?: unknown; approve?: boolean; hold?: boolean }>;
  hold?: boolean;                                                         // wait at the end of the turn
  reject?: string;                                                        // turn() rejects with this message
  error?: string;                                                         // the result carries an error event (never emitted live, as the adapter's interrupt timeout)
  lateApprove?: boolean;                                                  // an approval request arrives after the turn has ended
}

/** Scripted turns, one per turn() call (the same script for every session). `hold` waits for release() or interrupt(). */
export function testEngine(script: TestTurn[] = []) {
  const state = {
    opens: [] as OpenOptions[],
    turns: [] as string[],
    decisions: [] as Decision[],
    interrupts: 0,
    closes: 0,
    release: () => {},
    makeEngine: undefined as unknown as MakeEngine,
  };
  let nextId = 1;
  let turnDone: Promise<void> | undefined;
  let freeze: (() => void) | undefined;
  const wait = () => new Promise<void>((r) => { freeze = r; });
  state.release = () => freeze?.();

  state.makeEngine = ({ onApprove, onLive }) => ({
    id: 'claude',
    probe: async () => ({ installed: true, loggedIn: true, capabilities: { midTurnSteer: 'hook', preToolDeny: true, resume: true }, problems: [] }),
    open: async (opts) => {
      state.opens.push(opts);
      let interrupted = false;
      const session: EngineSession = {
        sessionId: opts.sessionId ?? `test-${nextId++}`,
        async turn(text) {
          state.turns.push(text);
          interrupted = false;
          let end!: () => void;
          turnDone = new Promise<void>((r) => { end = r; });
          try {
            const t = script.shift() ?? {};
            if (t.reject) throw new Error(t.reject);
            const events: EngineEvent[] = [];
            const emit = (e: EngineEvent) => { events.push(e); onLive(e); };
            for (const tool of t.tools ?? []) {
              if (interrupted) break;
              if (tool.hold) await wait();
              if (interrupted) break;
              const input = tool.input ?? {};
              emit({ type: 'tool_call', tool: tool.tool, input });
              for (const card of opts.pendingCards?.() ?? []) emit({ type: 'card_delivered', card, channel: 'mid-turn' });
              if (tool.approve) {
                const d = await onApprove({ tool: tool.tool, input });
                state.decisions.push(d);
                emit({ type: 'hook', event: 'approve', tool: tool.tool, decision: d.behavior });
                if (d.behavior === 'deny') emit({ type: 'refusal', reason: d.message ?? 'denied' });
              }
            }
            if (t.hold && !interrupted) await wait();
            const text2 = interrupted ? '' : (t.text ?? 'ok');
            emit({ type: 'text', text: text2 });
            if (t.error) events.push({ type: 'error', message: t.error });
            if (t.lateApprove) setTimeout(() => { void onApprove({ tool: 'Bash', input: { command: 'late' } }).then((d) => state.decisions.push(d)); }, 20);
            return { text: text2, cost: 0.01, events };
          } finally {
            end();
          }
        },
        // Like the real adapter (engine.ts:155-173): a turn that waits on an approval keeps the interrupt waiting until the question is settled.
        async interrupt() {
          interrupted = true;
          state.interrupts++;
          freeze?.();
          await turnDone;
        },
        events: { async *[Symbol.asyncIterator]() {} },
        async close() { state.closes++; },
      };
      return session;
    },
  });
  return state;
}
