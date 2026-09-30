import type { Receipt } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';

export const type = 'receipt';

export function receiptFields(r: Receipt): Array<[string, string]> {
  const always: Array<[string, string]> = [
    ['status', r.status], ['turns', String(r.totalTurns)], ['time', `${Math.round(r.totalTimeMs / 1000)}s`], ['cost', `$${r.totalCostUsd.toFixed(4)}`],
  ];
  const sometimes: Array<[string, number]> = [
    ['gates held', r.gatesHeld],
    ['refusals', r.totalRefusals], ['guard refusals', r.guardRefusals], ['read-only refusals', r.readOnlyRefusals],
    ['loop attempts', r.loopAttempts], ['verify passed', r.verifyResults.passed], ['verify failed', r.verifyResults.failed],
    ['cards delivered', r.liveCardsDelivered], ['auto cards fired', r.autoCardsFired],
    ['Knowl recalls', r.knowlRecalls], ['Knowl stores', r.knowlStores], ['Knowl skipped', r.knowlSkipped],
  ];
  return [...always, ...sometimes.filter(([, n]) => n !== 0).map(([k, n]): [string, string] => [k, String(n)])];
}

export const render = (row: LogRow) => {
  const r = row.data as Receipt;
  return (
    <section className="receipt" aria-label={`Receipt for ${r.workflow}`}>
      <h3>Receipt · {r.workflow}</h3>
      <dl>{receiptFields(r).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </section>
  );
};
