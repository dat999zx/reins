import type { MutableRefObject, PointerEvent } from 'react';
import type { StepKind } from '@reins/core';
import { KINDS } from './canvasKinds.js';
import { COND_KINDS } from './condKinds.js';
import type { Src, Start } from './useDrag.js';

const GROUPS = [['Flow', 'Flow'], ['Memory', 'Memory · Knowl']] as const;

export function Palette({ onAdd, onCond, press }: {
  onAdd: (kind: StepKind) => void; onCond: (t: string) => void; press: MutableRefObject<Start | undefined>;
}) {
  const kinds = (Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].card);
  const drag = (src: Src) => ({ onPointerDown: (e: PointerEvent<HTMLElement>) => press.current?.(e.nativeEvent, src, e.currentTarget) });
  return (
    <section className="sx-pal" aria-label="Palette">
      {GROUPS.map(([section, title]) => (
        <div key={section}>
          <h4>{title}</h4>
          <div className="sx-pgrp">
            {kinds.filter((k) => KINDS[k].card!.section === section).map((k) => (
              <button key={k} className="sx-card" data-kind={k} onClick={() => onAdd(k)} {...drag({ kind: k })}><i />{KINDS[k].card!.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <h4>Conditions</h4>
        <div className="sx-pgrp">
          {Object.entries(COND_KINDS).map(([t, k]) => <button key={t} className="sx-card sx-condcard" onClick={() => onCond(t)} {...drag({ cond: t })}>{k.label}</button>)}
        </div>
      </div>
    </section>
  );
}
