import type { DragEvent } from 'react';
import type { StepKind } from '@reins/core';
import { KINDS } from './canvasKinds.js';
import { COND_KINDS } from './condKinds.js';
import { COND, KIND } from './BlocksPane.js';

const GROUPS = [['Flow', 'Flow'], ['Memory', 'Memory · Knowl']] as const;

export function Palette({ onAdd, onCond, onDrag }: {
  onAdd: (kind: StepKind) => void; onCond: (t: string) => void; onDrag: (what: 'step' | 'cond' | undefined) => void;
}) {
  const kinds = (Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].card);
  const drag = (mime: string, data: string, what: 'step' | 'cond') => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => { e.dataTransfer.setData(mime, data); e.dataTransfer.effectAllowed = 'copy'; onDrag(what); },
    onDragEnd: () => onDrag(undefined),
  });
  return (
    <section className="sx-pal" aria-label="Palette">
      {GROUPS.map(([section, title]) => (
        <div key={section}>
          <h4>{title}</h4>
          <div className="sx-pgrp">
            {kinds.filter((k) => KINDS[k].card!.section === section).map((k) => (
              <button key={k} className="sx-card" data-kind={k} onClick={() => onAdd(k)} {...drag(KIND, k, 'step')}><i />{KINDS[k].card!.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <h4>Conditions</h4>
        <div className="sx-pgrp">
          {Object.entries(COND_KINDS).map(([t, k]) => <button key={t} className="sx-card sx-condcard" onClick={() => onCond(t)} {...drag(COND, t, 'cond')}>{k.label}</button>)}
        </div>
      </div>
    </section>
  );
}
