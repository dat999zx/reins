import { modelOptions } from './usage.js';

// The one picker (model and reasoning): the Chat header, the Blocks panel and the block face. It lists only what `options` (the session's provider list) holds;
// a value the list lacks (typed in Text) stays selectable. `blank` is the words for "none of its own" (a field that inherits the session's).
export function OptionPicker({ options, value, onChange, label, blank, className, disabled, title }: {
  options: Array<{ id: string; label: string }>; value: string; onChange: (v: string) => void; label: string;
  blank?: string; className?: string; disabled?: boolean; title?: string;
}) {
  return (
    <select aria-label={label} className={className} value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value)}>
      {blank !== undefined ? <option value="">{blank}</option> : value === '' && <option value="" disabled>Pick a model</option>}
      {modelOptions(options, value).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
}
