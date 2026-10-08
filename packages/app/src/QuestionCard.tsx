import { useEffect, useRef, useState } from 'react';
import type { LogRow } from '@reins/server/store.js';
import type { Question } from '@reins/server/drive.js';
import { ApiError } from './api.js';
import { actionsFor, detailFor, type Action } from './questions.js';
import type { Sess } from './state.js';

const detailOf = (q: Question) => {
  if (q.detail === undefined) return null;
  if (detailFor(q.kind) !== 'json') return q.detail;
  try {
    return JSON.stringify(JSON.parse(q.detail), null, 2);
  } catch {
    return q.detail;
  }
};

function ActionView({ a, send, disabled }: { a: Action; send: (answer: string) => void; disabled: boolean }) {
  const [v, setV] = useState(a.field?.initial ?? '');
  const built = a.build(v);
  if (!a.field) return <button className={a.primary ? 'primary' : ''} disabled={disabled} onClick={() => built !== null && send(built)}>{a.label}</button>;
  return (
    <form className="act" onSubmit={(e) => { e.preventDefault(); if (built !== null) send(built); }}>
      <input aria-label={`${a.label}: ${a.field.placeholder}`} placeholder={a.field.placeholder} value={v} onChange={(e) => setV(e.target.value)} />
      <button type="submit" className={a.primary ? 'primary' : ''} disabled={disabled || built === null}>{a.label}</button>
    </form>
  );
}

export function QuestionCard({ row, sess, answer }: { row: LogRow; sess: Sess; answer: (id: string, a: string) => Promise<void> }) {
  const q = row.data as Question;
  const answered = sess.answers[q.id];
  const closed = sess.closed[q.id];
  const ref = useRef<HTMLElement>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (answered === undefined && closed === undefined) ref.current?.scrollIntoView({ block: 'nearest' }); }, []);

  if (answered !== undefined) return <div className="row q-done">{q.kind} · answered: <code>{answered}</code></div>;
  if (closed !== undefined) return <div className="row q-done">{q.kind} · closed: {closed}</div>;
  const detail = detailOf(q);
  const send = (a: string) => {
    setBusy(true);
    answer(q.id, a).catch((e) => { setBusy(false); setErr(e instanceof ApiError && e.status === 409 ? 'already answered' : String(e.message ?? e)); });
  };
  return (
    <section className={`qcard ${q.kind}`} ref={ref} aria-label={`${q.kind} question`} data-qid={q.id}>
      <div className="qprompt"><span className="kind">{q.kind}</span> {q.prompt}</div>
      {detail !== null && <pre className="qdetail">{detail}</pre>}
      <div className="btns">{actionsFor(q.kind).map((a) => <ActionView key={a.label} a={a} send={send} disabled={busy} />)}</div>
      {err && <div className="bad" role="alert">{err}</div>}
    </section>
  );
}
