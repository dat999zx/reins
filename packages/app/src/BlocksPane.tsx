import { useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { Cond, Diagnostic, Step, StepKind, Workflow } from '@reins/core';
import { KINDS, type Token } from './canvasKinds.js';
import { applyParam, COND_KINDS, type CondParam } from './condKinds.js';
import { editStep, marksOf } from './canvas.js';
import { addStepAt, dropPlace, moveStep, nestPlace, newId, placeOf, setAlways, setCond, type CondPath, type Hit, type Place } from './blocks.js';
import { applyField, fieldValue } from './panelEdit.js';
import { useDraft } from './BlockPanel.js';
import { Pill, StepPick } from './Pill.js';
import { cx } from './generic.js';
import { StatusCtx, StepChips } from './StepChips.js';

const LOOK = { code: 'code', str: 'pill', num: 'num', pill: 'pill' } as const satisfies Record<CondParam['look'], string>;

export const STEP = 'application/x-reins-step';
export const KIND = 'application/x-reins-kind';
export const COND = 'application/x-reins-cond';

// What the pointer is over (`el` + `cls` name the snap preview) and what a drop there would mean (`hit`, or a hexagon).
type Zone = { el: string; cls: string; hit?: Hit; hex?: { id: string; path: CondPath } };
type Over = { el: string; cls: string; place?: Place; hex?: Zone['hex'] };

// ponytail: native HTML5 drag; no touch, no auto-scroll near the edge. Upgrade: pointer-event drag, `dropPlace` unchanged.
export function BlocksPane({ w, steps, diags, text, selected, rev, dragging, onEdit, onSelect, onDelete }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; selected?: string; rev: unknown;
  dragging?: 'step' | 'cond';
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

  // The data of a drag is not readable during dragover, so the dragged step id also lives in a ref, and `zone` / `over` cache the last decision.
  const [over, setOver] = useState<Over>();
  const [src, setSrc] = useState<string>();
  const drag = useRef<{ step?: string; zone?: string; over?: Over }>({});
  const ov = (el: string) => (over?.el === el ? over.cls : undefined);
  const leaveZone = () => { drag.current.zone = undefined; drag.current.over = undefined; setOver(undefined); };
  const endDrag = () => { drag.current = {}; setSrc(undefined); setOver(undefined); };
  useEffect(() => { if (!dragging) endDrag(); }, [dragging]); // a palette drag ends in the palette, never here
  // Legality is asked of the same pure functions that do the edit: a drop is legal iff it would change the model.
  const legal = (z: Zone, types: readonly string[]): Over | undefined => {
    const place = z.hit && dropPlace(w, z.hit);
    const step = drag.current.step;
    const ok = types.includes(STEP) ? place && step !== undefined && moveStep(w, step, place) !== w
      : types.includes(KIND) ? place && addStepAt(w, 'phase', place) !== w
        : types.includes(COND) && z.hex && setCond(w, z.hex.id, z.hex.path, { t: 'approve' }) !== w;
    return ok ? { el: z.el, cls: z.cls, place, hex: z.hex } : undefined;
  };
  const target = (pick: (half: 'top' | 'bottom') => Zone) => {
    const zone = (e: DragEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      return pick(e.clientY < r.top + r.height / 2 ? 'top' : 'bottom');
    };
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        const z = zone(e);
        if (z.hex && !e.dataTransfer.types.includes(COND)) return; // a step over a hexagon falls through to its block
        e.stopPropagation();
        if (drag.current.zone !== z.el + z.cls) {
          drag.current.zone = z.el + z.cls;
          drag.current.over = legal(z, e.dataTransfer.types);
          setOver(drag.current.over);
        }
        if (!drag.current.over) return; // no preventDefault: the browser shows no-drop and `drop` never fires
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(STEP) ? 'move' : 'copy';
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        const z = zone(e);
        if (z.hex && !e.dataTransfer.types.includes(COND)) return;
        e.stopPropagation();
        const o = legal(z, e.dataTransfer.types);
        const dt = e.dataTransfer;
        endDrag();
        if (!o) return;
        e.preventDefault();
        const { place, hex: hx } = o;
        if (dt.types.includes(STEP) && place) move(dt.getData(STEP), place);
        else if (dt.types.includes(KIND) && place) {
          const kind = dt.getData(KIND) as StepKind;
          if (onEdit((m) => addStepAt(m, kind, place))) onSelect(newId(w, kind));
        } else if (dt.types.includes(COND) && hx && COND_KINDS[dt.getData(COND)]) {
          const fresh = COND_KINDS[dt.getData(COND)]!.fresh;
          onEdit((m) => setCond(m, hx.id, hx.path, fresh()));
        }
      },
    };
  };
  const sides = (el: string, id: string) => (h: 'top' | 'bottom'): Zone =>
    h === 'top' ? { el, cls: 'sx-before', hit: { block: id, edge: 'before' } } : { el, cls: 'sx-after', hit: { block: id, edge: 'after' } };

  // Stack and C blocks share these attributes. A click stops here: it must not bubble to every enclosing C block.
  const blockProps = (s: Step, shape: string, last: boolean) => {
    const info = show ? status[s.id] : undefined;
    const mark = marks.get(s.id);
    return {
      className: cx('blk', shape, s.id === selected && 'sx-sel', s.id === src && 'sx-dragsrc', info?.state && `sx-${info.state}`, mark && `mark-${mark}`),
      'data-id': s.id,
      'data-kind': s.kind,
      tabIndex: 0,
      onClick: (e: MouseEvent) => { e.stopPropagation(); onSelect(s.id); },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.id); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDelete(s.id); return; }
        if (!e.altKey || !e.key.startsWith('Arrow')) return;
        e.preventDefault(); // Alt+Left / Alt+Right are the browser's Back / Forward: always swallow them on a block
        const at = placeOf(w, s.id);
        const dest = { ArrowUp: at && at.index > 0 && { ...at, index: at.index - 1 }, ArrowDown: at && !last && { ...at, index: at.index + 2 },
          ArrowRight: nestPlace(w, s.id, 'in'), ArrowLeft: nestPlace(w, s.id, 'out') }[e.key];
        if (dest) move(s.id, dest);
      },
    };
  };

  // A plain recursive function. `p` is the path from the step's condition to this node.
  const hex = (s: Step, c: Cond | undefined, p: CondPath): ReactNode => {
    const at = p.length ? ` at ${p.join('.')}` : '';
    const key = `${s.id}/${p.join('.')}`;
    const drop = target(() => ({ el: `x:${key}`, cls: 'sx-hexover', hex: { id: s.id, path: p } }));
    const own = cx('sx-hex', ov(`x:${key}`));
    if (c && 'a' in c) {
      const b = 'b' in c ? c.b : undefined;
      return (
        <span key={key} className={own} data-hex={key}>
          {c.t === 'not' && <b>not</b>}{hex(s, c.a, [...p, 'a'])}{b && <><b>{c.t}</b>{hex(s, b, [...p, 'b'])}</>}
        </span>
      );
    }
    const kind = c && COND_KINDS[c.t];
    if (c && !kind) return <span key={key} className={own} data-hex={key} {...drop}>{c.t}</span>;
    const param = kind?.param;
    const val = c && param ? (c as unknown as Record<string, unknown>)[param.key] : undefined;
    return (
      <span key={key} className={cx(own, !c && 'sx-hole')} data-hex={key} {...drop}>
        <select aria-label={`Condition of ${s.id}${at}`} value={c?.t ?? ''}
          onChange={(e) => onEdit((m) => setCond(m, s.id, p, COND_KINDS[e.target.value]!.fresh()))}>
          {!c && <option value="" disabled>?</option>}
          {Object.entries(COND_KINDS).map(([t, k]) => <option key={t} value={t}>{k.label}</option>)}
        </select>
        {c && param && (
          <Pill label={`Value of ${s.id} condition${at}`} value={val === undefined ? '' : String(val)} look={LOOK[param.look]} rev={rev}
            commit={(v) => { const n = applyParam(c, v); return n !== undefined && onEdit((m) => setCond(m, s.id, p, n)); }} />
        )}
      </span>
    );
  };

  const token = (s: Step, t: Token, i: number): ReactNode => {
    if (t === 'cond') return <span key={i}>{hex(s, s.cond, [])}</span>;
    if (t === 'sub') return <span key={i}>{KINDS[s.kind].sub?.(s, conds[s.id]) ?? ''}</span>;
    if (typeof t === 'string') return <b key={i}>{t}</b>;
    const f = KINDS[s.kind].fields.find((x) => x.key === t.field);
    const v = fieldValue(s, t.field);
    if (f?.input === 'textarea') return v ? <span key={i} className="sx-faint">{v.split('\n')[0]}</span> : null;
    const label = `${f?.label} of ${s.id}`;
    if (f?.input === 'step') {
      const ids = steps.filter((x) => x.id !== s.id).map((x) => x.id);
      return <StepPick key={i} label={label} value={v} ids={ids} commit={(nv) => onEdit((m) => editStep(m, s.id, (x) => applyField(x, t.field, nv)))} />;
    }
    const look = t.field === 'title' ? 'bold' : f?.input === 'mono' ? 'code' : f?.input === 'number' ? 'num' : 'pill';
    return <Pill key={i} label={label} value={v} look={look} rev={rev} commit={(nv) => onEdit((m) => editStep(m, s.id, (x) => applyField(x, t.field, nv)))} />;
  };

  const head = (s: Step) => {
    const info = show ? status[s.id] : undefined;
    return (
      <>
        <div className="sx-row">
          <span className="sx-grip" draggable aria-hidden onDragEnd={endDrag}
            onDragStart={(e) => {
              e.dataTransfer.setData(STEP, s.id);
              e.dataTransfer.effectAllowed = 'move';
              const blk = e.currentTarget.closest('.blk');
              if (blk) e.dataTransfer.setDragImage(blk, 12, 12);
              drag.current.step = s.id;
              // dimmed after the browser took the drag image, so the image is the block as it was
              setTimeout(() => { if (drag.current.step === s.id) setSrc(s.id); }, 0);
            }} />
          {KINDS[s.kind].line.map((t, i) => token(s, t, i))}
        </div>
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
    <div className={cx('sx-stack', parent === undefined && ov('end'))} data-list={`${parent ?? ''}/${branch}`}>
      {items.map((s, n) => {
        const key = items.findIndex((x) => x.id === s.id) === n ? s.id : `${n}/${s.id}`; // a duplicate id is a validator error; keep the keys unique anyway
        const group = KINDS[s.kind].group;
        const bp = blockProps(s, group ? 'sx-c' : 'sx-blk', n === items.length - 1);
        // a stack block is one target, halves from the whole block (chips and pills included)
        if (!group) return <div key={key} {...bp} className={cx(bp.className, ov(s.id))} {...target(sides(s.id, s.id))}>{head(s)}</div>;
        const kids = `b:${s.id}/kids`;
        // ponytail: a drop on a body's own area, even beside its last child, lands first in that body (mockup behaviour); the snap bar shows it
        const body = (b: 'kids' | 'else') => ({ el: `b:${s.id}/${b}`, cls: 'sx-into', hit: { body: s.id, branch: b } });
        return (
          <div key={key} {...bp}>
            <div className={cx('sx-chead', ov(`h:${s.id}`))}
              {...target((h) => (h === 'top' ? sides(`h:${s.id}`, s.id)(h) : { el: kids, cls: 'sx-into', hit: { block: s.id, edge: 'into' } }))}>{head(s)}</div>
            <div className={cx('sx-cbody', ov(kids))} data-body={`${s.id}/kids`} {...target(() => body('kids'))}>{stack(s.kids ?? [], s.id, 'kids')}</div>
            {group === 'kids+else' && (
              <>
                <div className="sx-cmid" {...target(() => ({ el: `b:${s.id}/else`, cls: 'sx-into', hit: { block: s.id, edge: 'else' } }))}>else</div>
                <div className={cx('sx-cbody', ov(`b:${s.id}/else`))} data-body={`${s.id}/else`} {...target(() => body('else'))}>{stack(s.else ?? [], s.id, 'else')}</div>
              </>
            )}
            <div className={cx('sx-cfoot', ov(`f:${s.id}`))} {...target(() => ({ el: `f:${s.id}`, cls: 'sx-after', hit: { block: s.id, edge: 'after' } }))} />
          </div>
        );
      })}
    </div>
  );

  const clear = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.blk, .sx-hat, .always')) onSelect(undefined); };

  return (
    <div className={cx('blocks', dragging === 'cond' && 'sx-drag-cond')} ref={root} onClick={clear}
      onDragOver={() => { if (drag.current.zone) leaveZone(); }}
      onDragLeave={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) leaveZone(); }}>
      <div className="sx-script" {...target(() => ({ el: 'end', cls: 'sx-end', hit: { top: 'end' } }))}>
        <div className={cx('sx-blk', 'sx-hat', ov('hat'))} {...target(() => ({ el: 'hat', cls: 'sx-after', hit: { top: 'start' } }))}><b>{w.name}</b>{w.task && <span className="sx-pill">{w.task}</span>}</div>
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
