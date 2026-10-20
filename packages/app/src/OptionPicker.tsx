import { useState } from 'react';
import { groupOptions, modelOptions, OTHER, typedModel, type PickOption } from './usage.js';

type Props = {
  options: PickOption[]; value: string; onChange: (v: string) => void; label: string;
  blank?: string; className?: string; disabled?: boolean; title?: string; other?: { own?: string };
};

// The one picker (model and reasoning): the Chat header, the Blocks panel and the block face. `options` is one list; entries tagged with a `group`
// (the provider's label) draw as <optgroup>s when they span more than one. A value the list lacks (typed in Text) stays selectable. `blank` is the words for
// "none of its own" (a field that inherits the session's). `other` adds the last option, "Other model...", a typed id: with a `:` it is `provider:model`,
// without it is a model on `other.own` (the session's provider), or the plain id when there is none.
export function OptionPicker(p: Props) {
  return p.other ? <WithOther {...p} /> : select(p);
}

function select({ options, value, onChange, label, blank, className, disabled, title, other }: Props, onOther?: () => void) {
  const item = (m: PickOption) => <option key={m.id} value={m.id}>{m.label}</option>;
  return (
    <select aria-label={label} className={className} value={value} disabled={disabled} title={title}
      onChange={(e) => (e.target.value === OTHER.id ? onOther?.() : onChange(e.target.value))}>
      {blank !== undefined ? <option value="">{blank}</option> : value === '' && <option value="" disabled>Pick a model</option>}
      {groupOptions(modelOptions(options, value)).map((g) => (g.label === undefined ? g.options.map(item) : <optgroup key={g.label} label={g.label}>{g.options.map(item)}</optgroup>))}
      {other && <option value={OTHER.id}>{OTHER.label}</option>}
    </select>
  );
}

function WithOther(p: Props) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  if (!typing) return select(p, () => setTyping(true));
  const close = () => { setTyping(false); setDraft(''); };
  return (
    <input aria-label={`${p.label}: other model`} className={p.className} autoFocus value={draft} placeholder="model or provider:model"
      onChange={(e) => setDraft(e.target.value)} onBlur={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
        if (e.key !== 'Enter') return;
        const v = typedModel(draft, p.other?.own);
        close();
        if (v !== undefined) p.onChange(v);
      }} />
  );
}
