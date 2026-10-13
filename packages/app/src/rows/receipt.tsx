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
  const money = (x: number) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;
  const split = (r.models ?? []).map((m) => `${m.label ?? m.model} ${money(m.usd)} (${m.turns} turn${m.turns === 1 ? '' : 's'})`).join(' · ');
  const models: Array<[string, string]> = split ? [['models', split + (r.unsplitUsd ? ` · not split by model ${money(r.unsplitUsd)}` : '')]] : [];
  return [...always, ...models, ...sometimes.filter(([, n]) => n !== 0).map(([k, n]): [string, string] => [k, String(n)])];
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
