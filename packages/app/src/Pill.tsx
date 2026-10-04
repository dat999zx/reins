import { useRef } from 'react';
import { StepOptions, useLine } from './BlockPanel.js';

const LOOKS = { pill: 'sx-pill', code: 'sx-code', num: 'sx-pill sx-num', bold: 'sx-bold' };

// commit returns false when the edit was not sent (busy, or the value was refused): the draft then reverts.
export function Pill({ label, value, look, rev, commit }: {
  label: string; value: string; look: keyof typeof LOOKS; rev: unknown; commit: (v: string) => boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const ph = label.split(' of ')[0]!.toLowerCase(); // the empty pill names its field
  // Held while focused: a click on a pill selects its block, which re-runs the preview, and a reset would wipe the typing.
  const line = useLine(value, rev, (v) => { if (!commit(v)) line.setV(value); }, () => document.activeElement === ref.current);
  const send = () => { if (dirty.current) line.done(); dirty.current = false; };
  return (
    <input ref={ref} className={LOOKS[look]} aria-label={label} placeholder={ph} size={Math.max(3, (line.v || ph).length)} value={line.v}
      onChange={(e) => { dirty.current = true; line.setV(e.target.value); }}
      onBlur={() => { if (dirty.current) send(); else line.setV(value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') send();
        else if (e.key === 'Escape') { dirty.current = false; line.setV(value); }
      }} />
  );
}

export function StepPick({ label, value, ids, commit }: { label: string; value: string; ids: string[]; commit: (v: string) => void }) {
  return (
    <select className="sx-pill" aria-label={label} value={value} onChange={(e) => commit(e.target.value)}>
      <StepOptions value={value} ids={ids} />
    </select>
  );
}
