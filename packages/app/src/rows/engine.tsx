import type { ReactNode } from 'react';
import type { EngineEvent } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import { generic, short } from '../generic.js';
import type { Ctx } from '../rows.js';

type Render = (e: any, row: LogRow, ctx: Ctx) => ReactNode;

export const chip = (e: { channel: string }) => <div className="row"><span className="chip">card delivered ({e.channel})</span></div>;
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const summary = (i: any) => short(i?.command ?? i?.file_path ?? i?.path ?? i?.pattern ?? i?.description ?? i ?? '', 100);

export const engineEvents = new Map<EngineEvent['type'], Render>([
  ['text', (e) => <div className="msg agent txt" aria-live="polite">{e.text}</div>],
  ['tool_call', (e, row, ctx) => {
    const call = ctx.sess.calls[row.seq];
    return (
      <details className={`row tool${call?.refused !== undefined ? ' refused' : ''}`}>
        <summary><b>{e.tool}</b> <span className="arg">{summary(e.input)}</span></summary>
        <pre>{pretty(e.input)}</pre>
        {call && 'result' in call && <pre className="result">{pretty(call.result)}</pre>}
      </details>
    );
  }],
  ['refusal', (e) => <div className="row bad">refused: {e.reason}</div>],
  ['card_delivered', (e) => chip(e)],
  ['error', (e) => <div className="row bad">{e.message}</div>],
]);

export const type = 'engine';
export const render = (row: LogRow, ctx: Ctx) => {
  const e = row.data as { type: string };
  const r = engineEvents.get(e.type as EngineEvent['type']);
  return r ? r(e, row, ctx) : generic(`engine ${e.type}`, e);
};
