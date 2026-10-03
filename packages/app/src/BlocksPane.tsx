import { Fragment, useContext, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Diagnostic, Step, StepKind, Workflow } from '@reins/core';
import { KINDS } from './canvasKinds.js';
import { marksOf } from './canvas.js';
import { moveStep, setAlways } from './blocks.js';
import { useDraft } from './BlockPanel.js';
import { cx, StatusCtx } from './CanvasPane.js';
import { StepChips } from './StepChips.js';

// ponytail: the arrows move a step only within its list; leaving a container needs a drag
// ponytail: native HTML5 drag; no touch, no keyboard drag (the arrows instead), no auto-scroll near the edge. Upgrade: dnd-kit, moveStep unchanged
export function BlocksPane({ w, steps, diags, text, selected, rev, onEdit, onSelect, onAdd }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; selected?: string; rev: unknown;
  onEdit: (fn: (w: Workflow) => Workflow) => void; onSelect: (id: string | undefined) => void; onAdd?: (kind: StepKind) => void;
}) {
  const conds = Object.fromEntries(steps.flatMap((s) => (s.cond === undefined ? [] : [[s.id, s.cond]])));
  const marks = useMemo(() => marksOf(w, diags, text).steps, [w, diags, text]);
  const { status, show } = useContext(StatusCtx);
  const move = (id: string, to: Parameters<typeof moveStep>[2]) => onEdit((m) => moveStep(m, id, to));
  const dragged = useRef<string | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>();

  // A leaf li per slot, so a nested container never handles a drop twice. The dragged id is in a ref: dataTransfer is unreadable during dragover.
  // A custom type, not text/plain: a drag that misses a drop line must not paste the id into a text field. The type list is readable during dragover, the data is not.
  const MIME = 'application/x-reins-step';
  const ours = (e: DragEvent<HTMLElement>) => !!dragged.current && e.dataTransfer.types.includes(MIME);
  const drop = (place: Parameters<typeof moveStep>[2]) => {
    const key = `${place.parent ?? ''}/${place.branch}/${place.index}`;
    return (
      <li className={cx('drop', over === key && 'over')} data-drop={key} onDragEnter={(e) => ours(e) && setOver(key)} onDragLeave={() => setOver((o) => (o === key ? undefined : o))}
        onDragOver={(e) => { if (ours(e)) e.preventDefault(); }}
        onDrop={(e) => { if (!ours(e)) return; e.preventDefault(); const id = dragged.current; dragged.current = undefined; setOver(undefined); if (id) move(id, place); }} />
    );
  };

  // A plain function, not a component: a component declared here would remount every row on each render.
  const list = (items: Step[], parent: string | undefined, branch: 'kids' | 'else') => (
    <ol>
      {items.map((s, n) => {
        const key = items.findIndex((x) => x.id === s.id) === n ? s.id : `${n}/${s.id}`; // a duplicate id is a validator error; keep the keys unique anyway
        const info = show ? status[s.id] : undefined;
        const mark = marks.get(s.id);
        const group = KINDS[s.kind].group;
        return (
          <Fragment key={key}>
          {drop({ parent, branch, index: n })}
          <li className="blk" data-id={s.id}>
            <div className={cx('cbox', 'bhead', s.id === selected && 'selected', info?.state, mark && `mark-${mark}`)} tabIndex={0} onClick={() => onSelect(s.id)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(s.id); } }}>
              <span className="grip" draggable aria-hidden onDragStart={(e) => { dragged.current = s.id; e.dataTransfer.setData(MIME, s.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => { dragged.current = undefined; setOver(undefined); }}>⠿</span>
              <span className="ckind">{s.kind}</span>
              <span className={cx('csub', s.kind === 'run' && 'mono')}>{KINDS[s.kind].sub(s, conds[s.id])}</span>
              {info && <StepChips i={info} />}
              <button aria-label={`Move ${s.id} up`} disabled={n === 0} onClick={() => move(s.id, { parent, branch, index: n - 1 })}>▲</button>
              <button aria-label={`Move ${s.id} down`} disabled={n === items.length - 1} onClick={() => move(s.id, { parent, branch, index: n + 2 })}>▼</button>
            </div>
            {group && list(s.kids ?? [], s.id, 'kids')}
            {group === 'kids+else' && <><div className="belse">else</div>{list(s.else ?? [], s.id, 'else')}</>}
          </li>
          </Fragment>
        );
      })}
      {drop({ parent, branch, index: items.length })}
    </ol>
  );

  return (
    <div className="blocks">
      <div className="bpal" role="toolbar" aria-label="Add a step">
        {(Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].fresh).map((k) => <button key={k} onClick={() => onAdd?.(k)}>{k}</button>)}
      </div>
      <Always w={w} rev={rev} onEdit={onEdit} />
      {list(w.steps, undefined, 'kids')}
    </div>
  );
}

function Always({ w, rev, onEdit }: { w: Workflow; rev: unknown; onEdit: (fn: (w: Workflow) => Workflow) => void }) {
  const value = w.always.join('\n');
  const [v, setV] = useDraft(value, rev);
  return (
    <label className="always">Always
      <textarea rows={Math.max(2, w.always.length + 1)} value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v !== value) onEdit((m) => setAlways(m, v)); }} />
    </label>
  );
}
