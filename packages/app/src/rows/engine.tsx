import { useState, type ReactNode } from 'react';
import type { EngineEvent } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import { generic, short } from '../generic.js';
import { Md } from '../Md.js';
import type { Ctx } from '../rows.js';
import { thinkingWords } from '../runState.js';
import { tokens } from '../usage.js';

type Render = (e: any, row: LogRow, ctx: Ctx) => ReactNode;

export const chip = (e: { channel: string }) => <div className="row"><span className="chip">card delivered ({e.channel})</span></div>;
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const summary = (i: any) => short(i?.command ?? i?.file_path ?? i?.path ?? i?.pattern ?? i?.description ?? i ?? '', 100);

// ponytail: tool timing is the gap between the call row and its result row, as logged; a result after its turn ended loses its call (state.ts:72-74).
function ToolBead({ e, row, ctx }: { e: any; row: LogRow; ctx: Ctx }) {
  const [seen, setSeen] = useState(false);
  const call = ctx.sess.calls[row.seq];
  return (
    <details className={`row tool${call?.refused !== undefined ? ' refused' : ''}`} onToggle={(ev) => { if (ev.currentTarget.open) setSeen(true); }}>
      <summary><b>{e.tool}</b> <span className="arg">{summary(e.input)}</span><span className="sx-took">
        {call?.refused !== undefined ? '✗ blocked' : call && 'result' in call ? `✓ ${((call.ms ?? 0) / 1000).toFixed(1)} s`
          : ctx.running ? <span className="sx-spin" role="img" aria-label="running" /> : null}
      </span></summary>
      {seen && <><pre>{pretty(e.input)}</pre>{call && 'result' in call && <pre className="result">{pretty(call.result)}</pre>}
        {call?.refused !== undefined && <div className="bad">blocked: {call.refused}</div>}</>}
    </details>
  );
}

// Open while it is the live head; after that it is the user's choice (as the tool bead's `seen`), starting collapsed.
function Reasoning({ e, live }: { e: { tokens?: number; text: string }; live: boolean }) {
  const [mine, setMine] = useState<boolean>();
  const open = mine ?? live;
  return (
    <details className="row think" open={open} onToggle={(ev) => { if (ev.currentTarget.open !== open) setMine(ev.currentTarget.open); }}>
      <summary>Reasoning{typeof e.tokens === 'number' ? ` ~${e.tokens.toLocaleString('en-US')} tokens` : ''}</summary>
      <div className="reasoning"><Md text={e.text} /></div>
    </details>
  );
}

export const engineEvents = new Map<EngineEvent['type'], Render>([
  ['text', (e) => <div className="msg agent txt"><Md text={e.text} /></div>],
  ['tool_call', (e, row, ctx) => <ToolBead e={e} row={row} ctx={ctx} />],
  ['refusal', (e) => <div className="row bad">refused: {e.reason}</div>],
  ['card_delivered', (e) => chip(e)],
  ['error', (e) => <div className="row bad">{e.message}</div>],
  // the provider's two figures do not measure the same thing (before has the system prompt, after has not), so the row never pairs them
  ['compacted', (e) => {
    const n = (x: number) => x.toLocaleString('en-US');
    const known = typeof e.after === 'number';
    const title = !known ? undefined
      : typeof e.before === 'number' ? `The provider's figures: ${n(e.before)} tokens before, ${n(e.after)} after; before includes the system prompt, after does not.`
        : `The provider's figure: ${n(e.after)} tokens after; it does not include the system prompt.`;
    return (
      <div className="row sx-compacted" title={title}>
        {known ? `Compressed: ${tokens(e.after)} tokens of conversation remain; the next reply measures the full context.` : 'Compressed.'}
        {e.trigger === 'auto' ? ' (by the provider)' : ''}
      </div>
    );
  }],
  // the parser emits several rows per burst (a growing count, then the text when the CLI sends it): only the burst's head draws
  ['thinking', (e, row, ctx) => !ctx.thinking?.heads.has(row.seq) ? null
    : typeof e.text === 'string' ? <Reasoning e={e} live={ctx.thinking.now === row.seq} />
    : ctx.thinking.now === row.seq ? <div className="row think"><span className="sx-wave" aria-hidden="true">⌁</span>{thinkingWords(e.tokens)}</div>
      : <div className="row think">thought ~{e.tokens.toLocaleString('en-US')} tokens</div>],
]);

export const type = 'engine';
export const render = (row: LogRow, ctx: Ctx) => {
  const e = row.data as { type: string };
  const r = engineEvents.get(e.type as EngineEvent['type']);
  return r ? r(e, row, ctx) : generic(`engine ${e.type}`, e);
};
