import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { CardKind, Step, Workflow } from '@reins/core';
import { CARD_KINDS, KINDS, type Field } from './canvasKinds.js';
import { setAlways, setBudget } from './blocks.js';
import { editStep, removeLinks, setLink } from './canvas.js';
import { applyField, applyLinkMax, budgetCount, budgetPatch, BUDGET_HINT, fieldValue, type BudgetKey } from './panelEdit.js';
import { modelOptions } from './usage.js';

// The same rule as usdText in packages/core/src/format/print.ts (the app imports only core's types): two decimals when that loses nothing.
const usdText = (usd: number) => (Number(usd.toFixed(2)) === usd ? usd.toFixed(2) : String(usd));

type Models = Array<{ id: string; label: string }>;
// `alert` is the id of the words under a refused value: the input says it is invalid and points at them.
type InputProps = { label: string; value: string; ids: string[]; models: Models; rev: unknown; commit: (v: string) => void; alert?: string; empty?: string };

// A field shows a draft while typing and commits on blur / Enter. It re-syncs from the model after every
// preview (`rev`), so a commit the editor dropped never leaves a value the model does not have.
// `hold` keeps the reset back while it returns true (a pill being typed in).
export function useDraft(value: string, rev: unknown, hold?: () => boolean) {
  const [v, setV] = useState(value);
  useEffect(() => { if (!hold?.()) setV(value); }, [value, rev]);
  return [v, setV] as const;
}

// The draft + commit-when-changed + Enter-commits of a one-line field.
export function useLine(value: string, rev: unknown, commit: (v: string) => void, hold?: () => boolean) {
  const [v, setV] = useDraft(value, rev, hold);
  const done = () => { if (v !== value) commit(v); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') done(); };
  return { v, setV, done, onKeyDown };
}

export function StepOptions({ value, ids }: { value: string; ids: string[] }) {
  return <>{[...new Set(['', value, ...ids])].map((id) => <option key={id} value={id}>{id || '(none)'}</option>)}</>;
}

const line = (type: 'text' | 'number', mono?: boolean) => function LineInput({ label, value, rev, commit, alert }: InputProps) {
  const { v, setV, done, onKeyDown } = useLine(value, rev, commit);
  return (
    <label className="bfield">{label}
      <input type={type} min={type === 'number' ? 1 : undefined} className={mono ? 'mono' : undefined} value={v}
        onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={onKeyDown}
        aria-invalid={alert ? true : undefined} aria-describedby={alert} />
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
        <StepOptions value={value} ids={ids} />
      </select>
    </label>
  ),
  // the session's own catalog; a model the catalog does not list (typed in Text) stays selectable
  model: ({ label, value, models, commit, empty }) => (
    <label className="bfield">{label}
      <select value={value} onChange={(e) => commit(e.target.value)}>
        <option value="">{empty ?? '(pick a model)'}</option>
        {modelOptions(models, value).slice(1).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>
  ),
};

// One panel field; a value applyField refuses is said in words under it (the file is left as it was).
export function PanelField({ f, step, ids, models, rev, onCommit }: {
  f: Field; step: Step; ids: string[]; models: Models; rev: unknown; onCommit: (v: string) => void;
}) {
  const [bad, setBad] = useState('');
  const Input = INPUTS[f.input];
  const alertId = `${step.id}-${f.key}-bad`;
  return (
    <>
      <Input label={f.label} value={fieldValue(step, f.key)} ids={ids} models={models} rev={rev} empty={f.empty} alert={bad ? alertId : undefined}
        commit={(v) => {
          const ok = applyField(structuredClone(step), f.key, v);
          setBad(ok ? '' : f.error ?? '');
          if (ok) onCommit(v);
        }} />
      {bad && <div id={alertId} className="bad" role="alert">{bad}</div>}
    </>
  );
}

export function BlockPanel({ step, all, cond, turn, rev, models, onEdit, onEditInText, onShowInChat, onDelete }: {
  step: Step; all: Step[]; cond?: string; turn?: string; rev: unknown; models: Models;
  onEdit: (fn: (w: Workflow) => Workflow) => void; onEditInText: () => void; onShowInChat?: () => void; onDelete: () => void;
}) {
  const k = KINDS[step.kind];
  const id = step.id;
  const others = all.filter((s) => s.id !== id).map((s) => s.id);
  const change = (fn: (s: Step) => void | boolean) => onEdit((w) => editStep(w, id, fn));
  const incoming = all.flatMap((s) => s.links.filter((l) => l.to === id).map((l) => ({ from: s.id, kind: l.kind })));
  const [kind, setKind] = useState<'next' | 'on-fail'>('next');
  const [target, setTarget] = useState('');
  const [cardKind, setCardKind] = useState<CardKind>(CARD_KINDS[0]!);

  return (
    <aside className="bpanel" aria-label="Block panel">
      <h3>{step.kind} <span className="faint">{id}</span></h3>
      <button className="danger" onClick={onDelete}>Delete</button>
      {onShowInChat && <button onClick={onShowInChat}>Show in Chat</button>}

      {k.fields.map((f) => (
        <PanelField key={`${id}/${f.key}`} f={f} step={step} ids={others} models={models} rev={rev}
          onCommit={(v) => change((s) => applyField(s, f.key, v))} />
      ))}

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

export function WorkflowPanel({ w, rev, onEdit }: { w: Workflow; rev: unknown; onEdit: (fn: (w: Workflow) => Workflow) => void }) {
  return (
    <aside className="bpanel" aria-label="Workflow panel">
      <h3>{w.name}</h3>
      {w.task && <div className="bfield">Task<span className="sx-faint">{w.task}</span></div>}
      {!w.block && <BudgetFields w={w} rev={rev} onEdit={onEdit} />}
      <Always w={w} rev={rev} onEdit={onEdit} />
    </aside>
  );
}

// ponytail: the budget form edits through the model, so the file is reprinted as in Blocks (comments and custom order go,
// after the existing confirm); a line edit of the front-matter would keep them in Text.
export function BudgetFields({ w, rev, onEdit }: { w: Workflow; rev: unknown; onEdit: (fn: (w: Workflow) => Workflow) => void }) {
  const b = w.budget;
  const [bad, setBad] = useState('');
  const commit = (key: BudgetKey, raw: string) => {
    const r = budgetPatch(key, raw, b, drafts);
    if ('error' in r) return setBad(r.error);
    setBad('');
    onEdit((m) => setBudget(m, r.patch));
  };
  const turns = useLine(budgetCount(b.turns), rev, (v) => commit('turns', v));
  const minutes = useLine(budgetCount(b.minutes), rev, (v) => commit('minutes', v));
  const usd = useLine(b.usd === undefined ? '' : usdText(b.usd), rev, (v) => commit('usd', v));
  const drafts = { turns: turns.v, minutes: minutes.v };
  const field = (label: string, l: ReturnType<typeof useLine>, number: boolean) => (
    <label className="bfield">{label}
      <input type={number ? 'number' : 'text'} {...(number ? { min: 1, step: 1 } : { inputMode: 'decimal' as const })}
        value={l.v} onChange={(e) => l.setV(e.target.value)} onBlur={l.done} onKeyDown={l.onKeyDown} />
    </label>
  );
  return (
    <section className="sx-budget" aria-label="Budget">
      <h4>Budget</h4>
      {field('Turns', turns, true)}
      {field('Minutes', minutes, true)}
      {field('USD', usd, false)}
      {bad && <div className="bad" role="alert">{bad}</div>}
      <p className="hint">{BUDGET_HINT}</p>
    </section>
  );
}

function Always({ w, rev, onEdit }: { w: Workflow; rev: unknown; onEdit: (fn: (w: Workflow) => Workflow) => void }) {
  const value = w.always.join('\n');
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = useRef(false);
  // Held while focused (a preview landing must not wipe the typing); re-synced on blur when nothing was typed.
  const [v, setV] = useDraft(value, rev, () => document.activeElement === ref.current);
  return (
    <label className="always">Always
      <textarea ref={ref} rows={Math.max(2, w.always.length + 1)} value={v} onChange={(e) => { dirty.current = true; setV(e.target.value); }}
        onBlur={() => { if (dirty.current && v !== value) onEdit((m) => setAlways(m, v)); else setV(value); dirty.current = false; }} />
    </label>
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
