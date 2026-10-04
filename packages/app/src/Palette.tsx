import type { StepKind } from '@reins/core';
import { KINDS } from './canvasKinds.js';
import { COND_KINDS } from './condKinds.js';

const GROUPS = [['Flow', 'Flow'], ['Memory', 'Memory · Knowl']] as const;

export function Palette({ onAdd, onCond }: { onAdd: (kind: StepKind) => void; onCond: (t: string) => void }) {
  const kinds = (Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].card);
  return (
    <section className="sx-pal" aria-label="Palette">
      {GROUPS.map(([section, title]) => (
        <div key={section}>
          <h4>{title}</h4>
          <div className="sx-pgrp">
            {kinds.filter((k) => KINDS[k].card!.section === section).map((k) => (
              <button key={k} className="sx-card" data-kind={k} onClick={() => onAdd(k)}><i />{KINDS[k].card!.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <h4>Conditions</h4>
        <div className="sx-pgrp">
          {Object.entries(COND_KINDS).map(([t, k]) => <button key={t} className="sx-card sx-condcard" onClick={() => onCond(t)}>{k.label}</button>)}
        </div>
      </div>
    </section>
  );
}
