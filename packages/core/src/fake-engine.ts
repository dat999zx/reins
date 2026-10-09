import type { Policy } from './compile.js';
import { checkTool } from './policy.js';

export interface EngineProbe {
  installed: boolean;
  version?: string;
  loggedIn: boolean | 'unknown';
  capabilities: {
    midTurnSteer: 'native' | 'hook' | 'none';
    preToolDeny: boolean;
    resume: boolean;
  };
  problems: string[];
}

export interface ToolRequest {
  tool: string;
  input: any;
}

export interface Decision {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface OpenOptions {
  cwd?: string;
  sessionId?: string;
  model?: string;
  readOnly?: boolean;
  policy: () => Policy;
  onApprove?: (req: ToolRequest) => Promise<Decision>;
  pendingCards?: () => string[];
}

export type EngineEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; tool: string; input: any }
  | { type: 'tool_result'; tool: string; output: any }
  | { type: 'refusal'; reason: string }
  | { type: 'card_delivered'; card: string; channel: 'mid-turn' | 'next-turn' }
  | { type: 'cost'; usd: number }
  | { type: 'error'; message: string }
  // The agent's running thinking estimate for this turn; claude sends no thinking text, only a count.
  | { type: 'thinking'; tokens: number }
  // One adapter-side control call (a hook or an approval), so every call lands in the run log.
  | { type: 'hook'; event: string; tool?: string; decision: string; reason?: string };

export interface TurnResult {
  text: string;
  cost?: number;
  events?: EngineEvent[];
}

export interface EngineSession {
  readonly sessionId: string;
  turn(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  events: AsyncIterable<EngineEvent>;
  close(): Promise<void>;
}

export interface Engine {
  readonly id: 'claude' | 'codex';
  probe(): Promise<EngineProbe>;
  open(opts: OpenOptions): Promise<EngineSession>;
}

export interface ScriptedTurn {
  events?: Array<{
    type: 'text' | 'tool_call' | 'tool_result' | 'refusal' | 'cost' | 'error';
    tool?: string;
    input?: any;
    output?: any;
    reason?: string;
    text?: string;
    usd?: number;
    message?: string;
  }>;
  text: string;
  cost?: number;
}

export class FakeEngine implements Engine {
  readonly id = 'claude' as const;
  receivedTexts: string[] = [];
  recordedPolicyChecks: Array<{ tool: string; input: any; policy: Policy }> = [];
  interrupted = false;
  /** Test hook: runs before each scripted tool call, i.e. while the turn is in flight. */
  onToolCall?: (tool: string) => void;

  private script: ScriptedTurn[];
  private currentTurnIndex = 0;

  constructor(script: ScriptedTurn[] = []) {
    this.script = [...script];
  }

  async probe(): Promise<EngineProbe> {
    return {
      installed: true,
      version: 'fake-1.0',
      loggedIn: true,
      capabilities: {
        midTurnSteer: 'hook',
        preToolDeny: true,
        resume: true,
      },
      problems: [],
    };
  }

  async open(opts: OpenOptions): Promise<EngineSession> {
    const sessionId = `fake-sess-${Date.now()}`;

    return {
      sessionId,
      turn: async (text: string): Promise<TurnResult> => {
        this.receivedTexts.push(text);
        const scripted = this.script[this.currentTurnIndex++] || {
          text: 'REINS: done',
        };

        const turnEvents: EngineEvent[] = [];

        if (scripted.events) {
          for (const ev of scripted.events) {
            if (ev.type === 'tool_call') {
              this.onToolCall?.(ev.tool!);
              const policy = opts.policy();
              this.recordedPolicyChecks.push({
                tool: ev.tool!,
                input: ev.input,
                policy,
              });

              const reason = checkTool(policy, ev.tool!, ev.input, opts.cwd ?? '');
              if (reason) {
                turnEvents.push({ type: 'refusal', reason });
                continue;
              }

              turnEvents.push(ev as EngineEvent);

              // Drain pending cards mid-turn
              if (opts.pendingCards) {
                const pending = opts.pendingCards();
                for (const c of pending) {
                  turnEvents.push({
                    type: 'card_delivered',
                    card: c,
                    channel: 'mid-turn',
                  });
                }
              }
            } else {
              turnEvents.push(ev as EngineEvent);
            }
          }
        }

        return {
          text: scripted.text,
          cost: scripted.cost,
          events: turnEvents,
        };
      },

      interrupt: async (): Promise<void> => {
        this.interrupted = true;
      },

      events: {
        [Symbol.asyncIterator]: async function* (this: any) {
          // not used in tests
        },
      },

      close: async (): Promise<void> => {},
    };
  }
}
