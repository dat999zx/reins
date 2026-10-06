import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as KeyEvent, type MouseEvent as MouseEv, type MutableRefObject, type PointerEvent } from 'react';
import type { Diagnostic, Step, Workflow } from '@reins/core';
import { BlocksPane } from './BlocksPane.js';
import { ContextMenu } from './ContextMenu.js';
import { itemsFor, type MenuCtx, type MenuTarget } from './menus.js';
import { addLoose, FULL, HOME, LOOSE_MAX, moveItems, park, removeLoose, selfContained, unpark } from './arrange.js';
import { addStepAt, capBackward, dropPlace, dropSteps, duplicateSteps, moveStep, nestPlace, newId, placeOf, setCond, takeSteps, type Hit, type Place } from './blocks.js';
import { KINDS } from './canvasKinds.js';
import { flatSteps, marksOf } from './canvas.js';
import { lanes, linksToDraw } from './arrows.js';
import { LinkLayer } from './LinkLayer.js';
import { COND_KINDS } from './condKinds.js';
import type { Layout } from './editorState.js';
import { cx } from './generic.js';
import { DRAG_PX, pickGesture, type Press } from './gesture.js';
import { isTyping, matchKey, type ActName } from './keys.js';
import { allKeys, boxSelect, stepIds, stepKey, toggle, withoutNested, type Key } from './selection.js';
import { fitBounds, toWorld, ZOOM, zoomAt, type Cam, type Pt, type Rect } from './surface.js';
import { useDrag, type Start } from './useDrag.js';

// ponytail: in-app clipboard, lost on reload; the system clipboard if it matters
let clip: Step[] = [];
export type EditOpts = { lay?: (l: Layout) => Layout; then?: (applied: boolean) => void };
const NATIVE = 'input, textarea, select, option, button, .sx-menu, .sx-zoom';
const onOf = (t: Element): Press['on'] => (t.closest(NATIVE) ? 'input' : t.closest('.sx-hat') ? 'hat' : t.closest('.sx-loose') ? 'loose' : t.closest('.blk') ? 'block' : 'empty');

export function Workspace({ w, steps, diags, text, sel, rev, cam: saved, lay, press, onEdit, onSel, onDelete, onCam, onLayout, onUndo, onRedo, onNote, onEditInText }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; sel: Set<Key>; rev: unknown;
  cam?: Cam; lay: Layout; press: MutableRefObject<Start | undefined>;
  onEdit: (fn: (w: Workflow) => Workflow, o?: EditOpts) => boolean; onSel: (keys: Set<Key>, primary?: string) => void; onDelete: (keys: Key[]) => void; onCam: (c: Cam) => void;
  onLayout: (fn: (l: Layout) => Layout) => boolean; onUndo: () => void; onRedo: () => void; onNote: (s: string) => void; onEditInText: (line: number) => void;
}) {
  const view = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Cam>(saved ?? { x: 0, y: 0, zoom: 1 });
  const camRef = useRef(cam);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState<Rect>();
  const [menu, setMenu] = useState<{ t: MenuTarget; id: string; at: Pt; opener: HTMLElement }>();
  const space = useRef(false);
  const set = (c: Cam) => { camRef.current = c; setCam(c); };
  const commit = (c: Cam) => { set(c); onCam(c); };

  const size = () => view.current!.getBoundingClientRect();
  const zoom = (f: number) => { const r = size(); commit(zoomAt(camRef.current, { x: r.width / 2, y: r.height / 2 }, f)); };
  const fit = () => {
    const s = view.current?.querySelector('.sx-script');
    if (!s) return;
    const r = size(), b = s.getBoundingClientRect(), c = camRef.current;
    const o = toWorld(c, { x: b.left - r.left, y: b.top - r.top });
    commit(fitBounds({ ...o, w: b.width / c.zoom, h: b.height / c.zoom }, { w: r.width, h: r.height }));
  };
  useLayoutEffect(() => { if (!saved) fit(); }, []);

  // Arrows: each block's first row, measured once per model change or size change in the script's own coordinates, so a hat drag or a zoom needs no measuring.
  const [rects, setRects] = useState(new Map<string, Rect>());
  const measure = () => {
    const s = view.current?.querySelector<HTMLElement>('.sx-script');
    if (!s) return;
    const o = s.getBoundingClientRect(), z = camRef.current.zoom, q = (v: number) => Math.round((v / z) * 100) / 100;
    const next = new Map<string, Rect>();
    for (const el of s.querySelectorAll<HTMLElement>('.blk[data-id]')) {
      const b = el.getBoundingClientRect(), row = el.querySelector('.sx-row')?.getBoundingClientRect() ?? b;
      next.set(el.dataset.id!, { x: q(b.left - o.left), y: q(row.top - o.top), w: q(b.width), h: q(row.height) });
    }
    setRects((p) => (JSON.stringify([...p]) === JSON.stringify([...next]) ? p : next));
  };
  useLayoutEffect(measure, [w, diags, text]);
  useEffect(() => {
    const s = view.current!.querySelector('.sx-script');
    if (!s) return;
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    return () => ro.disconnect();
  }, []);
  const wires = useMemo(() => marksOf(w, diags, text).wires, [w, diags, text]);
  const { arrows, missing } = useMemo(() => linksToDraw(w, wires), [w, wires]);
  const lane = useMemo(() => lanes(arrows, flatSteps(w.steps).map((s) => s.id)), [arrows, w]);
  const gone = useMemo(() => new Set(missing.map((m) => `${m.from}/${m.index}`)), [missing]);

  // The model changes asynchronously (edit -> server print -> new w); focus follows the moved block once it re-renders.
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (refocus.current !== undefined) view.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = undefined;
  }, [w]);
  // Every move is one edit; a link the move turned backward gets its max, and the note says which.
  const capNote = (capped: string[]) => `Added max 3 to ${capped.length === 1 ? '1 link that now points' : `${capped.length} links that now point`} back: ${capped.join(', ')}.`;
  const moved = (fn: (m: Workflow) => Workflow) => {
    let capped: string[] = [];
    const sent = onEdit((m) => { const d = fn(m); if (d === m) return m; const r = capBackward(d); capped = r.capped; return r.w; });
    if (sent && capped.length) onNote(capNote(capped));
    return sent;
  };
  const move = (id: string, to: Place) => { refocus.current = moved((m) => moveStep(m, id, to)) ? id : undefined; };

  const one = (id?: string) => onSel(new Set(id === undefined ? [] : [stepKey(id)]), id);
  const pick = (id: string, add: boolean) => {
    if (!add) return one(id);
    const k = stepKey(id), n = toggle(sel, k);
    onSel(n, n.has(k) ? id : stepIds(n).at(-1));
  };
  const top = () => stepIds(withoutNested(w, sel));
  const looseSel = () => (lay.loose ?? []).filter((l) => sel.has(`l:${l.key}`));
  const pickLoose = (key: string, add: boolean) => {
    const k = `l:${key}`, n = add ? toggle(sel, k) : new Set([k]);
    onSel(n, add ? stepIds(n).at(-1) : undefined);
  };
  const ptr = useRef<Pt | undefined>(undefined);
  const pasted = useRef<{ x: number; y: number; n: number } | undefined>(undefined);
  // Loose blocks are only in the editor state; the new ones become the selection.
  const stash = (steps: Step[], at: Pt[]) => {
    let keys: string[] = [];
    const ok = onLayout((l) => { const r = addLoose(l, steps, at); keys = r.keys; return r.lay; });
    if (ok) onSel(new Set(keys.map((k) => `l:${k}`)));
    else if ((lay.loose?.length ?? 0) + steps.length > LOOSE_MAX) onNote(FULL);
  };
  // Park: the steps leave the file and become loose blocks, keeping their offsets from the block that was grabbed.
  const parkIds = (ids: string[], grabbed: string, at: Pt) => {
    const r = park(w, ids);
    if (r.w === w) return;
    if ((lay.loose?.length ?? 0) + r.steps.length > LOOSE_MAX) return onNote(FULL);
    const box = (id: string) => view.current!.querySelector(`.blk[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    const o = box(grabbed), z = camRef.current.zoom;
    const pts = r.steps.map((s) => { const b = box(s.id); return b && o ? { x: at.x + (b.left - o.left) / z, y: at.y + (b.top - o.top) / z } : at; });
    let keys: string[] = [];
    onEdit(() => r.w, {
      lay: (l) => { const a = addLoose(l, r.steps, pts); keys = a.keys; return a.lay; },
      then: (ok) => {
        if (!ok) return;
        onSel(new Set(keys.map((k) => `l:${k}`)));
        const n = r.lost.length;
        onNote(`Parked ${r.steps.map((s) => `\`${s.id}\``).join(', ')}.${n ? ` Removed ${n} link${n > 1 ? 's' : ''}: ${r.lost.join(', ')}.` : ''} Ctrl+Z puts it back.`);
      },
    });
  };
  // Unpark: loose blocks go into the file at the slot; they leave the parking area in the same undo step.
  const looseOf = (keys: string[]) => (lay.loose ?? []).filter((l) => keys.includes(`l:${l.key}`));
  const unparkTo = (keys: string[], hit: Hit) => {
    const lo = looseOf(keys);
    let r: ReturnType<typeof unpark> | undefined;
    onEdit((m) => { const to = dropPlace(m, hit); r = to && unpark(m, lo.map((l) => l.step), to); return r?.w ?? m; }, {
      lay: (l) => removeLoose(l, lo.map((x) => x.key)),
      then: (ok) => {
        if (!ok || !r) return;
        refocus.current = r.ids[0];
        onSel(new Set(r.ids.map(stepKey)), r.ids.at(-1));
        if (r.capped.length) onNote(capNote(r.capped));
      },
    });
  };
  const copy = () => {
    const s = selfContained([...takeSteps(w, top()).taken, ...looseSel().map((l) => l.step)]);
    if (s.length) clip = s;
    return s.length > 0;
  };
  // Pasted blocks are always loose, at the pointer (or the view's centre); the same point again steps 24 px.
  const paste = () => {
    if (!clip.length) return;
    const r = view.current!.getBoundingClientRect(), p = ptr.current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const base = toWorld(camRef.current, { x: p.x - r.left, y: p.y - r.top }), last = pasted.current;
    const n = last && last.x === base.x && last.y === base.y ? last.n + 1 : 0;
    pasted.current = { ...base, n };
    stash(clip, clip.map((_, i) => ({ x: base.x + 24 * (n + i), y: base.y + 24 * (n + i) })));
  };
  const duplicate = () => {
    const ids = top(), lo = looseSel();
    let made: string[] = [], keys: string[] = [];
    const parkLoose = (l: Layout) => { const r = addLoose(l, lo.map((x) => x.step), lo.map((x) => ({ x: x.at.x + 24, y: x.at.y + 24 }))); keys = r.keys; return r.lay; };
    if (!ids.length) return void (lo.length && onLayout(parkLoose) && onSel(new Set(keys.map((k) => `l:${k}`))));
    onEdit((m) => { const r = duplicateSteps(m, ids); made = r.ids; return r.w; }, {
      ...(lo.length && { lay: parkLoose }),
      then: (ok) => { if (ok) onSel(new Set([...made.map(stepKey), ...keys.map((k) => `l:${k}`)]), made.at(-1)); },
    });
  };

  // The menu is about one thing: select it first unless it is already selected. `at` is in view coordinates; a loose block's id is its key.
  const openMenu = (t: MenuTarget, id: string, at: Pt, opener: HTMLElement) => {
    if (t === 'block' && !sel.has(stepKey(id))) one(id);
    if (t === 'loose' && !sel.has(`l:${id}`)) pickLoose(id, false);
    setMenu({ t, id, at, opener });
  };
  const menuCtx = (m: { id: string }): MenuCtx => {
    const s = flatSteps(w.steps).find((x) => x.id === m.id);
    return { count: sel.size, topLevel: !!s && placeOf(w, s.id)?.parent === undefined, free: false, isEnd: s?.kind === 'end', clip: clip.length > 0 };
  };
  const contextmenu = (e: MouseEv<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest('.sx-menu')) return e.preventDefault(); // the ContextMenu key's event can land on the menu's new focus
    if (t.closest('input, textarea, select, .sx-zoom')) return; // the browser's own menu
    e.preventDefault();
    const r = view.current!.getBoundingClientRect(), at = { x: e.clientX - r.left, y: e.clientY - r.top };
    const lo = t.closest<HTMLElement>('.sx-loose'), blk = t.closest<HTMLElement>('.blk[data-id]');
    if (lo) openMenu('loose', lo.dataset.loose!, at, lo);
    else if (blk) openMenu('block', blk.dataset.id!, at, blk);
    else openMenu('surface', '', at, view.current!);
  };
  const last = (id: string) => {
    const at = placeOf(w, id);
    const list = at && (at.parent === undefined ? w.steps : flatSteps(w.steps).find((s) => s.id === at.parent)?.[at.branch]);
    return !at || at.index === (list?.length ?? 0) - 1;
  };
  // the block acts get the focused block's id; the others ignore it
  const ACTS: Record<ActName, (id: string) => void> = {
    delete: (id) => onDelete(id !== '' && !sel.has(stepKey(id)) ? [stepKey(id)] : [...withoutNested(w, sel)]),
    select: (id) => { if (id !== '') one(id); },
    moveUp: (id) => { const at = placeOf(w, id); if (at && at.index > 0) move(id, { ...at, index: at.index - 1 }); },
    moveDown: (id) => { const at = placeOf(w, id); if (at && !last(id)) move(id, { ...at, index: at.index + 2 }); },
    nestIn: (id) => { const to = nestPlace(w, id, 'in'); if (to) move(id, to); },
    nestOut: (id) => { const to = nestPlace(w, id, 'out'); if (to) move(id, to); },
    undo: onUndo,
    redo: onRedo,
    escape: () => one(),
    copy: () => { copy(); },
    cut: () => { if (copy()) onDelete([...withoutNested(w, sel)]); },
    paste,
    duplicate,
    selectAll: () => { const n = allKeys(w, (lay.loose ?? []).map((l) => l.key)); onSel(n, stepIds(n).at(-1)); },
    zoomIn: () => zoom(ZOOM.step),
    zoomOut: () => zoom(1 / ZOOM.step),
    zoomReset: () => zoom(1 / camRef.current.zoom),
    fit,
    menu: (id) => {
      const vr = view.current!.getBoundingClientRect(), lo = id === '' ? document.activeElement?.closest<HTMLElement>('.sx-loose') : null;
      const el = lo ?? (id === '' ? null : view.current!.querySelector<HTMLElement>(`.blk[data-id="${CSS.escape(id)}"]`));
      if (!el) return openMenu('surface', '', { x: vr.width / 2, y: vr.height / 2 }, view.current!);
      const b = el.getBoundingClientRect();
      openMenu(lo ? 'loose' : 'block', lo ? lo.dataset.loose! : id, { x: b.left - vr.left, y: b.top - vr.top }, el);
    },
    // beside the script, at the block's height
    park: (id) => {
      const q = (s: string) => view.current!.querySelector(s)?.getBoundingClientRect(), vr = view.current!.getBoundingClientRect();
      const s = q('.sx-script'), b = q(`.blk[data-id="${CSS.escape(id)}"]`);
      if (!s || !b) return;
      const o = toWorld(camRef.current, { x: s.right - vr.left, y: b.top - vr.top });
      parkIds(sel.has(stepKey(id)) ? top() : [id], id, { x: o.x + 40, y: o.y });
    },
    putEnd: () => { const keys = [...sel].filter((k) => k.startsWith('l:')); if (keys.length) unparkTo(keys, { top: 'end' }); },
    editInText: (id) => onEditInText(flatSteps(w.steps).find((s) => s.id === id)?.pos?.line ?? 1),
  };
  const keydown = (e: KeyEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (isTyping(t.tagName)) return;
    const block = t.matches('.blk[data-id]') || !!t.closest('.sx-loose');
    const act = matchKey({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey }, block ? 'block' : 'any');
    if (!act) return;
    e.preventDefault(); // also swallows Alt+Left / Alt+Right, the browser's Back / Forward, on a block
    ACTS[act](block ? t.dataset.id ?? '' : '');
  };

  const ghosts = useRef<HTMLDivElement>(null);
  const home = lay.script ?? HOME;
  // Legality is asked of the same pure functions that do the edit: a drop is legal iff it would change the model.
  const drag = useDrag({
    view, ghosts, cam: () => camRef.current, setCam: (c, save) => (save ? commit(c) : set(c)),
    legal: (src, t) => {
      if ('hex' in t) return 'cond' in src && setCond(w, t.hex.id, t.hex.path, { t: 'approve' }) !== w;
      if ('move' in src) { const to = 'hit' in t ? dropPlace(w, t.hit) : undefined; return !!to && unpark(w, looseOf(src.move).map((l) => l.step), to).w !== w; }
      if ('surface' in t) return 'kind' in src ? !!KINDS[src.kind].fresh : 'id' in src && park(w, src.ids ?? [src.id]).w !== w;
      if ('id' in src) return 'hit' in t && dropSteps(w, src.ids ?? [src.id], t.hit) !== w;
      const place = 'hit' in t ? dropPlace(w, t.hit) : undefined;
      return !!place && 'kind' in src && addStepAt(w, 'phase', place) !== w;
    },
    drop: (src, t, pt) => {
      const place = 'hit' in t ? dropPlace(w, t.hit) : undefined;
      if ('hex' in t && 'cond' in src) onEdit((m) => setCond(m, t.hex.id, t.hex.path, COND_KINDS[src.cond]!.fresh()));
      else if ('hit' in t && 'id' in src) {
        const ids = src.ids ?? [src.id];
        refocus.current = moved((m) => dropSteps(m, ids, t.hit)) ? ids[0] : undefined;
      } else if ('hit' in t && 'move' in src) unparkTo(src.move, t.hit);
      else if ('surface' in t && 'id' in src) parkIds(src.ids ?? [src.id], src.id, pt);
      else if ('surface' in t && 'kind' in src) {
        stash([{ id: newId(w, src.kind), kind: src.kind, attrs: {}, cards: [], links: [], ...KINDS[src.kind].fresh!() }], [pt]);
      } else if (place && 'kind' in src && onEdit((m) => addStepAt(m, src.kind, place))) one(newId(w, src.kind));
    },
    move: (keys, d) => { onLayout((l) => moveItems(l, keys, d)); },
  });
  press.current = drag.press;
  const hatMoving = !!drag.keys?.includes('hat');
  const scriptAt = { x: home.x + (hatMoving ? drag.d?.x ?? 0 : 0), y: home.y + (hatMoving ? drag.d?.y ?? 0 : 0) };
  const parking = !!drag.src && !!drag.ok && !drag.over; // a step over bare surface: a release parks it
  useEffect(() => {
    if (!parking) return;
    onNote('Release to park: it leaves the workflow.');
    return () => onNote('');
  }, [parking]);

  useEffect(() => {
    const v = view.current!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('input, textarea, select, .sx-menu')) return;
      e.preventDefault();
      const r = v.getBoundingClientRect();
      const f = e.ctrlKey ? Math.exp(-e.deltaY / 100) : e.deltaY < 0 ? ZOOM.wheel : 1 / ZOOM.wheel;
      set(zoomAt(camRef.current, { x: e.clientX - r.left, y: e.clientY - r.top }, f));
      clearTimeout(timer);
      timer = setTimeout(() => onCam(camRef.current), 250);
    };
    const key = (e: KeyboardEvent) => { if (e.key === ' ') space.current = e.type === 'keydown' && !isTyping((e.target as Element).tagName); };
    v.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => { v.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); clearTimeout(timer); };
  }, []);

  // Shift+drag on bare surface: a rectangle; on release every block fully inside it is selected (Ctrl adds).
  const startBox = (e: PointerEvent<HTMLDivElement>) => {
    const vr = view.current!.getBoundingClientRect(), add = e.ctrlKey || e.metaKey;
    const at = (m: { clientX: number; clientY: number }) => toWorld(camRef.current, { x: m.clientX - vr.left, y: m.clientY - vr.top });
    const a = at(e), x0 = e.clientX, y0 = e.clientY;
    const rect = (m: { clientX: number; clientY: number }): Rect => { const b = at(m); return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; };
    let moved = false;
    const move = (m: globalThis.PointerEvent) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) >= DRAG_PX) moved = true;
      if (moved) setBox(rect(m));
    };
    const up = (m: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setBox(undefined);
      if (!moved) return add ? undefined : one();
      const c = camRef.current;
      const rects = [...view.current!.querySelectorAll<HTMLElement>('.blk[data-id], .sx-loose[data-loose]')].map((el) => {
        const r = el.getBoundingClientRect(), o = toWorld(c, { x: r.left - vr.left, y: r.top - vr.top });
        return { key: el.dataset.id === undefined ? `l:${el.dataset.loose}` : stepKey(el.dataset.id), r: { ...o, w: r.width / c.zoom, h: r.height / c.zoom } };
      });
      const n = withoutNested(w, new Set([...boxSelect(rects, rect(m)), ...(add ? sel : [])]));
      onSel(n, stepIds(n).at(-1));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    const p: Press = { button: e.button, shift: e.shiftKey, space: space.current && !isTyping(document.activeElement?.tagName ?? ''), on: onOf(e.target as Element) };
    const g = pickGesture(p);
    if (g === 'pending') {
      const hat = (e.target as Element).closest<HTMLElement>('.sx-hat'), blk = (e.target as Element).closest<HTMLElement>('.blk');
      const lo = (e.target as Element).closest<HTMLElement>('.sx-loose');
      if (hat) drag.press(e.nativeEvent, { move: ['hat'] }, hat);
      else if (lo) {
        const k = `l:${lo.dataset.loose}`;
        drag.press(e.nativeEvent, { move: sel.has(k) ? [...sel].filter((x) => x.startsWith('l:')) : [k] }, lo);
      }
      else if (blk) {
        // a block in the selection drags the whole selection, one ghost each; any other block drags alone
        const id = blk.dataset.id!, ids = sel.has(stepKey(id)) ? top() : [id];
        const group = ids.flatMap((i) => view.current!.querySelector(`.blk[data-id="${CSS.escape(i)}"]`) ?? []);
        drag.press(e.nativeEvent, { id, ids }, blk, group.length > 1 ? group : undefined);
      }
      return;
    }
    if (g === 'box') return startBox(e);
    if (g !== 'pan') return;
    if (e.button === 1) e.preventDefault();
    const from = { x: e.clientX, y: e.clientY }, start = camRef.current;
    let moved = false;
    setPanning(true);
    const move = (m: globalThis.PointerEvent) => {
      const dx = m.clientX - from.x, dy = m.clientY - from.y;
      if (Math.hypot(dx, dy) >= DRAG_PX) moved = true;
      if (moved) set({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setPanning(false);
      if (moved) onCam(camRef.current);
      else if (p.on === 'empty' && p.button === 0 && !p.space) one();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <div ref={view} className={cx('sx-view', panning && 'sx-panning', drag.kind && 'sx-dragging', parking && 'sx-parking', drag.kind && drag.kind !== 'move' && !drag.ok && 'sx-nodrop')} role="region" aria-label="Workspace" tabIndex={0}
      style={{ backgroundPosition: `${cam.x}px ${cam.y}px`, backgroundSize: `${18 * cam.zoom}px ${18 * cam.zoom}px` }}
      onKeyDown={keydown} onContextMenu={contextmenu} onPointerDown={down} onPointerMove={(e) => { ptr.current = { x: e.clientX, y: e.clientY }; }} onPointerLeave={() => { ptr.current = undefined; }} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}>
      <div className="sx-world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}>
        <BlocksPane w={w} steps={steps} diags={diags} text={text} sel={sel} rev={rev} condDrag={drag.kind === 'cond'} src={drag.src} over={drag.over}
          at={scriptAt} missing={gone} onEdit={onEdit} onSelect={pick} />
        <LinkLayer arrows={arrows} rects={rects} lanes={lane} at={scriptAt} />
        {(lay.loose ?? []).map((l) => {
          const k = `l:${l.key}`, d = drag.keys?.includes(k) ? drag.d : undefined;
          return <BlocksPane key={l.key} w={{ ...w, steps: [l.step] }} steps={[]} diags={[]} text="" sel={sel} rev={rev} at={{ x: l.at.x + (d?.x ?? 0), y: l.at.y + (d?.y ?? 0) }}
            loose={{ key: l.key, selected: sel.has(k), moving: !!drag.keys?.includes(k), onPick: (add) => pickLoose(l.key, add) }} onEdit={() => false} onSelect={() => {}} />;
        })}
        <div className="sx-ghosts" ref={ghosts} />
        {box && <div className="sx-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      </div>
      <div className="sx-zoom" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" onClick={() => zoom(1 / ZOOM.step)}>−</button>
        <output aria-live="polite">{Math.round(cam.zoom * 100)}%</output>
        <button aria-label="Zoom in" onClick={() => zoom(ZOOM.step)}>+</button>
        <button aria-label="Fit view" onClick={fit}>Fit</button>
        <button aria-label="Reset zoom" onClick={() => zoom(1 / camRef.current.zoom)}>1:1</button>
      </div>
      {menu && <ContextMenu items={itemsFor(menu.t, menuCtx(menu))} at={menu.at} onRun={(act) => ACTS[act](menu.t === 'block' ? menu.id : '')}
        onClose={(refocus) => { setMenu(undefined); if (refocus) (menu.opener.isConnected ? menu.opener : view.current)?.focus(); }} />}
    </div>
  );
}
