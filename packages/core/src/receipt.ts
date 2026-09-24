import type { RunEventRecord } from './run.js';

export interface Receipt {
  workflow: string;
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
}

export function receipt(events: RunEventRecord[]): Receipt {
  let workflow = '';
  let status: Receipt['status'] = 'running';
  let totalTurns = 0;
  let totalCostUsd = 0;
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

  const firstTimestamp = events[0]?.timestamp ?? 0;
  let lastTimestamp = firstTimestamp;

  for (const ev of events) {
    if (ev.timestamp > lastTimestamp) {
      lastTimestamp = ev.timestamp;
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
        autoCardsFired++;
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
        knowlRecalls++;
        break;
      case 'store':
        knowlStores++;
        break;
      case 'engine_cost':
        totalCostUsd += Number(ev.data?.usd || 0);
        break;
    }
  }

  const totalTimeMs = Math.max(0, lastTimestamp - firstTimestamp);

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
  };
}
