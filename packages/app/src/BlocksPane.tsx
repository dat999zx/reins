import { useContext, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { Diagnostic, Step, Workflow } from '@reins/core';
import { KINDS, type Token } from './canvasKinds.js';
import { marksOf } from './canvas.js';
import { moveStep, nestPlace, placeOf, setAlways, type Place } from './blocks.js';
import { fieldValue } from './panelEdit.js';
import { useDraft } from './BlockPanel.js';
import { cx, StatusCtx } from './CanvasPane.js';
import { StepChips } from './StepChips.js';

export function BlocksPane({ w, steps, diags, text, selected, rev, onEdit, onSelect, onDelete }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; selected?: string; rev: unknown;
  onEdit: (fn: (w: Workflow) => Workflow) => boolean; onSelect: (id: string | undefined) => void; onDelete: (id: string) => void;
}) {
  const conds = Object.fromEntries(steps.flatMap((s) => (s.cond === undefined ? [] : [[s.id, s.cond]])));
  const marks = useMemo(() => marksOf(w, diags, text).steps, [w, diags, text]);
  const { status, show } = useContext(StatusCtx);
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | undefined>(undefined);

  // The model changes asynchronously (edit -> server print -> new w); focus follows the moved block once it re-renders.
  useEffect(() => {
    if (refocus.current !== undefined) root.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = undefined;
  }, [w]);
  const move = (id: string, to: Place) => { refocus.current = onEdit((m) => moveStep(m, id, to)) ? id : undefined; };

  // Stack and C blocks share these attributes. A click stops here: it must not bubble to every enclosing C block.
  const blockProps = (s: Step, shape: string, last: boolean) => {
    const info = show ? status[s.id] : undefined;
    const mark = marks.get(s.id);
    return {
      className: cx('blk', shape, s.id === selected && 'sx-sel', info?.state && `sx-${info.state}`, mark && `mark-${mark}`),
      'data-id': s.id,
      'data-kind': s.kind,
      tabIndex: 0,
      onClick: (e: MouseEvent) => { e.stopPropagation(); onSelect(s.id); },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.id); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDelete(s.id); return; }
        if (!e.altKey) return;
        const at = placeOf(w, s.id);
        const dest = { ArrowUp: at && at.index > 0 && { ...at, index: at.index - 1 }, ArrowDown: at && !last && { ...at, index: at.index + 2 },
          ArrowRight: nestPlace(w, s.id, 'in'), ArrowLeft: nestPlace(w, s.id, 'out') }[e.key];
        if (dest === undefined) return;
        e.preventDefault();
        if (dest) move(s.id, dest);
      },
    };
  };

  const token = (s: Step, t: Token, i: number): ReactNode => {
    if (t === 'cond') return <span key={i} className={cx('sx-hex', conds[s.id] === undefined && 'sx-hole')} data-hex={`${s.id}/`}>{conds[s.id] ?? '?'}</span>;
    if (t === 'sub') return <span key={i}>{KINDS[s.kind].sub(s, conds[s.id])}</span>;
    if (typeof t === 'string') return <b key={i}>{t}</b>;
    const f = KINDS[s.kind].fields.find((x) => x.key === t.field);
    const v = fieldValue(s, t.field);
    if (f?.input === 'textarea') return v ? <span key={i} className="sx-faint">{v.split('\n')[0]}</span> : null;
    const look = t.field === 'title' ? 'sx-bold' : f?.input === 'mono' ? 'sx-code' : f?.input === 'number' ? 'sx-pill sx-num' : 'sx-pill';
    return <span key={i} className={look}>{v}</span>;
  };

  const head = (s: Step) => {
    const info = show ? status[s.id] : undefined;
    return (
      <>
        <div className="sx-row"><span className="sx-grip" aria-hidden />{KINDS[s.kind].line.map((t, i) => token(s, t, i))}</div>
        {(s.cards.length > 0 || s.links.length > 0) && (
          <div className="sx-mods">
            {s.cards.map((c, i) => <span key={`c${i}`} className="sx-mod">{c.kind}: {c.text}</span>)}
            {s.links.map((l, i) => <span key={`l${i}`} className="sx-mod sx-link" data-lk={l.kind}>{l.kind} → {l.to}</span>)}
          </div>
        )}
        <span className="sx-st">{info && <StepChips i={info} />}</span>
      </>
    );
  };

  // A plain function, not a component: a component declared here would remount every block on each render.
  const stack = (items: Step[], parent: string | undefined, branch: 'kids' | 'else'): ReactNode => (
    <div className="sx-stack" data-list={`${parent ?? ''}/${branch}`}>
      {items.map((s, n) => {
        const key = items.findIndex((x) => x.id === s.id) === n ? s.id : `${n}/${s.id}`; // a duplicate id is a validator error; keep the keys unique anyway
        const group = KINDS[s.kind].group;
        if (!group) return <div key={key} {...blockProps(s, 'sx-blk', n === items.length - 1)}>{head(s)}</div>;
        return (
          <div key={key} {...blockProps(s, 'sx-c', n === items.length - 1)}>
            <div className="sx-chead">{head(s)}</div>
            <div className="sx-cbody" data-body={`${s.id}/kids`}>{stack(s.kids ?? [], s.id, 'kids')}</div>
            {group === 'kids+else' && (
              <>
                <div className="sx-cmid">else</div>
                <div className="sx-cbody" data-body={`${s.id}/else`}>{stack(s.else ?? [], s.id, 'else')}</div>
              </>
            )}
            <div className="sx-cfoot" />
          </div>
        );
      })}
    </div>
  );

  const clear = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.blk, .sx-hat, .always')) onSelect(undefined); };

  return (
    <div className="blocks" ref={root} onClick={clear}>
      <div className="sx-script">
        <div className="sx-blk sx-hat"><b>{w.name}</b>{w.task && <span className="sx-pill">{w.task}</span>}</div>
        {stack(w.steps, undefined, 'kids')}
      </div>
      <Always w={w} rev={rev} onEdit={onEdit} />
    </div>
  );
}

function Always({ w, rev, onEdit }: { w: Workflow; rev: unknown; onEdit: (fn: (w: Workflow) => Workflow) => boolean }) {
  const value = w.always.join('\n');
  const [v, setV] = useDraft(value, rev);
  return (
    <label className="always">Always
      <textarea rows={Math.max(2, w.always.length + 1)} value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v !== value) onEdit((m) => setAlways(m, v)); }} />
    </label>
  );
}
