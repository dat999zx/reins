import { useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import type { Cond, Diagnostic, Step, Workflow } from '@reins/core';
import { KINDS, type Token } from './canvasKinds.js';
import { applyParam, COND_KINDS, type CondParam } from './condKinds.js';
import { editStep, marksOf } from './canvas.js';
import { setCond, type CondPath } from './blocks.js';
import { applyField, fieldValue } from './panelEdit.js';
import type { Pt } from './surface.js';
import { stepKey, type Key } from './selection.js';
import { zoneAttrs, zoneKey, type Zone } from './gesture.js';
import type { Over } from './useDrag.js';
import { Pill, StepPick } from './Pill.js';
import { cx } from './generic.js';
import { StatusCtx, StepChips } from './StepChips.js';

const LOOK = { code: 'code', str: 'pill', num: 'num', pill: 'pill' } as const satisfies Record<CondParam['look'], string>;

export function BlocksPane({ w, steps, diags, text, sel, rev, condDrag, src, over, at, loose, onEdit, onSelect }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; sel: Set<Key>; rev: unknown;
  condDrag?: boolean; src?: Set<string>; over?: Over; at: Pt;
  loose?: { key: string; selected: boolean; onPick: (add: boolean) => void }; // w is then a wrapper of the one parked step: read-only, no ids, no zones
  onEdit: (fn: (w: Workflow) => Workflow) => boolean; onSelect: (id: string, add: boolean) => void;
}) {
  const conds = Object.fromEntries(steps.flatMap((s) => (s.cond === undefined ? [] : [[s.id, s.cond]])));
  const marks = useMemo(() => (loose ? undefined : marksOf(w, diags, text).steps), [w, diags, text, !!loose]);
  const { status, show: showAll } = useContext(StatusCtx);
  const show = showAll && !loose;
  const za = (z: Zone) => (loose ? {} : zoneAttrs(z));
  // the snap bar of the drop zone the pointer is over
  const ov = (z: Zone) => (!loose && over && zoneKey(over.el) === zoneKey(z) ? over.cls : undefined);
  const zone = (z: Zone) => ({ ...za(z), className: ov(z) });
  // Stack and C blocks share these attributes. A click stops here: it must not bubble to every enclosing C block.
  const blockProps = (s: Step, shape: string) => {
    const info = show ? status[s.id] : undefined;
    const mark = marks?.get(s.id);
    return {
      className: cx('blk', shape, !loose && sel.has(stepKey(s.id)) && 'sx-sel', src?.has(s.id) && 'sx-dragsrc', info?.state && `sx-${info.state}`, mark && `mark-${mark}`),
      'data-id': loose ? undefined : s.id,
      'data-kind': s.kind,
      tabIndex: loose ? -1 : 0,
      onClick: (e: MouseEvent) => { e.stopPropagation(); const add = e.shiftKey || e.ctrlKey || e.metaKey; if (loose) loose.onPick(add); else onSelect(s.id, add); },
    };
  };

  // A plain recursive function. `p` is the path from the step's condition to this node.
  const hex = (s: Step, c: Cond | undefined, p: CondPath): ReactNode => {
    const at = p.length ? ` at ${p.join('.')}` : '';
    const key = `${s.id}/${p.join('.')}`;
    const z: Zone = { type: 'hex', id: s.id, path: p.join('.') };
    const own = cx('sx-hex', ov(z));
    const drop = za(z);
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
          <span className="sx-grip" aria-hidden />
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
    <div className="sx-stack" data-list={`${parent ?? ''}/${branch}`}>
      {items.map((s, n) => {
        const key = items.findIndex((x) => x.id === s.id) === n ? s.id : `${n}/${s.id}`; // a duplicate id is a validator error; keep the keys unique anyway
        const group = KINDS[s.kind].group;
        const bp = blockProps(s, group ? 'sx-c' : 'sx-blk');
        // a stack block is one target, halves from the whole block (chips and pills included)
        if (!group) {
          const z = zone({ type: s.kind === 'end' ? 'cap' : 'block', id: s.id });
          return <div key={key} {...bp} {...z} className={cx(bp.className, z.className)}>{head(s)}</div>;
        }
        // ponytail: a drop on a body's own area, even beside its last child, lands first in that body (mockup behaviour); the snap bar shows it
        const head_ = zone({ type: 'chead', id: s.id }), kids = zone({ type: 'body', id: s.id, branch: 'kids' }), els = zone({ type: 'body', id: s.id, branch: 'else' }), foot = zone({ type: 'foot', id: s.id });
        return (
          <div key={key} {...bp}>
            <div {...head_} className={cx('sx-chead', head_.className)}>{head(s)}</div>
            <div {...kids} className={cx('sx-cbody', kids.className)} data-body={`${s.id}/kids`}>{stack(s.kids ?? [], s.id, 'kids')}</div>
            {group === 'kids+else' && (
              <>
                <div {...za({ type: 'mid', id: s.id })} className="sx-cmid">else</div>
                <div {...els} className={cx('sx-cbody', els.className)} data-body={`${s.id}/else`}>{stack(s.else ?? [], s.id, 'else')}</div>
              </>
            )}
            <div {...foot} className={cx('sx-cfoot', foot.className)} />
          </div>
        );
      })}
    </div>
  );

  if (loose) {
    return (
      <div className={cx('sx-loose', loose.selected && 'sx-sel')} style={{ left: at.x, top: at.y }} data-loose={loose.key} data-zone="loose" tabIndex={0} aria-label="Loose block">
        <span className="sx-loose-tag">loose</span>
        {stack(w.steps, undefined, 'kids')}
      </div>
    );
  }
  const hat = zone({ type: 'hat' }), end = zone({ type: 'end' });
  return (
    <div className={cx('sx-script', condDrag && 'sx-drag-cond')} style={{ left: at.x, top: at.y }}>
      <div {...hat} className={cx('sx-blk', 'sx-hat', hat.className)}><b>{w.name}</b>{w.task && <span className="sx-pill">{w.task}</span>}</div>
      {stack(w.steps, undefined, 'kids')}
      <div {...end} className={cx('sx-endstrip', end.className)} />
    </div>
  );
}
