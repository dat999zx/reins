import { useRef, useState } from 'react';
import { StepOptions, useLine } from './BlockPanel.js';

const LOOKS = { pill: 'sx-pill', code: 'sx-code', num: 'sx-pill sx-num', bold: 'sx-bold' };

// commit returns false when the edit was not sent: on blur the draft then reverts; on Enter (still focused) it
// stays until Escape, blur or more typing, and is marked invalid only if `valid` says the value itself is refused
// (a busy editor refuses nothing: the draft stays, unmarked). `dead`: a loose block's controls do nothing.
export function Pill({ label, value, look, rev, commit, valid, dead }: {
  label: string; value: string; look: keyof typeof LOOKS; rev: unknown; commit: (v: string) => boolean; valid?: (v: string) => boolean; dead?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const [bad, setBad] = useState(false);
  const ph = label.split(' of ')[0]!.toLowerCase(); // the empty pill names its field
  // Held while focused: a click on a pill selects its block, which re-runs the preview, and a reset would wipe the typing.
  const line = useLine(value, rev, (v) => {
    if (commit(v)) return;
    if (document.activeElement === ref.current) setBad(!(valid?.(v) ?? true));
    else line.setV(value);
  }, () => document.activeElement === ref.current);
  const send = () => { if (dirty.current) line.done(); dirty.current = false; };
  return (
    <input ref={ref} className={LOOKS[look]} aria-label={label} placeholder={ph} size={Math.max(look === 'num' ? 2 : 3, (line.v || ph).length)} title={look === 'code' ? line.v : undefined} value={line.v}
      aria-invalid={bad || undefined} inert={dead}
      onChange={(e) => { dirty.current = true; setBad(false); line.setV(e.target.value); }}
      onBlur={() => { setBad(false); if (dirty.current) send(); else line.setV(value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) send();
        else if (e.key === 'Escape') { dirty.current = false; setBad(false); line.setV(value); }
      }} />
  );
}

export function StepPick({ label, value, ids, commit, dead }: { label: string; value: string; ids: string[]; commit: (v: string) => void; dead?: boolean }) {
  return (
    <select className="sx-pill" aria-label={label} value={value} inert={dead} onChange={(e) => commit(e.target.value)}>
      <StepOptions value={value} ids={ids} />
    </select>
  );
}
