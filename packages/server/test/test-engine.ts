import type { Decision, EngineEvent, EngineSession, OpenOptions, TurnResult } from '@reins/core';
import type { MakeEngine } from '../src/session.js';

export interface TestTurn {
  text?: string;                                                          // the result text (default 'ok')
  tools?: Array<{ tool: string; input?: unknown; approve?: boolean; hold?: boolean }>;
  hold?: boolean;                                                         // wait at the end of the turn
  reject?: string;                                                        // turn() rejects with this message
  error?: string;                                                         // the result carries an error event (never emitted live, as the adapter's interrupt timeout)
  lateApprove?: boolean;                                                  // an approval request arrives after the turn has ended
  usage?: number;                                                         // emit a usage event with this context size after the text
  window?: number;                                                        // that usage event's window (default 1,000,000)
  cost?: number | null;                                                   // the turn's cost (default 0.01); null = not known
  total?: number;                                                         // the provider's raw running total after the turn
  models?: Record<string, number>;                                        // the turn's cost per model, as the adapter splits it
  totals?: Record<string, number>;                                        // the provider's raw per-model running totals after the turn
  model?: string;                                                         // the usage event's model (default 'm')
  isError?: boolean;                                                      // the result is an error that no interrupt asked for
  compacted?: { before?: number; after?: number };                        // a compact() entry: the provider's figures (default 1000 and 100)
}

/** Scripted turns, one per turn() call (the same script for every session). `hold` waits for release() or interrupt(). */
export function testEngine(script: TestTurn[] = []) {
  const state = {
    opens: [] as OpenOptions[],
    turns: [] as string[],
    compacts: 0,
    decisions: [] as Decision[],
    interrupts: 0,
    closes: 0,
    release: () => {},
    holdClose: () => {},
    releaseClose: () => {},
    makeEngine: undefined as unknown as MakeEngine,
  };
  let closeGate: Promise<void> | undefined;
  let openCloseGate: (() => void) | undefined;
  state.holdClose = () => { closeGate = new Promise<void>((r) => { openCloseGate = r; }); };
  state.releaseClose = () => { openCloseGate?.(); closeGate = undefined; };
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
      // One body for turn() and compact(): a compaction shifts a script entry too, but is no message (state.compacts, not state.turns).
      const run = async (text: string, compact: boolean): Promise<TurnResult> => {
        if (compact) state.compacts++;
        else state.turns.push(text);
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
          const text2 = interrupted || compact ? '' : (t.text ?? 'ok');
          if (compact) {
            if (!interrupted) emit({ type: 'compacted', trigger: 'manual', ...(t.compacted ?? { before: 1000, after: 100 }) });
          } else {
            emit({ type: 'text', text: text2 });
            if (t.usage !== undefined) emit({ type: 'usage', model: t.model ?? 'm', used: t.usage, window: t.window ?? 1_000_000 });
          }
          if (t.error) events.push({ type: 'error', message: t.error });
          if (t.lateApprove) setTimeout(() => { void onApprove({ tool: 'Bash', input: { command: 'late' } }).then((d) => state.decisions.push(d)); }, 20);
          return {
            text: text2, events,
            ...(t.cost === null ? {} : { cost: t.cost ?? 0.01 }),
            ...(t.total !== undefined ? { total: t.total } : {}),
            ...(t.models ? { models: t.models } : {}),
            ...(t.totals ? { totals: t.totals } : {}),
            ...(t.isError ? { isError: true } : {}),
          };
        } finally {
          end();
        }
      };
      const session: EngineSession = {
        sessionId: opts.sessionId ?? `test-${nextId++}`,
        turn: (text) => run(text, false),
        compact: () => run('/compact', true),
        // Like the real adapter (engine.ts:155-173): a turn that waits on an approval keeps the interrupt waiting until the question is settled.
        async interrupt() {
          interrupted = true;
          state.interrupts++;
          freeze?.();
          await turnDone;
        },
        events: { async *[Symbol.asyncIterator]() {} },
        async close() { state.closes++; await closeGate; },
      };
      return session;
    },
  });
  return state;
}
