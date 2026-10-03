import { useEffect, useState, type JSX } from 'react';
import type { CardKind, Step, Workflow } from '@reins/core';
import { CARD_KINDS, KINDS, type Field } from './canvasKinds.js';
import { editStep, removeLinks, setLink } from './canvas.js';
import { applyField, applyLinkMax, fieldValue } from './panelEdit.js';

type InputProps = { label: string; value: string; ids: string[]; rev: unknown; commit: (v: string) => void };

// A field shows a draft while typing and commits on blur / Enter. It re-syncs from the model after every
// preview (`rev`), so a commit the editor dropped never leaves a value the model does not have.
export function useDraft(value: string, rev: unknown) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value, rev]);
  return [v, setV] as const;
}

const line = (type: 'text' | 'number', mono?: boolean) => function LineInput({ label, value, rev, commit }: InputProps) {
  const [v, setV] = useDraft(value, rev);
  const done = () => { if (v !== value) commit(v); };
  return (
    <label className="bfield">{label}
      <input type={type} min={type === 'number' ? 1 : undefined} className={mono ? 'mono' : undefined} value={v}
        onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />
    </label>
  );
};

const INPUTS: Record<Field['input'], (p: InputProps) => JSX.Element> = {
  text: line('text'),
  mono: line('text', true),
  number: line('number'),
  textarea: ({ label, value, rev, commit }) => {
    const [v, setV] = useDraft(value, rev);
    return (
      <label className="bfield">{label}
        <textarea rows={4} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) commit(v); }} />
      </label>
    );
  },
  mode: ({ label, value, commit }) => (
    <label className="bfield">{label}
      <select value={value} onChange={(e) => commit(e.target.value)}>
        <option value="">default</option><option value="write">write</option><option value="read-only">read-only</option>
      </select>
    </label>
  ),
  step: ({ label, value, ids, commit }) => (
    <label className="bfield">{label}
      <select value={value} onChange={(e) => commit(e.target.value)}>
        {[...new Set(['', value, ...ids])].map((id) => <option key={id} value={id}>{id || '(none)'}</option>)}
      </select>
    </label>
  ),
};

export function BlockPanel({ step, all, cond, turn, rev, onEdit, onEditInText, onDelete }: {
  step: Step; all: Step[]; cond?: string; turn?: string; rev: unknown;
  onEdit: (fn: (w: Workflow) => Workflow) => void; onEditInText: () => void; onDelete?: () => void;
}) {
  const k = KINDS[step.kind];
  const id = step.id;
  const others = all.filter((s) => s.id !== id).map((s) => s.id);
  const change = (fn: (s: Step) => void) => onEdit((w) => editStep(w, id, fn));
  const incoming = all.flatMap((s) => s.links.filter((l) => l.to === id).map((l) => ({ from: s.id, kind: l.kind })));
  const [kind, setKind] = useState<'next' | 'on-fail'>('next');
  const [target, setTarget] = useState('');
  const [cardKind, setCardKind] = useState<CardKind>(CARD_KINDS[0]!);

  return (
    <aside className="bpanel" aria-label="Block panel">
      <h3>{step.kind} <span className="faint">{id}</span></h3>
      {onDelete && <button className="danger" onClick={onDelete}>Delete</button>}

      {k.fields.map((f) => {
        const Input = INPUTS[f.input];
        return <Input key={`${id}/${f.key}`} label={f.label} value={fieldValue(step, f.key)} ids={others} rev={rev}
          commit={(v) => change((s) => applyField(s, f.key, v))} />;
      })}

      {cond !== undefined && (
        <div className="bfield">Condition
          <code>{cond}</code>
          <button onClick={onEditInText}>Edit in Text</button>
        </div>
      )}

      {k.cards && (
        <section aria-label="Cards">
          <h4>Cards</h4>
          {step.cards.map((c, i) => (
            <CardRow key={`${id}/${i}`} kind={c.kind} text={c.text} rev={rev}
              commit={(v) => change((s) => { s.cards[i]!.text = v; })}
              remove={() => change((s) => { s.cards.splice(i, 1); })} />
          ))}
          <div className="brow">
            <label>Card kind
              <select value={cardKind} onChange={(e) => setCardKind(e.target.value as CardKind)}>
                {CARD_KINDS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <button onClick={() => change((s) => { s.cards.push({ kind: cardKind, text: '' }); })}>Add card</button>
          </div>
        </section>
      )}

      <section aria-label="Links">
        <h4>Links</h4>
        {step.links.map((l, i) => (
          <div className="brow" key={`${id}/${i}/${l.kind}/${l.to}`}>
            <span>{l.kind} → {l.to}{l.kind !== 'next' && l.kind !== 'on-fail' && <span className="faint"> (no effect)</span>}</span>
            <MaxInput value={l.max === undefined ? '' : String(l.max)} rev={rev} commit={(v) => change((s) => applyLinkMax(s.links[i]!, v))} />
            <button aria-label={`Remove link ${l.kind} to ${l.to}`} onClick={() => onEdit((w) => removeLinks(w, [{ from: id, index: i }]))}>×</button>
          </div>
        ))}
        {incoming.map((l) => <div className="brow faint" key={`${l.from}/${l.kind}`}>{l.from} → {l.kind} (incoming)</div>)}
        <div className="brow">
          <label>Link kind
            <select value={kind} onChange={(e) => setKind(e.target.value as 'next' | 'on-fail')}>
              <option>next</option>{k.fails && <option>on-fail</option>}
            </select>
          </label>
          <label>Link target
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">(pick a step)</option>
              {others.map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
          <button disabled={!target} onClick={() => onEdit((w) => setLink(w, id, kind, target))}>Add link</button>
        </div>
      </section>

      <section aria-label="What the agent receives">
        <h4>What the agent receives</h4>
        <pre className="turn">{turn ?? 'This step sends no turn.'}</pre>
      </section>
    </aside>
  );
}

function CardRow({ kind, text, rev, commit, remove }: { kind: string; text: string; rev: unknown; commit: (v: string) => void; remove: () => void }) {
  const [v, setV] = useDraft(text, rev);
  const done = () => { if (v !== text) commit(v); };
  return (
    <div className="brow">
      <label>{kind}
        <input value={v} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />
      </label>
      <button aria-label={`Remove ${kind} card`} onClick={remove}>×</button>
    </div>
  );
}

function MaxInput({ value, rev, commit }: { value: string; rev: unknown; commit: (v: string) => void }) {
  const [v, setV] = useDraft(value, rev);
  const done = () => { if (v !== value) commit(v); };
  return (
    <label className="bmax">max
      <input type="number" min={1} value={v} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />
    </label>
  );
}
