import type { StepKind } from '@reins/core';
import { KINDS } from './canvasKinds.js';

const GROUPS = [['Flow', 'Flow'], ['Memory', 'Memory · Knowl']] as const;

export function Palette({ onAdd }: { onAdd: (kind: StepKind) => void }) {
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
    </section>
  );
}