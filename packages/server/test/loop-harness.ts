// Shared setup of the loop tests: the fake provider, a manifest per wire, a host that sends through makeSend, and a session opener.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Engine, EngineEvent, EngineSession, OpenOptions } from '@reins/core';
import { startMods } from '../src/engines.js';
import { loopEngine, type LoopDeps } from '../src/loop/engine.js';
import type { EngineHost, Mods, Protocol, ProviderManifest, Wire } from '../src/mods/types.js';
import { Redactor, StreamRedactor, readSecrets, redactCut, keyStatus, setKey } from '../src/secrets.js';
import { makeSend } from '../src/send.js';
import { startFakeProvider, type FakeReply } from './fake-provider.js';
import { tempHome } from './mods-harness.js';

/** A fresh folder for a loop test, real path. Its name is lowercase hex: the name is in the system prompt, and a random mixed-case suffix (`QOWQ1n`) can hold a marker such as `Q1` or `U1` that a test asserts is absent from the request (macOS CI failed twice on it). */
export function loopTmp(prefix: string): string {
  const d = path.join(os.tmpdir(), prefix + randomBytes(4).toString('hex'));
  fs.mkdirSync(d);
  return fs.realpathSync.native(d);
}

export const KEY = 'sk-test-0123456789abcdef';
export type WireId = 'openai-chat' | 'anthropic-messages';
export const WIRES: WireId[] = ['openai-chat', 'anthropic-messages'];

/** Usage of one call on each wire: 60 input, 30 cache read, 10 cache write, 20 output (120 in all). */
export const USAGE_120: Record<WireId, Record<string, unknown>> = {
  'openai-chat': { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, cache_creation_input_tokens: 10 },
  'anthropic-messages': { input_tokens: 60, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 20 },
};
export const PRICE = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 };
export const COST_120 = (60 * 1 + 20 * 2 + 30 * 0.5 + 10 * 1.25) / 1e6;

export interface Rig {
  fake: Awaited<ReturnType<typeof startFakeProvider>>;
  p: ProviderManifest;
  host: EngineHost;
  live: EngineEvent[];
  slept: number[];
  state: { max: number };
  engine: Engine;
  mods: Mods;
  wire: Wire;
  open(o?: Partial<OpenOptions>): Promise<EngineSession>;
  push(...r: FakeReply[]): void;
  cleanup(): Promise<void>;
}

export async function rig(wireId: WireId, o: {
  strictPairs?: boolean; toolBlocksFail?: boolean; manifest?: Partial<ProviderManifest>; noKey?: boolean; keyless?: boolean; max?: number; wire?: Wire;
  deps?: LoopDeps; host?: Partial<EngineHost>;
} = {}): Promise<Rig> {
  const home = tempHome();
  const fake = await startFakeProvider({ ...(o.strictPairs ? { strictPairs: true } : {}), ...(o.toolBlocksFail ? { toolBlocksFail: true } : {}) });
  if (!o.noKey) setKey(home.home, 'p', KEY);
  const mods = await startMods({ dir: home.home, env: {} });
  const wire = o.wire ?? (mods.registry.get<Protocol>('protocol-impl', wireId) as Extract<Protocol, { conversation: 'reins' }>).wire;
  const auth = wireId === 'openai-chat' ? { style: 'bearer', keyEnv: ['P_API_KEY'] } : { style: 'header', header: 'x-api-key', keyEnv: ['P_API_KEY'] };
  const p: ProviderManifest = {
    reins: 1, id: 'p', kind: 'provider', version: '1', label: 'Fake', protocol: wireId,
    baseUrl: wireId === 'openai-chat' ? `${fake.url}/v1` : fake.url,
    ...(o.keyless ? {} : { auth }),
    defaultModel: 'm', models: [{ id: 'm', context: 1000, maxOutput: 100, price: PRICE }], ...o.manifest,
  };
  home.grantConsent(p.id, new URL(fake.url).origin);
  const redactor = new Redactor({ home: home.home, env: {}, keyEnvNames: () => ['P_API_KEY'] });
  const send = makeSend({ secrets: () => readSecrets(home.home), env: {}, redactor, consent: () => true });
  const live: EngineEvent[] = [];
  const state = { max: o.max ?? 200 };
  const host: EngineHost = {
    env: {}, home: home.home, onApprove: async () => ({ behavior: 'allow' }), onLive: (e) => live.push(e), send,
    redact: (t, max) => redactCut(redactor, t, max),
    redactAll: (t) => redactor.redact(t),
    redactStream: () => new StreamRedactor(redactor),
    holdsSecret: (t) => redactor.has(t),
    key: (m) => keyStatus(m, readSecrets(home.home), {}),
    settings: { get maxCallsPerTurn() { return state.max; } },
    ...o.host,
  };
  const slept: number[] = [];
  const deps: LoopDeps = { sleep: async (ms) => void slept.push(ms), random: () => 0, ...o.deps };
  const engine = loopEngine(p, wire, host, deps);
  const sessions: EngineSession[] = [];
  return {
    fake, p, host, live, slept, state, engine, mods, wire,
    async open(x = {}) {
      const s = await engine.open({ policy: () => ({}) as never, ...x });
      sessions.push(s);
      return s;
    },
    push: (...r) => fake.push(...r),
    async cleanup() {
      for (const s of sessions) await s.close();
      mods.dispose();
      await fake.close();
      home.cleanup();
    },
  };
}

/** The tool results of a request body, in order, as `{ id, content }`, on either wire. */
export function toolResults(body: any): Array<{ id: string; content: string }> {
  const out: Array<{ id: string; content: string }> = [];
  for (const m of body.messages) {
    if (m.role === 'tool') out.push({ id: m.tool_call_id, content: m.content });
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result') out.push({ id: b.tool_use_id, content: b.content });
  }
  return out;
}

export const types = (ev: EngineEvent[] | undefined) => (ev ?? []).map((e) => e.type);
/** A call to a real tool whose answer is a fixed plain result: the file is not there. */
export const MISSING = 'reins-no-such-file.txt';
export const MISSING_RESULT = `File not found: ${MISSING}`;
export const toolReply = (n = 0): FakeReply => ({ toolCalls: [{ id: `c${n}`, name: 'Read', args: JSON.stringify({ file_path: MISSING }) }] });
