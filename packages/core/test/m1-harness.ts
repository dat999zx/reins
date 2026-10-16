import { FakeEngine, type ScriptedTurn, type EngineSession, type OpenOptions } from '../src/fake-engine.js';
import type { Cond } from '../src/model.js';
import type { CommandResult, SubagentOpen, SubagentOpened } from '../src/run.js';

export type HoldName = 'open' | 'turn' | 'judge' | 'command' | 'recall' | 'store';

/** One held await. `started` resolves when the call arrives. `release(value)` lets it go: judge, command, recall and store answer with `value` (the default answer when it is undefined); open and turn go on to the real call. */
export interface Hold {
  started: Promise<void>;
  release(value?: unknown): void;
  fail(err: Error): void;
}

type Gate = { arrive(): void; done: Promise<unknown> };

/** A fake engine with fixed session ids (`<scenario>-main-<n>`, `<scenario>-sub-<step>`), a fixed clock, and awaits a test can hold. */
export function harness(scenario: string, script: ScriptedTurn[] = []) {
  const engine = new FakeEngine(script);
  const queued: Record<HoldName, Gate[]> = { open: [], turn: [], judge: [], command: [], recall: [], store: [] };
  let mains = 0;
  let t = 0;

  /** The next hold of this kind, if the test set one: wait for it and return its value. */
  const wait = async (name: HoldName): Promise<{ held: boolean; value?: unknown }> => {
    const g = queued[name].shift();
    if (!g) return { held: false };
    g.arrive();
    return { held: true, value: await g.done };
  };

  const wrap = async (inner: Promise<EngineSession>, sessionId: string): Promise<EngineSession> => {
    const s = await inner;
    return { ...s, sessionId, turn: async (text) => { await wait('turn'); return s.turn(text); } };
  };

  // FakeEngine keeps its own receivedTexts, opens and script; only open() changes.
  const realOpen = engine.open.bind(engine);
  engine.open = async (o: OpenOptions) => {
    await wait('open');
    const id = o.sessionId ?? `${scenario}-main-${++mains}`;
    return wrap(realOpen(o), id);
  };

  const openSubagent = async (o: SubagentOpen): Promise<SubagentOpened> => {
    await wait('open');
    const { step, title: _title, reasoning, ...rest } = o;
    const session = await wrap(realOpen({ ...rest, ...(reasoning ? { effort: reasoning } : {}) }), o.sessionId ?? `${scenario}-sub-${step}`);
    return { session, ...(o.model ? { model: o.model } : {}) };
  };

  const answer = async <T>(name: HoldName, fallback: T): Promise<T> => {
    const r = await wait(name);
    return r.held && r.value !== undefined ? (r.value as T) : fallback;
  };

  return {
    engine,
    openSubagent,
    now: () => (t += 1000),
    judge: (_c: Cond, _e: { lastText: string }) => answer<boolean>('judge', true),
    commandRunner: (_cmd: string) => answer<Pick<CommandResult, 'exitCode'> & { stdout: string; stderr: string }>('command', { exitCode: 0, stdout: '', stderr: '' }),
    recall: (_topics: string[]) => answer<string[]>('recall', []),
    store: async (_what: string, _summary: string) => { await wait('store'); },
    /** The next call of this kind waits until the test releases or fails it. */
    hold(name: HoldName): Hold {
      let arrive!: () => void;
      let release!: (v: unknown) => void;
      let fail!: (e: Error) => void;
      const started = new Promise<void>((r) => (arrive = r));
      const done = new Promise<unknown>((res, rej) => { release = res; fail = rej; });
      queued[name].push({ arrive, done });
      return { started, release: (v) => release(v), fail: (e) => fail(e) };
    },
  };
}
