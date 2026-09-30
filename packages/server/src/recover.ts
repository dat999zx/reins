import type { LogRow, Store } from './store.js';

const ENDED = new Set(['run_finished', 'run_stopped']);
const data = (r: LogRow) => (r.data ?? {}) as Record<string, any>;

// These rows empty the session's in-memory card queue (plan 15d 3b.7 lines 1558-1562).
const emptiesQueue = (r: LogRow) =>
  r.type === 'cards_unsent' || r.type === 'run_started'
  || (r.type === 'message' && data(r).fromCards === true)
  || (r.type === 'note' && r.runId !== undefined)
  || (r.type === 'engine' && r.runId === undefined && data(r).type === 'card_delivered');

/** The restart rules (plan 15d 3b.7 lines 1554-1564): what a crash or a stop left half-done, said in the log once. */
export function recover(store: Store): void {
  for (const s of store.listSessions()) {
    const rows = store.readLog(s.id);
    const add = (type: string, payload: unknown, runId?: string) => store.appendLog(s.id, { type, data: payload, ...(runId ? { runId } : {}) });
    const lastIndex = (pred: (r: LogRow) => boolean) => {
      for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i]!)) return i;
      return -1;
    };

    const settled = new Set(rows.filter((r) => r.type === 'answer' || r.type === 'question_closed').map((r) => data(r).questionId));
    for (const r of rows) {
      if (r.type === 'question' && !settled.has(data(r).id)) add('question_closed', { questionId: data(r).id, why: 'the server restarted' }, r.runId);
    }

    for (const rid of new Set(rows.filter((r) => r.type === 'run_started').map((r) => r.runId!))) {
      const mine = rows.filter((r) => r.runId === rid);
      if (mine.some((r) => ENDED.has(r.type)) || mine.at(-1)!.type === 'run_detached') continue;
      add('run_detached', {}, rid);
    }

    const m = lastIndex((r) => r.type === 'message' && !data(r).tags?.length);
    if (m >= 0 && !rows.slice(m + 1).some((r) => r.type === 'turn_ended' || r.type === 'turn_failed')) {
      add('turn_failed', { error: 'server restarted' });
    }

    const cards = rows.slice(lastIndex(emptiesQueue) + 1)
      .filter((r) => r.type === 'card_queued' && r.runId === undefined && (data(r).kind === 'steer' || data(r).kind === 'now'))
      .map((r) => data(r).card as string);
    if (cards.length) add('cards_unsent', { cards });

    const st = lastIndex((r) => r.type === 'status');
    const status = st >= 0 ? data(rows[st]!).status : 'idle';
    if (status !== 'idle' && status !== 'closed') add('status', { status: 'idle' });
  }
}
