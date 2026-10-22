import type { RunEventRecord } from './run.js';
import { NODES } from './nodes/index.js';

export interface Receipt {
  workflow: string;
  /** Replies that had no cost (an unpriced model, or a total that was lost); totalCostUsd leaves them out. Absent when none. */
  unpricedTurns?: number;
  status: 'done' | 'stopped' | 'failed' | 'paused' | 'running';
  totalTurns: number;
  totalTimeMs: number;
  totalCostUsd: number;
  gatesHeld: number;
  guardRefusals: number;
  readOnlyRefusals: number;
  totalRefusals: number;
  loopAttempts: number;
  autoCardsFired: number;
  liveCardsDelivered: number;
  verifyResults: { passed: number; failed: number };
  knowlRecalls: number;
  knowlStores: number;
  /** recall or store steps that did nothing because no Knowl function was wired in */
  knowlSkipped: number;
  /** Turns and dollars per model (first seen first); absent when no reply named a model or carried a split. */
  models?: Array<{ model: string; usd: number; turns: number; label?: string; unknown?: true }>;
  /** The part of totalCostUsd no model's figure covers (a reply with no per-model split); absent when none. */
  unsplitUsd?: number;
  /** Dollars and turns per subagent step, first started first; absent when no subagent ran. */
  subagents?: Array<{ step: string; title: string; usd: number; turns: number; unknown?: true }>;
  /** One row per track, first started first; absent when the run started none. A branch row holds its subagents' turns and dollars too (they stay in `subagents`); the totals above do not add the rows again. */
  tracks?: Array<{ key: string; title: string; usd: number; turns: number; ended: boolean; unknown?: true }>;
  /** What the kinds count in their own events (name to number); absent when nothing was counted. */
  counts?: Record<string, number>;
}

export function receipt(events: RunEventRecord[]): Receipt {
  let workflow = '';
  let status: Receipt['status'] = 'running';
  let totalTurns = 0;
  let totalCostUsd = 0;
  let unpricedTurns = 0;
  let gatesHeld = 0;
  let guardRefusals = 0;
  let readOnlyRefusals = 0;
  let totalRefusals = 0;
  let loopAttempts = 0;
  let autoCardsFired = 0;
  let liveCardsDelivered = 0;
  const verifyResults = { passed: 0, failed: 0 };
  let knowlRecalls = 0;
  let knowlStores = 0;
  let knowlSkipped = 0;
  const byModel = new Map<string, { usd: number; turns: number; unknown?: true }>();
  const seen = (m: string) => byModel.get(m) ?? (byModel.set(m, { usd: 0, turns: 0 }), byModel.get(m)!);

  const subs = new Map<string, { title: string; usd: number; turns: number; unknown?: true }>();
  const counts: Record<string, number> = {};
  // A Map: a track key is a name somebody chose. Rows are read from the `track` tag the Run puts on a track's own events.
  const tracks = new Map<string, { title: string; usd: number; turns: number; ended: boolean; unknown?: true }>();
  const trackOf = (ev: RunEventRecord) => {
    const k = ev.data?.track;
    if (typeof k !== 'string' || !k) return undefined;
    return tracks.get(k) ?? (tracks.set(k, { title: k, usd: 0, turns: 0, ended: false }), tracks.get(k)!);
  };

  const firstTimestamp = events[0]?.timestamp ?? 0;
  let lastTimestamp = firstTimestamp;

  for (const ev of events) {
    if (ev.timestamp > lastTimestamp) {
      lastTimestamp = ev.timestamp;
    }

    const tr = trackOf(ev);
    if (tr) {
      if (ev.type === 'track_started' && typeof ev.data.title === 'string') tr.title = ev.data.title;
      else if (ev.type === 'track_ended') tr.ended = true;
      else if (ev.type === 'turn_ended') { tr.turns++; if (ev.data.unknown === true) tr.unknown = true; }
      else if (ev.type === 'engine_cost') { tr.usd += Number(ev.data.usd || 0); if (ev.data.unknown === true) tr.unknown = true; }
    }

    switch (ev.type) {
      case 'run_started':
        workflow = ev.data?.workflow || '';
        break;
      case 'run_finished':
        status = 'done';
        break;
      case 'run_stopped':
        status = 'stopped';
        break;
      case 'run_paused':
        if (status !== 'done' && status !== 'stopped') status = 'paused';
        break;
      case 'turn_ended':
        totalTurns++;
        // A reply that ran on a model and still has no cost (the loop always names its model). Known limit: a turn that names no model is not
        // counted, so a CLI turn killed before its usage row (real spend, unknown cost) shows no "unpriced" mark; counting it would also count
        // the scripted turns of the golden fixtures, which carry neither a model nor a cost.
        // A reply the engine marked unknown (`unknown`) counts the same, whether or not it named a model; its model's and its subagent's subtotals say so.
        {
          const marked = ev.data?.unknown === true;
          if (marked || (typeof ev.data?.model === 'string' && (ev.data.cost === undefined || ev.data.cost === null))) unpricedTurns++;
          if (typeof ev.data?.model === 'string') {
            const m = seen(ev.data.model);
            m.turns++;
            if (marked) m.unknown = true;
          }
          const sub = subs.get(ev.data?.step);
          if (sub) { sub.turns++; sub.usd += Number(ev.data?.cost || 0); if (marked) sub.unknown = true; }
        }
        break;
      case 'subagent_started':
        if (!subs.has(ev.data?.step)) subs.set(ev.data?.step, { title: ev.data?.title ?? ev.data?.step, usd: 0, turns: 0 });
        break;
      case 'gate_paused':
        gatesHeld++;
        break;
      case 'refusal':
        totalRefusals++;
        if (ev.data?.reason?.includes('guard')) {
          guardRefusals++;
        }
        if (ev.data?.reason?.includes('read-only')) {
          readOnlyRefusals++;
        }
        break;
      case 'loop_iteration':
        loopAttempts++;
        break;
      case 'card_queued':
        if (ev.data?.source !== 'live') autoCardsFired++;
        break;
      case 'card_delivered':
        liveCardsDelivered++;
        break;
      case 'verify_result':
        if (ev.data?.pass) {
          verifyResults.passed++;
        } else {
          verifyResults.failed++;
        }
        break;
      case 'recall':
        if (ev.data?.skipped) knowlSkipped++;
        else knowlRecalls++;
        break;
      case 'store':
        if (ev.data?.skipped) knowlSkipped++;
        else knowlStores++;
        break;
      case 'engine_cost':
        // A call that failed and left a spend nobody knows (no reply came back to price): a reply with no price, on its step if it was a subagent's.
        if (ev.data?.unknown === true) {
          unpricedTurns++;
          const sub = subs.get(ev.data?.step);
          if (sub) sub.unknown = true;
        }
        totalCostUsd += Number(ev.data?.usd || 0);
        for (const [m, usd] of Object.entries((ev.data?.models ?? {}) as Record<string, number>)) seen(m).usd += Number(usd) || 0;
        break;
    }
    for (const n of NODES.values()) {
      const k = n.count && Object.hasOwn(n.count, ev.type) ? n.count[ev.type]?.(ev.data) : undefined;
      if (k) counts[k] = (counts[k] ?? 0) + 1;
    }
  }

  const totalTimeMs = Math.max(0, lastTimestamp - firstTimestamp);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const models = [...byModel].map(([model, v]) => ({ model, usd: r6(v.usd), turns: v.turns, ...(v.unknown ? { unknown: true as const } : {}) }));
  const unsplit = totalCostUsd - models.reduce((a, m) => a + m.usd, 0);

  return {
    workflow,
    status,
    totalTurns,
    totalTimeMs,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    gatesHeld,
    guardRefusals,
    readOnlyRefusals,
    totalRefusals,
    loopAttempts,
    autoCardsFired,
    liveCardsDelivered,
    verifyResults,
    knowlRecalls,
    knowlStores,
    knowlSkipped,
    ...(models.length ? { models } : {}),
    ...(models.length && unsplit > 0.00005 ? { unsplitUsd: r6(unsplit) } : {}),
    ...(subs.size ? { subagents: [...subs].map(([step, v]) => ({ step, title: v.title, usd: r6(v.usd), turns: v.turns, ...(v.unknown ? { unknown: true as const } : {}) })) } : {}),
    ...(tracks.size ? { tracks: [...tracks].map(([key, v]) => ({ key, title: v.title, usd: r6(v.usd), turns: v.turns, ended: v.ended, ...(v.unknown ? { unknown: true as const } : {}) })) } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
    ...(unpricedTurns ? { unpricedTurns } : {}),
  };
}
