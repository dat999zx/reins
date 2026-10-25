import { FakeEngine, type Engine, type EngineSession, type OpenOptions, type ScriptedTurn } from '../src/fake-engine.js';
import type { SubagentOpen, SubagentOpened } from '../src/run.js';
import type { Hold } from './m1-harness.js';

export interface SessionStats {
  opened: number;
  closed: number;
  interrupts: number;
  /** Every text sent to turn(), in order. */
  texts: string[];
}

type End = 'go' | 'interrupted';

/**
 * A fake engine whose sessions are independent: each has its own script and its own hold, so a test can order two sessions that run at once
 * (FakeEngine shares one script index, and its hold is a plain await). Session ids: `<scenario>-main-<n>`, `<scenario>-sub-<step>`; a resumed id is kept.
 * A held turn ends like a real provider's: `interrupt()` ends it with empty text and no total (with `pendingApproval`, with the session's last total),
 * `close()` rejects it with Error "closed". The engine id is the neutral `'test'`.
 */
export function m2harness(scenario: string, options: { pendingApproval?: boolean } = {}) {
  const scripts = new Map<string, ScriptedTurn[]>();
  const queued = new Map<string, Array<{ arrive(): void; go: Promise<End> }>>();
  const live = new Map<string, { settle(how: End): void; fail(e: Error): void }>();
  const stats = new Map<string, SessionStats>();
  const fakes = new Map<string, FakeEngine>();
  const opened: string[] = [];
  const subagentOpens: SubagentOpen[] = [];
  let mains = 0;
  let t = 0;

  const statsOf = (id: string): SessionStats => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { opened: 0, closed: 0, interrupts: 0, texts: [] }));
    return s;
  };

  const mk = (id: string, o: OpenOptions): EngineSession => {
    const s = statsOf(id);
    s.opened++;
    opened.push(id);
    let inner: EngineSession | undefined;
    let total = 0;
    return {
      sessionId: id,
      turn: async (text) => {
        s.texts.push(text);
        const h = queued.get(id)?.shift();
        if (h) {
          h.arrive();
          const how = await h.go;   // rejects with "closed", or with what fail() was given
          if (how === 'interrupted') return { text: '', ...(options.pendingApproval ? { total } : {}) };
        }
        if (!inner) {
          const fake = new FakeEngine(scripts.get(id));
          fakes.set(id, fake);
          inner = await fake.open(o);
        }
        const r = await inner.turn(text);
        if (r.total !== undefined) total = r.total;
        return r;
      },
      interrupt: async () => {
        s.interrupts++;
        live.get(id)?.settle('interrupted');
      },
      events: { [Symbol.asyncIterator]: async function* () {} },
      close: async () => {
        s.closed++;
        live.get(id)?.fail(new Error('closed'));
      },
    };
  };

  const engine: Engine = {
    id: 'test',
    probe: async () => ({ installed: true, version: 'test-1.0', loggedIn: true, capabilities: { midTurnSteer: 'hook', preToolDeny: true, resume: true }, problems: [] }),
    open: async (o) => mk(o.sessionId ?? `${scenario}-main-${++mains}`, o),
  };

  const openSubagent = async (o: SubagentOpen): Promise<SubagentOpened> => {
    subagentOpens.push(o);
    const { step, title: _title, reasoning, ...rest } = o;
    const session = mk(o.sessionId ?? `${scenario}-sub-${step}`, { ...rest, ...(reasoning ? { effort: reasoning } : {}) });
    return { session, ...(o.model ? { model: o.model } : {}) };
  };

  return {
    engine,
    openSubagent,
    now: () => (t += 1000),
    /** Every SubagentOpen the run passed, as given. */
    subagentOpens,
    /** Session ids in the order they were opened (a reopened id appears again). */
    get opened() { return [...opened]; },
    /** The scripted turns this session answers with, in order; set before its first turn. Past the end: `REINS: done`, as FakeEngine. */
    script(id: string, ...turns: ScriptedTurn[]) { scripts.set(id, turns); },
    /** The next turn of THIS session waits until released, failed, interrupted or closed. */
    hold(id: string): Hold {
      let arrive!: () => void;
      let settle!: (how: End) => void;
      let fail!: (e: Error) => void;
      const started = new Promise<void>((r) => (arrive = r));
      const go = new Promise<End>((res, rej) => { settle = res; fail = rej; });
      go.catch(() => {});   // a hold failed before its turn arrives is not an unhandled rejection
      const wrapped = {
        arrive: () => { live.set(id, { settle, fail }); arrive(); },
        go: go.finally(() => live.delete(id)),
      };
      wrapped.go.catch(() => {});
      queued.set(id, [...(queued.get(id) ?? []), wrapped]);
      return { started, release: () => settle('go'), fail: (e) => fail(e) };
    },
    /** Counts for one session (zero for an id never opened). */
    stats: (id: string): SessionStats => ({ ...statsOf(id), texts: [...statsOf(id).texts] }),
    /** The FakeEngine that answered this session's turns (policy checks, tool events); absent before its first scripted turn. */
    fake: (id: string) => fakes.get(id),
  };
}
