import { useContext, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import type { Cond, Diagnostic, Step, Workflow } from '@reins/core';
import { KINDS, wiresOf, type Token } from './canvasKinds.js';
import { applyParam, COND_KINDS, type CondParam } from './condKinds.js';
import { AGAINST, editStep, flatSteps, marksOf } from './canvas.js';
import { commitBudget, setCond, type CondPath } from './blocks.js';
import { fill } from './template.js';
import { applyField, budgetCount, budgetPatch, BUDGET_OVER, fieldValue, MODES, type BudgetKey } from './panelEdit.js';
import type { Pt } from './surface.js';
import { stepKey, type Key } from './selection.js';
import { splitAtEnd } from './arrange.js';
import { zoneAttrs, zoneKey, type Zone } from './gesture.js';
import type { Over } from './useDrag.js';
import { pickFor, usdText, type SessionModel } from './BlockPanel.js';
import { OptionPicker } from './OptionPicker.js';
import { Pill } from './Pill.js';
import { cx } from './generic.js';
import { ENDED, StatusCtx, StepChips } from './StepChips.js';

const LOOK = { code: 'code', str: 'pill', num: 'num', pill: 'pill' } as const satisfies Record<CondParam['look'], string>;

const HANDLE_TITLE: Record<string, string> = {
  next: 'Runs next when this block finishes. Drag to a block to link.',
  'on-fail': 'Runs if this block fails. Drag to a block to link.',
  against: "Compares this block's work against the block you drag this to. Drag to a block to link.",
};

export function BlocksPane({ w, diags, text, sel, primary, rev, models, efforts, sessionModel, sessionEffort, condDrag, src, over, linkOver, at, missing, loose, free, onEdit, onSelect }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; sel: Set<Key>; primary?: string; rev: unknown;
  models: Array<{ id: string; label: string }>; efforts: Array<{ id: string; label: string }>; sessionModel?: SessionModel; sessionEffort?: SessionModel;
  condDrag?: boolean; src?: Set<string>; over?: Over; linkOver?: string; at: Pt;
  missing?: Set<string>; // `from/index` of links whose target does not exist: the only links shown as chips (the others are arrows)
  loose?: { key: string; selected: boolean; moving: boolean; onPick: (add: boolean) => void }; // w is then a wrapper of the one parked step: read-only, no ids, no zones
  free?: { at: Map<string, Pt>; moving: Set<string> }; // the free blocks (steps behind the end) with a place of their own; the others stand in a column beside the script
  onEdit: (fn: (w: Workflow) => Workflow) => boolean; onSelect: (id: string, add: boolean) => void;
}) {
  const found = useMemo(() => (loose ? undefined : marksOf(w, diags, text)), [w, diags, text, !!loose]);
  const marks = found?.steps;
  const { status, show: showAll, ended, thinking } = useContext(StatusCtx);
  const show = showAll && !loose;
  const dead = !!loose || undefined; // a loose block is read-only: its controls are inert, the block itself still takes clicks
  const za = (z: Zone) => (loose ? {} : zoneAttrs(z));
  // the snap bar of the drop zone the pointer is over
  const ov = (z: Zone) => (!loose && over && zoneKey(over.el) === zoneKey(z) ? over.cls : undefined);
  const zone = (z: Zone) => ({ ...za(z), className: ov(z) });
  // Stack and C blocks share these attributes. A click stops here: it must not bubble to every enclosing C block.
  const name = (s: Step) => `${KINDS[s.kind].card?.label ?? s.kind} ${s.id}`;
  // The state cue is a child span, not a pseudo-element: ::before is the drop bar and ::after the notch. The ended mark is the same span.
  const stopped = (s: Step) => (show && ended?.id === s.id ? ended : undefined);
  const cue = (s: Step) => {
    const state = show ? status[s.id]?.state : undefined, end = stopped(s);
    return (state || end) && <span className={cx('sx-cue', state && `sx-cue-${state}`, end && `sx-cue-ended-${end.phase}`)} aria-hidden />;
  };
  const blockProps = (s: Step, shape: string, free = false) => {
    const info = show ? status[s.id] : undefined;
    const mark = marks?.get(s.id);
    return {
      className: cx('blk', shape, !loose && sel.has(stepKey(s.id)) && 'sx-sel', src?.has(s.id) && 'sx-dragsrc', !loose && linkOver === s.id && 'sx-linkover', info?.state && `sx-${info.state}`, mark && `mark-${mark}`),
      'data-id': loose ? undefined : s.id,
      'data-kind': s.kind,
      'data-colour': KINDS[s.kind]?.colour,
      'data-icon': KINDS[s.kind]?.icon,
      'data-stops': KINDS[s.kind]?.stops || undefined,
      role: loose ? undefined : ('group' as const), // a loose block is named by its wrapper
      'aria-label': loose ? undefined : `${free ? 'free ' : ''}${name(s)}`,
      'aria-current': !loose && primary === s.id ? ('true' as const) : undefined,
      title: found?.notes.get(s.id)?.join('\n'),
      'aria-description': found?.notes.get(s.id)?.join(' '),
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
        <select aria-label={`Condition of ${s.id}${at}`} value={c?.t ?? ''} inert={dead}
          onChange={(e) => onEdit((m) => setCond(m, s.id, p, COND_KINDS[e.target.value]!.fresh()))}>
          {!c && <option value="" disabled>?</option>}
          {Object.entries(COND_KINDS).map(([t, k]) => <option key={t} value={t}>{k.label}</option>)}
        </select>
        {c && param && (
          <Pill label={`Value of ${s.id} condition${at}`} value={val === undefined ? '' : String(val)} look={LOOK[param.look]} rev={rev} dead={dead} valid={(v) => applyParam(c, v) !== undefined}
            commit={(v) => { const n = applyParam(c, v); return n !== undefined && onEdit((m) => setCond(m, s.id, p, n)); }} />
        )}
      </span>
    );
  };

  const token = (s: Step, t: Token, i: number): ReactNode => {
    if (t === 'cond') return <span key={i}>{hex(s, s.cond, [])}</span>;
    if (t === 'sub') return <span key={i}>{fill(KINDS[s.kind].sub ?? '', s)}</span>;
    if (typeof t === 'string') return <b key={i}>{t}</b>;
    const f = KINDS[s.kind].fields.find((x) => x.key === t.field);
    const v = fieldValue(s, t.field);
    if (f?.input === 'textarea') return v ? <span key={i} className="sx-faint">{v.split('\n')[0]}</span> : f.required ? <span key={i} className="sx-faint">no prompt yet</span> : null;
    const label = `${f?.label} of ${s.id}`;
    const set = (nv: string) => onEdit((m) => editStep(m, s.id, (x) => applyField(x, t.field, nv)));
    if (f?.input === 'model' || f?.input === 'effort') {
      const pick = pickFor(f, { models, efforts, sessionModel, sessionEffort });
      return <OptionPicker key={i} className="sx-pill" label={label} options={pick.options} value={v} blank={pick.blank} other={pick.other} disabled={dead} onChange={set} />;
    }
    if (f?.input === 'mode') {
      return <select key={i} aria-label={label} className="sx-pill" value={v} inert={dead} onChange={(e) => set(e.target.value)}>
        {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>;
    }
    if (f?.input === 'step') { // set by the blue wire, or in the panel
      return <span key={i} className="sx-faint">{v ? flatSteps(w.steps).find((x) => x.id === v)?.title || v : 'drag the blue dot to a block'}</span>;
    }
    const look = t.field === 'title' ? 'bold' : f?.input === 'mono' ? 'code' : f?.input === 'number' ? 'num' : 'pill';
    return <Pill key={i} label={label} value={v} look={look} ph={f?.ph} rev={rev} dead={dead} valid={(nv) => applyField(structuredClone(s), t.field, nv)}
      commit={set} />;
  };

  const head = (s: Step) => {
    const info = show ? status[s.id] : undefined, end = stopped(s);
    // a loose block has no arrows, so it keeps all its link chips
    const wires = [...s.links.map((l, i) => ({ i, kind: l.kind as string, to: l.to })), ...(s.attrs.against ? [{ i: AGAINST, kind: 'against', to: s.attrs.against }] : [])];
    const chips = wires.flatMap((l) => ((loose && l.i !== AGAINST) || missing?.has(`${s.id}/${l.i}`) ? [<span key={`l${l.i}`} className={cx('sx-mod sx-link', !loose && 'sx-missing')} data-lk={l.kind}>{l.kind} → {l.to}</span>] : []));
    return (
      <>
        <div className="sx-row">
          <span className="sx-grip" aria-hidden />
          {KINDS[s.kind].line.map((t, i, all) => {
            const next = all[i + 1];
            if (typeof t === 'string' && next && typeof next === 'object') return null; // a word and its pill never separate: rendered together below
            const prev = all[i - 1];
            return typeof t === 'object' && typeof prev === 'string' ? <span key={i} className="sx-grp">{token(s, prev, i - 1)}{token(s, t, i)}</span> : token(s, t, i);
          })}
          {!loose && wiresOf(s.kind).map((k, _, all) => (
            <span key={k} className={cx('sx-handle', all.length === 2 && 'sx-two', all.length > 2 && 'sx-three')} data-zid={s.id} data-lk={k} title={HANDLE_TITLE[k]} aria-hidden />
          ))}
        </div>
        {(s.cards.length > 0 || chips.length > 0) && (
          <div className="sx-mods">
            {s.cards.map((c, i) => <span key={`c${i}`} className="sx-mod"><span className="sx-cardkind">{c.kind}:</span> {c.text}</span>)}
            {chips}
          </div>
        )}
        <span className="sx-st">
          {info && <StepChips i={info} thinking={info.state === 'active' && !KINDS[s.kind].group ? thinking : undefined} />}
          {end && <span className={`sstate sx-ended ${end.phase}`} role="img" aria-label={ENDED[end.phase]}>{ENDED[end.phase]}</span>}
        </span>
      </>
    );
  };

  // A plain function, not a component: a component declared here would remount every block on each render.
  // `top`: a free block's own list; its blocks are zones of the free block, not drop slots.
  const stack = (items: Step[], parent: string | undefined, branch: 'kids' | 'else', top = false): ReactNode => (
    <div className="sx-stack" data-list={`${parent ?? ''}/${branch}`}>
      {items.map((s, n) => {
        const key = items.findIndex((x) => x.id === s.id) === n ? s.id : `${n}/${s.id}`; // a duplicate id is a validator error; keep the keys unique anyway
        const group = KINDS[s.kind].group;
        const bp = blockProps(s, group ? 'sx-c' : 'sx-blk', top);
        // a stack block is one target, halves from the whole block (chips and pills included)
        if (!group) {
          const z = zone({ type: top ? 'free' : KINDS[s.kind].stops ? 'cap' : 'block', id: s.id });
          return <div key={key} {...bp} {...z} className={cx(bp.className, z.className)}>{cue(s)}{head(s)}</div>;
        }
        // ponytail: a drop on a body's own area, even beside its last child, lands first in that body (mockup behaviour); the snap bar shows it
        const head_ = zone({ type: top ? 'free' : 'chead', id: s.id }), kids = zone({ type: 'body', id: s.id, branch: 'kids' }), els = zone({ type: 'body', id: s.id, branch: 'else' }), foot = zone({ type: top ? 'free' : 'foot', id: s.id });
        return (
          <div key={key} {...bp}>
            {cue(s)}
            <div {...head_} className={cx('sx-chead', head_.className)}>{head(s)}</div>
            <div {...kids} className={cx('sx-cbody', kids.className)} data-body={`${s.id}/kids`}>{stack(s.kids ?? [], s.id, 'kids')}</div>
            {group === 'kids+else' && (
              <>
                <div {...za({ type: top ? 'free' : 'mid', id: s.id })} className="sx-cmid">else</div>
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
      <div className={cx('sx-loose', loose.selected && 'sx-sel', loose.moving && 'sx-moving', linkOver === `l:${loose.key}` && 'sx-linkover')} style={{ left: at.x, top: at.y }} data-loose={loose.key} data-zone="loose" tabIndex={0} role="group" aria-label={`loose ${name(w.steps[0]!)}`}>
        <span className="sx-loose-tag">loose</span>
        {stack(w.steps, undefined, 'kids')}
      </div>
    );
  }
  const hat = zone({ type: 'hat' }), end = zone({ type: 'end' });
  const { stack: inStack, end: cap, tail } = splitAtEnd(w);
  const place = (s: Step) => free?.at.get(s.id);
  const freeBlock = (s: Step) => {
    const p = place(s);
    return <div key={s.id} {...za({ type: 'free', id: s.id })} className={cx('sx-free', p && 'sx-placed', free?.moving.has(s.id) && 'sx-moving')} style={p && { left: p.x, top: p.y }}>{stack([s], undefined, 'kids', true)}</div>;
  };
  return (
    <>
      <div className={cx('sx-script', condDrag && 'sx-drag-cond')} style={{ left: at.x, top: at.y }}>
        <div {...hat} className={cx('sx-blk', 'sx-hat', hat.className)}><b>{w.name}</b>{w.task && <span className="sx-pill">{w.task}</span>}
          {!w.block && <HatBudget w={w} rev={rev} onEdit={onEdit} over={diags.find((d) => d.severity === 'error' && BUDGET_OVER.test(d.message))?.message} />}
        </div>
        {stack(cap ? [...inStack, cap] : inStack, undefined, 'kids')}
        <div {...end} className={cx('sx-endstrip', end.className)} />
        <div className="sx-autofree">{tail.filter((s) => !place(s)).map(freeBlock)}</div>
      </div>
      {tail.filter(place).map(freeBlock)}
    </>
  );
}

// The workflow's budget on the hat: the panel form's commit (commitBudget), a refusal as the pill's invalid state with its words.
// `pending` keeps a value the pair rule refused (Turns before Minutes) so the other pill's commit can write both.
function HatBudget({ w, rev, onEdit, over }: { w: Workflow; rev: unknown; onEdit: (fn: (w: Workflow) => Workflow) => boolean; over?: string }) {
  const pending = useRef<Partial<Record<BudgetKey, string>>>({});
  const b = w.budget;
  const drafts = (key: BudgetKey, raw: string) => ({ turns: pending.current.turns ?? budgetCount(b.turns), minutes: pending.current.minutes ?? budgetCount(b.minutes), [key]: raw });
  const pill = (key: BudgetKey, label: string, value: string, ph: string) => (
    <Pill label={label} value={value} look="num" ph={ph} rev={rev}
      why={(raw) => { const r = budgetPatch(key, raw, b, drafts(key, raw)); return 'error' in r ? r.error : undefined; }}
      commit={(raw) => {
        const r = commitBudget(w, key, raw, drafts(key, raw), onEdit);
        if (typeof r === 'string') pending.current[key] = raw;
        else pending.current = {};
        return r === true;
      }} />
  );
  return (
    <>
      {pill('turns', 'Turns of the workflow', budgetCount(b.turns), 'not set')}<b>turns</b>
      {pill('minutes', 'Minutes of the workflow', budgetCount(b.minutes), 'not set')}<b>min</b>
      <span className="sx-grp"><b>USD</b>{pill('usd', 'USD of the workflow', b.usd === undefined ? '' : usdText(b.usd), 'optional')}</span>
      {over && <div className="sx-bad">{over}</div>}
    </>
  );
}
