// The neutral shapes the API agent loop and both wires share. Plain JSON: a conversation file stores them as they are.

/** Unknown fields a provider sent that come back unchanged on the next request (spec S20). */
export type Extra = Record<string, unknown>;

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string; extra?: Extra }
  | { type: 'tool_call'; id: string; name: string; args: unknown; extra?: Extra }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean };

export interface Msg {
  role: 'user' | 'assistant';
  blocks: Block[];
  /** Unknown fields of the provider's whole assistant message (from the `done` event), sent back unchanged. */
  extra?: Extra;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON Schema object. */
  schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools?: ToolSpec[];
  effort?: string;
  maxOutput?: number;
}

/** Tokens of one model call. `input` excludes cache reads and writes (spec 4.7); `reasoning` is part of `output`. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type WireEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /** Once, complete. `args` is the raw JSON text; the loop parses it. */
  | { type: 'tool_call'; id: string; name: string; args: string; extra?: Extra }
  | { type: 'usage'; usage: Usage }
  /** The last event. `extra`: unknown fields of the whole message. */
  | { type: 'done'; stop?: string; extra?: Extra };
