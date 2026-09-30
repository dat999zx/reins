import type { FakeEngine, Run, RunStatus, Step, Workflow } from '../src/index.js';

export const step = (id: string, kind: Step['kind'], over: Partial<Step> = {}): Step =>
  ({ id, kind, attrs: {}, cards: [], links: [], ...over });
export const phase = (id: string, prompt = 'do it', over: Partial<Step> = {}): Step =>
  step(id, 'phase', { title: id, prompt, ...over });
export const workflow = (steps: Step[], over: Partial<Workflow> = {}): Workflow =>
  ({ version: 1, name: 't', budget: { turns: 20, minutes: 20 }, always: [], steps, autos: [], ...over });

export async function finish(run: Run): Promise<RunStatus> {
  while (run.status === 'running') await run.step();
  return run.status;
}

/** Counts the `interrupt()` calls on every session the engine opens (a FakeEngine only keeps a boolean). */
export function countInterrupts(engine: FakeEngine) {
  const n = { count: 0 };
  const open = engine.open.bind(engine);
  engine.open = async (o) => {
    const s = await open(o);
    const interrupt = s.interrupt.bind(s);
    s.interrupt = async () => { n.count++; await interrupt(); };
    return s;
  };
  return n;
}

/** A judge that waits: `started` resolves when it is asked, `release` answers it. */
export function heldJudge() {
  let release!: (v: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const judge = () => new Promise<boolean>((r) => { release = r; entered(); });
  return { judge, started, release: (v: boolean) => release(v) };
}
