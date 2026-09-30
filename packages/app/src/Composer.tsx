import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Diagnostic } from '@reins/core';
import type { TagEntry } from '@reins/server/tags.js';
import { ApiError, get, post } from './api.js';
import { chipsToTags, missingArg, pickerFor, takeTag, type Chip } from './tags.js';

interface Listed { path: string; name: string; scope: string }

export function Composer({ id, cwd, busy, catalogue, takeRefill }: { id: string; cwd: string; busy: boolean; catalogue: TagEntry[]; takeRefill: (input: string) => string }) {
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [caret, setCaret] = useState(0);
  const [idx, setIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<{ error: string; diagnostics?: Diagnostic[] } | null>(null);
  const [runList, setRunList] = useState<Listed[] | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { box.current?.focus(); }, [id]);
  useEffect(() => {
    const t = takeRefill(text);
    if (t !== text) setText(t);
  });

  const flash = (error: string, diagnostics?: Diagnostic[]) => {
    clearTimeout(timer.current);
    setNotice({ error, ...(diagnostics ? { diagnostics } : {}) });
    if (!diagnostics) timer.current = setTimeout(() => setNotice(null), 4000);
  };
  const fail = (e: unknown) => (e instanceof ApiError ? flash(e.message, e.body?.diagnostics) : flash(String(e)));

  const picker = dismissed ? null : pickerFor(text, caret, catalogue);
  const pick = (t: TagEntry) => {
    const r = takeTag(text, picker!);
    setChips([...chips, { tag: t.name, ...(t.arg ? { arg: '' } : {}) }]);
    setText(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(r.caret, r.caret); });
  };

  async function send() {
    const body = text.trim();
    if (!body) return;
    setNotice(null);
    try {
      if (body === '/run') {
        const r = await get<{ workflows: Listed[] }>(`/api/workflows?cwd=${encodeURIComponent(cwd)}`);
        setRunList(r.workflows);
        return;
      }
      const runPath = /^\/run\s+(.+)$/.exec(body)?.[1];
      if (runPath) await post(`/api/sessions/${id}/run`, { path: runPath.trim() });
      else if (body === '/stop') await post(`/api/sessions/${id}/card`, { kind: 'stop', text: '' });
      else {
        if (chips.length && busy) return flash('Tags start a new run; wait until the session is idle.');
        const missing = missingArg(chips, catalogue);
        if (missing) return flash(`#${missing} needs an argument`);
        await post(`/api/sessions/${id}/message`, { text: body, ...(chips.length ? { tags: chipsToTags(chips) } : {}) });
      }
      setText('');
      setChips([]);
      setRunList(null);
    } catch (e) {
      fail(e);
    }
  }

  const card = (kind: 'now' | 'stop') =>
    post(`/api/sessions/${id}/card`, { kind, text: kind === 'stop' ? '' : text.trim() }).then(() => { if (kind === 'now') setText(''); }).catch(fail);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + picker.matches.length) % picker.matches.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (busy) { void send(); return; }
        pick(picker.matches[idx % picker.matches.length]!);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };

  return (
    <div className="composer">
      {runList && (
        <ul className="runlist" aria-label="Workflows">
          {runList.length === 0 && <li className="hint">No workflows in this folder.</li>}
          {runList.map((w) => (
            <li key={w.path}><button onClick={() => { post(`/api/sessions/${id}/run`, { path: w.path }).then(() => { setRunList(null); setText(''); }).catch(fail); }}>{w.name} <span className="faint">({w.scope})</span></button></li>
          ))}
        </ul>
      )}
      {picker && (
        <ul className="picker" role="listbox" aria-label="Tags">
          {busy && <li className="hint">Tags start a new run; wait until the session is idle.</li>}
          {picker.matches.map((t, i) => (
            <li key={t.name} role="option" aria-selected={i === idx % picker.matches.length}>
              <button tabIndex={-1} disabled={busy} className={i === idx % picker.matches.length ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(t); }}>
                #{t.name} <span className="faint">{t.enforced ? 'enforced' : 'advised'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c, i) => {
            const t = catalogue.find((x) => x.name === c.tag);
            return (
              <span className="chip tag" key={i}>
                #{c.tag} <span className="faint">{t?.enforced ? 'enforced' : 'advised'}</span>
                {t?.arg && (
                  <input aria-label={`Argument of #${c.tag}`} placeholder={t.arg === 'until' ? 'condition, e.g. tests pass' : t.arg} value={c.arg ?? ''}
                    onChange={(e) => setChips(chips.map((x, j) => (j === i ? { ...x, arg: e.target.value } : x)))} />
                )}
                <button aria-label={`Remove #${c.tag}`} onClick={() => setChips(chips.filter((_, j) => j !== i))}>×</button>
              </span>
            );
          })}
        </div>
      )}
      <textarea
        ref={box} id="chat-input" aria-label="Message" rows={2} value={text}
        placeholder={busy ? 'Steer the agent (sent as a card)…' : 'Message, #tag, or /run'}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setIdx(0); setDismissed(false); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
      />
      <div className="composer-bar">
        <span className="hint">Enter sends · Shift+Enter is a new line</span>
        {busy && <button disabled={!text.trim()} onClick={() => void card('now')}>Now</button>}
        {busy && <button className="danger" onClick={() => void card('stop')}>Stop</button>}
        <button className="primary" disabled={!text.trim()} onClick={() => void send()}>Send</button>
      </div>
      {notice && (
        <div className="bad" role="alert">
          {notice.error}
          {notice.diagnostics?.map((d, i) => <div key={i}>line {d.pos.line}: {d.message}</div>)}
        </div>
      )}
    </div>
  );
}
