import type { Receipt } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import { dollars } from '../unknown.js';

export const type = 'receipt';

export function receiptFields(r: Receipt): Array<[string, string]> {
  const always: Array<[string, string]> = [
    ['status', r.status], ['turns', String(r.totalTurns)], ['time', `${Math.round(r.totalTimeMs / 1000)}s`], ['cost', dollars(r.totalCostUsd, 4, !!r.unpricedTurns)],
  ];
  const unpriced: Array<[string, string]> = r.unpricedTurns ? [['unpriced replies', `${r.unpricedTurns}: the cost leaves them out`]] : [];
  const sometimes: Array<[string, number]> = [
    ['gates held', r.gatesHeld],
    ['refusals', r.totalRefusals], ['guard refusals', r.guardRefusals], ['read-only refusals', r.readOnlyRefusals],
    ['loop attempts', r.loopAttempts], ['verify passed', r.verifyResults.passed], ['verify failed', r.verifyResults.failed],
    ['cards delivered', r.liveCardsDelivered], ['auto cards fired', r.autoCardsFired],
    ['Knowl recalls', r.knowlRecalls], ['Knowl stores', r.knowlStores], ['Knowl skipped', r.knowlSkipped],
  ];
  const money = (x: number, unknown?: boolean) => dollars(x, 4, unknown); // the cost row's 4 decimals, so the parts visibly add up
  const split = (r.models ?? []).map((m) => `${m.label ?? m.model} ${money(m.usd, m.unknown)} (${m.turns} turn${m.turns === 1 ? '' : 's'})`).join(' · ');
  const models: Array<[string, string]> = split ? [['models', split + (r.unsplitUsd ? ` · not split by model ${money(r.unsplitUsd)}` : '')]] : [];
  const subs = (r.subagents ?? []).map((s) => `${s.title} ${money(s.usd, s.unknown)} (${s.turns} turn${s.turns === 1 ? '' : 's'})`).join(' · ');
  const subagents: Array<[string, string]> = subs ? [['subagents', subs]] : [];
  return [...always, ...unpriced, ...models, ...subagents, ...sometimes.filter(([, n]) => n !== 0).map(([k, n]): [string, string] => [k, String(n)]),
    ...Object.entries(r.counts ?? {}).map(([k, n]): [string, string] => [k, String(n)])];
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
