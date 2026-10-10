import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as KeyEvent, type MouseEvent as MouseEv, type MutableRefObject, type PointerEvent } from 'react';
import type { Diagnostic, Step, Workflow } from '@reins/core';
import { BlocksPane } from './BlocksPane.js';
import { ContextMenu } from './ContextMenu.js';
import { itemsFor, type MenuCtx, type MenuTarget } from './menus.js';
import { addLoose, attach, detach, ensureEnd, freedBy, FULL, HOME, moveItems, park, removeLoose, selfContained, splitAtEnd, unpark } from './arrange.js';
import { addStepAt, capBackward, dropPlace, dropSteps, duplicateSteps, moveStep, nestPlace, newId, placeOf, setCond, stackEnd, takeSteps, type Hit, type Place } from './blocks.js';
import { KINDS } from './canvasKinds.js';
import { flatSteps, marksOf, removeLinks, setLink, type WireKind } from './canvas.js';
import { lanes, linksToDraw, taken } from './arrows.js';
import { LinkLayer } from './LinkLayer.js';
import { COND_KINDS } from './condKinds.js';
import { LOOSE_MAX, type Layout } from './editorState.js';
import { cx } from './generic.js';
import { DRAG_PX, pickGesture, type Press } from './gesture.js';
import { isTyping, matchKey, type ActName, type On } from './keys.js';
import { allKeys, boxSelect, neighbour, nestedKeys, readingOrder, stepIds, stepKey, toggle, withoutNested, type Key } from './selection.js';
import { boundsOf, fitBounds, reveal as revealCam, toWorld, ZOOM, zoomAt, type Cam, type Pt, type Rect } from './surface.js';
import { useDrag, type Start } from './useDrag.js';

// ponytail: in-app clipboard, lost on reload; the system clipboard if it matters
let clip: Step[] = [];
// A selected arrow is the key 'k:<from>/<index>'.
const parseLink = (k: string) => { const i = k.lastIndexOf('/'); return { from: k.slice(2, i), index: Number(k.slice(i + 1)) }; };
export type EditOpts = { lay?: (l: Layout) => Layout; then?: (applied: boolean) => void };
const ARROW: Record<string, Pt> = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } };
const NUDGE = 20, PAN = 40;
const gridPx = (z: number) => { let s = 18 * z; while (s < 12) s *= 2; return s; }; // dots never closer than 12 px
const NATIVE = 'input, textarea, select, option, button, .sx-menu, .sx-zoom';
const onOf = (t: Element): Press['on'] => (t.closest(NATIVE) ? 'input' : t.closest('.sx-handle') ? 'handle' : t.closest('[data-link]') ? 'link' : t.closest('.sx-hat') ? 'hat' : t.closest('.sx-loose') ? 'loose' : t.closest('.blk') ? 'block' : 'empty');

// ponytail: Follow pans without animation, only when the block leaves the view; any press in the view stops it.
export function Workspace({ w, steps, diags, text, sel, primary, rev, cam: saved, lay, press, reveal, ran, onShowInChat, follow, followTick, went, onUserCam, onEdit, onSel, onDelete, onCam, onLayout, onUndo, onRedo, onNote, onEditInText }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; sel: Set<Key>; primary?: string; rev: unknown;
  cam?: Cam; lay: Layout; press: MutableRefObject<Start | undefined>;
  reveal?: { id: string; n: number }; ran?: (id: string) => boolean; onShowInChat?: (id: string) => void; // reveal: bring this block into view and focus it (Chat's "Blocks ↗")
  follow?: string; followTick?: number; went?: Array<{ from: string; to: string }>; onUserCam?: () => void; // follow: keep this block (the running one) in view; went: the steps the run started, in order; onUserCam: the user moved the camera
  onEdit: (fn: (w: Workflow) => Workflow, o?: EditOpts) => boolean; onSel: (keys: Set<Key>, primary?: string) => void; onDelete: (keys: Key[], then?: (applied: boolean) => void) => void; onCam: (c: Cam) => void;
  onLayout: (fn: (l: Layout) => Layout) => boolean; onUndo: () => boolean; onRedo: () => boolean; onNote: (s: string) => void; onEditInText: (line: number) => void;
}) {
  const view = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Cam>(saved ?? { x: 0, y: 0, zoom: 1 });
  const camRef = useRef(cam);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState<Rect>();
  const [band, setBand] = useState<{ a: Pt; b: Pt; to?: string }>(); // the link being drawn
  const [menu, setMenu] = useState<{ t: MenuTarget; id: string; at: Pt; opener: HTMLElement }>();
  const space = useRef(false);
  // What a gesture reads when it ends: the latest props, not the ones from the render that began it.
  const live = useRef<{ onEdit: typeof onEdit; onSel: typeof onSel; onCam: typeof onCam; onUserCam?: () => void; link: (from: string, kind: WireKind, key: string) => void; w: Workflow; sel: Set<Key> }>(undefined as never);
  const gesture = useRef<() => void>(undefined); // the running pan, box or link gesture's teardown
  useEffect(() => () => gesture.current?.(), []);
  const set =(c: Cam) => { camRef.current = c; setCam(c); };
  const commit = (c: Cam) => { set(c); onCam(c); };

  const size = () => view.current!.getBoundingClientRect();
  const zoom = (f: number) => { const r = size(); commit(zoomAt(camRef.current, { x: r.width / 2, y: r.height / 2 }, f)); };
  // Fit covers the script, the free blocks and the loose blocks.
  const fit = () => {
    if (!view.current) return;
    const r = size(), c = camRef.current;
    const all = [...view.current.querySelectorAll('.sx-script, .sx-free, .sx-loose')].map((el): Rect => {
      const b = el.getBoundingClientRect(), o = toWorld(c, { x: b.left - r.left, y: b.top - r.top });
      return { ...o, w: b.width / c.zoom, h: b.height / c.zoom };
    });
    const b = boundsOf(all);
    if (b) { const f = fitBounds(b, { w: r.width, h: r.height - 44 }, 24); commit({ ...f, y: f.y + 44 }); } // the top strip is the zoom toolbar: no block ends under it
  };
  useLayoutEffect(() => { if (!saved) fit(); }, []);

  // Arrows: each block's first row, measured once per model change or size change in the script's own coordinates, so a hat drag or a zoom needs no measuring.
  // A block with a place of its own (a free block) is measured from its own origin, named by c.
  const [rects, setRects] = useState(new Map<string, Rect & { c?: string }>());
  const measure = () => {
    const s = view.current?.querySelector<HTMLElement>('.sx-script');
    if (!s) return;
    const z = camRef.current.zoom, q = (v: number) => Math.round((v / z) * 100) / 100;
    const next = new Map<string, Rect & { c?: string }>();
    for (const el of view.current!.querySelectorAll<HTMLElement>('.blk[data-id]')) {
      const c = el.closest<HTMLElement>('.sx-placed'), o = (c ?? s).getBoundingClientRect();
      const b = el.getBoundingClientRect(), row = el.querySelector('.sx-row')?.getBoundingClientRect() ?? b;
      next.set(el.dataset.id!, { x: q(b.left - o.left), y: q(row.top - o.top), w: q(b.width), h: q(row.height), ...(c && { c: c.dataset.zid }) });
    }
    setRects((p) => (JSON.stringify([...p]) === JSON.stringify([...next]) ? p : next));
  };
  const wires = useMemo(() => marksOf(w, diags, text).wires, [w, diags, text]);
  const { arrows, missing, then } = useMemo(() => linksToDraw(w, wires), [w, wires]);
  const tail = useMemo(() => splitAtEnd(w).tail, [w]);
  const freeIds = useMemo(() => new Set(tail.map((s) => s.id)), [tail]);
  // A free block sits outside the script's box, so it is observed itself: a pill typed into it moves its arrows.
  const tailKey = tail.map((s) => s.id).join('\n');
  useEffect(() => {
    const els = view.current!.querySelectorAll('.sx-script, .sx-free');
    if (!els.length) return;
    const ro = new ResizeObserver(measure);
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [tailKey]);
  const base = useRef(new Map<string, Pt>()); // the world places of the free blocks when a press began
  // Where each free block stands now, read from the page: an unplaced one has no saved place until something moves it.
  const freePlaces = () => {
    const vr = view.current!.getBoundingClientRect();
    return new Map(tail.flatMap((s) => {
      const b = view.current!.querySelector(`.sx-free[data-zid="${CSS.escape(s.id)}"]`)?.getBoundingClientRect();
      return b ? [[s.id, toWorld(camRef.current, { x: b.left - vr.left, y: b.top - vr.top })] as const] : [];
    }));
  };
  const lane = useMemo(() => lanes(arrows, flatSteps(w.steps).map((s) => s.id)), [arrows, w]);
  const gone = useMemo(() => new Set(missing.map((m) => `${m.from}/${m.index}`)), [missing]);

  // The model changes asynchronously (edit -> server print -> new w); focus goes where an operation said (from its `then`, so a failed
  // request leaves nothing behind) once the new blocks are on the page. 'primary' is the selected step, 'view' the viewport itself.
  const refocus = useRef<Key | undefined>(undefined);
  const elOf = (k: Key) => view.current!.querySelector<HTMLElement>(k.startsWith('s:') ? `.blk[data-id="${CSS.escape(k.slice(2))}"]` : `.sx-loose[data-loose="${CSS.escape(k.slice(2))}"]`);
  useEffect(() => {
    const k = refocus.current === 'primary' ? (primary === undefined ? 'view' : stepKey(primary)) : refocus.current;
    refocus.current = undefined;
    if (k !== undefined) (k === 'view' ? view.current : elOf(k) ?? view.current)?.focus({ preventScroll: true });
  }, [w, lay]);
  // Chat's "Blocks ↗": the block comes into view (clear of the toolbar strip) and takes the focus directly; the refocus above runs only on [w, lay].
  const bring = (id: string) => {
    const el = elOf(stepKey(id));
    if (!el) return undefined;
    // The state chip hangs outside the block's box: bring it into view with the block, but only when both fit (the block itself always wins).
    const vr = size(), c = camRef.current, own = el.getBoundingClientRect(), all = [el, ...el.querySelectorAll('.sstate')].map((e) => e.getBoundingClientRect());
    const l = Math.min(...all.map((r) => r.left)), t = Math.min(...all.map((r) => r.top)), r = Math.max(...all.map((r) => r.right)), bt = Math.max(...all.map((r) => r.bottom));
    const b = r - l <= vr.width - 88 && bt - t <= vr.height - 88 ? new DOMRect(l, t, r - l, bt - t) : own, o = toWorld(c, { x: b.left - vr.left, y: b.top - vr.top });
    const next = revealCam(c, { ...o, w: b.width / c.zoom, h: b.height / c.zoom }, { w: vr.width, h: vr.height });
    if (next) commit(next);
    return el;
  };
  useEffect(() => { if (reveal) bring(reveal.id)?.focus({ preventScroll: true }); }, [reveal?.n]);
  // The running block comes into view when it changes (or Follow comes back on, or its chip grows with the thinking count). Not a user move: onUserCam is not called.
  useEffect(() => { if (follow !== undefined) bring(follow); }, [follow, followTick]);
  const focusAfter = (k?: Key) => (ok: boolean) => { if (ok && k !== undefined) refocus.current = k; };
  // Every move is one edit; a link the move turned backward gets its max, and the note says which.
  const capNote = (capped: string[]) => `Added max 3 to ${capped.length === 1 ? '1 link that now points' : `${capped.length} links that now point`} back: ${capped.join(', ')}.`;
  // Moving, parking or deleting the top-level end makes the free blocks behind it run; say so.
  const freeNote = (ids: string[]) => { const f = freedBy(w, ids); return f.length ? ` Without the end, the free block${f.length > 1 ? 's' : ''} ${f.map((i) => `\`${i}\``).join(', ')} now run${f.length > 1 ? '' : 's'}.` : ''; };
  const moved = (fn: (m: Workflow) => Workflow, ids: string[]) => {
    let capped: string[] = [];
    const free = freeNote(ids);
    const sent = onEdit((m) => { const d = fn(m); if (d === m) return m; const r = capBackward(d); capped = r.capped; return r.w; }, {
      then: (ok) => {
        focusAfter(ids[0] === undefined ? undefined : stepKey(ids[0]))(ok);
        const said = `${capped.length ? capNote(capped) : ''}${ok ? free : ''}`.trim();
        if (ok && said) onNote(said);
      },
    });
    return sent;
  };
  // detach / put back: one edit; the note says what happened and which links got a max
  const flow = (ids: string[], one: (m: Workflow, id: string) => { w: Workflow; capped: string[] } | undefined, said: string, lay?: (l: Layout) => Layout) => {
    let capped: string[] = [];
    onEdit((m) => { capped = []; return ids.reduce((acc, id) => { const r = one(acc, id); capped.push(...(r?.capped ?? [])); return r?.w ?? acc; }, m); }, {
      ...(lay && { lay }),
      then: (ok) => { if (!ok) return; refocus.current = stepKey(ids[0]!); onNote(capped.length ? `${said} ${capNote(capped)}` : said); },
    });
  };
  const move = (id: string, to: Place) => { moved((m) => moveStep(m, id, to), [id]); };
  // delete: focus goes to the next block in reading order, else the previous one, else the viewport
  const remove = (keys: Key[]) => {
    const next = neighbour(readingOrder(w, lay.loose), new Set([...keys, ...nestedKeys(w, new Set(keys))]));
    const free = freeNote(stepIds(new Set(keys)));
    onDelete(keys, (ok) => { focusAfter(next ?? 'view')(ok); if (ok && free) onNote(free.trim()); });
  };

  const one = (id?: string) => onSel(new Set(id === undefined ? [] : [stepKey(id)]), id);
  const pick = (id: string, add: boolean) => {
    if (!add) return one(id);
    const k = stepKey(id), n = toggle(sel, k);
    onSel(n, n.has(k) ? id : stepIds(n).at(-1));
  };
  const top = (s: Set<Key> = sel) => stepIds(withoutNested(w, s));
  const looseSel = (s: Set<Key> = sel) => (lay.loose ?? []).filter((l) => s.has(`l:${l.key}`));
  // a key press acts on the focused block when that block is not part of the selection, else on the selection
  const aim = (ev?: { cur: Key }): Set<Key> => (ev?.cur && !sel.has(ev.cur) ? new Set([ev.cur]) : sel);
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
    if (ok) { onSel(new Set(keys.map((k) => `l:${k}`))); refocus.current = `l:${keys[0]}`; }
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
    const free = freeNote(r.steps.map((s) => s.id));
    onEdit(() => r.w, {
      lay: (l) => { const a = addLoose(l, r.steps, pts); keys = a.keys; return a.lay; },
      then: (ok) => {
        if (!ok) return;
        onSel(new Set(keys.map((k) => `l:${k}`)));
        refocus.current = `l:${keys[0]}`;
        const n = r.lost.length;
        onNote(`Parked ${r.steps.map((s) => `\`${s.id}\``).join(', ')}.${n ? ` Removed ${n} link${n > 1 ? 's' : ''}: ${r.lost.join(', ')}.` : ''}${free} Ctrl+Z puts it back.`);
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
        if (r.ids[0] !== undefined) refocus.current = stepKey(r.ids[0]);
        onSel(new Set(r.ids.map(stepKey)), r.ids.at(-1));
        if (r.capped.length) onNote(capNote(r.capped));
      },
    });
  };
  // A link drawn onto a loose block: it becomes a free block (behind the end) where it lay, and the link points to it.
  const linkLoose = (from: string, kind: WireKind, key: string) => {
    const l = (lay.loose ?? []).find((x) => x.key === key);
    if (!l) return;
    let r: ReturnType<typeof unpark> | undefined;
    onEdit((m) => {
      const e = ensureEnd(m);
      r = unpark(e, [l.step], { branch: 'kids', index: e.steps.length });
      return r.ids[0] === undefined ? m : setLink(r.w, from, kind, r.ids[0]);
    }, {
      lay: (x) => (r?.ids[0] === undefined ? x : { ...removeLoose(x, [key]), free: { ...x.free, [r.ids[0]]: l.at } }),
      then: (ok) => { if (ok && r?.ids[0] !== undefined) onNote(`\`${r.ids[0]}\` is now a free block: it runs only when a link points to it.`); },
    });
  };
  live.current = { onEdit, onSel, onCam, onUserCam, link: linkLoose, w, sel };
  const user = () => live.current.onUserCam?.(); // only where the user moves the camera; never in fit / zoom / commit (fit runs on mount)
  const wentKeys = useMemo(() => taken(arrows, then, went ?? []), [arrows, then, went]);
  const copy = (at: Set<Key> = sel) => {
    const s = selfContained([...takeSteps(w, top(at)).taken, ...looseSel(at).map((l) => l.step)]);
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
  const duplicate = (at: Set<Key> = sel) => {
    const ids = top(at), lo = looseSel(at);
    let made: string[] = [], keys: string[] = [];
    const parkLoose = (l: Layout) => { const r = addLoose(l, lo.map((x) => x.step), lo.map((x) => ({ x: x.at.x + 24, y: x.at.y + 24 }))); keys = r.keys; return r.lay; };
    if (!ids.length) return void (lo.length && onLayout(parkLoose) && (onSel(new Set(keys.map((k) => `l:${k}`))), (refocus.current = `l:${keys[0]}`)));
    onEdit((m) => { const r = duplicateSteps(m, ids); made = r.ids; return r.w; }, {
      ...(lo.length && { lay: parkLoose }),
      then: (ok) => { if (!ok) return; onSel(new Set([...made.map(stepKey), ...keys.map((k) => `l:${k}`)]), made.at(-1)); refocus.current = made[0] !== undefined ? stepKey(made[0]) : `l:${keys[0]}`; },
    });
  };

  // The menu is about one thing: select it first unless it is already selected. `at` is in view coordinates; a loose block's id is its key.
  const openMenu = (t: MenuTarget, id: string, at: Pt, opener: HTMLElement) => {
    if (t === 'block' && !sel.has(stepKey(id))) one(id);
    if (t === 'loose' && !sel.has(`l:${id}`)) pickLoose(id, false);
    if (t === 'link') onSel(new Set([id]));
    setMenu({ t, id, at, opener });
  };
  const menuCtx = (m: { id: string }): MenuCtx => {
    const s = flatSteps(w.steps).find((x) => x.id === m.id);
    return { count: sel.size, topLevel: !!s && placeOf(w, s.id)?.parent === undefined, free: freeIds.has(m.id), isEnd: !!s && !!KINDS[s.kind].stops, clip: clip.length > 0, ran: !!ran?.(m.id) };
  };
  // One place decides what a point or an element is: the context menu and the Shift+F10 key both come here.
  const openOn = (t: Element | null, at: Pt) => {
    const ln = t?.closest<HTMLElement>('[data-link]'), lo = t?.closest<HTMLElement>('.sx-loose'), blk = t?.closest<HTMLElement>('.blk[data-id]');
    if (ln) openMenu('link', `k:${ln.dataset.link}`, at, ln);
    else if (lo) openMenu('loose', lo.dataset.loose!, at, lo);
    else if (blk) openMenu('block', blk.dataset.id!, at, blk);
    else openMenu('surface', '', at, view.current!);
  };
  const contextmenu = (e: MouseEv<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest('.sx-menu')) return e.preventDefault(); // the ContextMenu key's event can land on the menu's new focus
    if (t.closest('input, textarea, select, .sx-zoom')) return; // the browser's own menu
    e.preventDefault();
    const r = view.current!.getBoundingClientRect(), at = { x: e.clientX - r.left, y: e.clientY - r.top };
    openOn(t, at);
  };
  // a stack block never moves past the end, and a free block never above it: that would change what is free
  const last = (id: string) => {
    const at = placeOf(w, id);
    const list = at && (at.parent === undefined ? w.steps : flatSteps(w.steps).find((s) => s.id === at.parent)?.[at.branch]);
    return !at || at.index === (list?.length ?? 0) - 1 || (at.parent === undefined && at.index === stackEnd(w) - 1);
  };
  // the block acts get the focused block's id; the others ignore it
  // `ev` is the key press: the block that has the focus and the key itself (the arrows share an act)
  const walk = (cur: Key, by: number) => {
    const order = readingOrder(w, lay.loose), i = order.indexOf(cur), k = order[Math.min(Math.max(i + by, 0), order.length - 1)];
    return k === undefined || i < 0 ? undefined : k;
  };
  const ACTS: Record<ActName, (id: string, ev?: { key: string; cur: Key }) => void> = {
    delete: (id, ev) => { const k = id !== '' ? stepKey(id) : ev?.cur.startsWith('l:') ? ev.cur : undefined; if (!k && !sel.size) return; remove(k && !sel.has(k) ? [k] : [...withoutNested(w, sel)]); },
    focusPrev: (_, ev) => { const k = ev && walk(ev.cur, -1); if (k) elOf(k)?.focus({ preventScroll: true }); },
    focusNext: (_, ev) => { const k = ev && walk(ev.cur, 1); if (k) elOf(k)?.focus({ preventScroll: true }); },
    extendPrev: (_, ev) => { const k = ev && walk(ev.cur, -1); if (k) { onSel(new Set([...sel, ev.cur, k]), stepIds([k]).at(0) ?? primary); elOf(k)?.focus({ preventScroll: true }); } },
    extendNext: (_, ev) => { const k = ev && walk(ev.cur, 1); if (k) { onSel(new Set([...sel, ev.cur, k]), stepIds([k]).at(0) ?? primary); elOf(k)?.focus({ preventScroll: true }); } },
    nudge: (_, ev) => {
      const d = ev && ARROW[ev.key];
      if (!d) return;
      const keys = sel.has(ev.cur) ? [...sel] : [ev.cur];
      onLayout((l) => moveItems(keys.some((k) => k.startsWith('s:')) ? { ...l, free: { ...Object.fromEntries(freePlaces()), ...l.free } } : l, keys, { x: d.x * NUDGE, y: d.y * NUDGE }));
    },
    pan: (_, ev) => {
      const d = ev && ARROW[ev.key], c = camRef.current;
      if (d) { user(); commit({ ...c, x: c.x - d.x * PAN, y: c.y - d.y * PAN }); }
    },
    select: (id, ev) => { if (id !== '') one(id); else if (ev?.cur.startsWith('l:')) pickLoose(ev.cur.slice(2), false); },
    moveUp: (id) => { const at = placeOf(w, id); if (at && at.index > (freeIds.has(id) ? stackEnd(w) + 1 : 0)) move(id, { ...at, index: at.index - 1 }); },
    moveDown: (id) => { const at = placeOf(w, id); if (at && !last(id)) move(id, { ...at, index: at.index + 2 }); },
    nestIn: (id) => { const to = nestPlace(w, id, 'in'); if (to) move(id, to); },
    nestOut: (id) => { const to = nestPlace(w, id, 'out'); if (to) move(id, to); },
    undo: () => { if (onUndo()) refocus.current = 'primary'; },
    redo: () => { if (onRedo()) refocus.current = 'primary'; },
    escape: () => one(),
    copy: (_, ev) => { copy(aim(ev)); },
    cut: (_, ev) => { const at = aim(ev); if (copy(at)) remove([...withoutNested(w, at)]); },
    paste,
    duplicate: (_, ev) => duplicate(aim(ev)),
    selectAll: () => { const n = allKeys(w, (lay.loose ?? []).map((l) => l.key)); onSel(n, stepIds(n).at(-1)); },
    zoomIn: () => { user(); zoom(ZOOM.step); },
    zoomOut: () => { user(); zoom(1 / ZOOM.step); },
    zoomReset: () => { user(); zoom(1 / camRef.current.zoom); },
    fit: () => { user(); fit(); },
    deleteLink: (id) => {
      const keys = id.startsWith('k:') ? [id] : [...sel].filter((k) => k.startsWith('k:'));
      if (keys.length) onEdit((m) => removeLinks(m, keys.map(parseLink)), { then: (ok) => { if (ok) { one(); view.current?.focus({ preventScroll: true }); } } });
    },
    menu: (id) => {
      const vr = view.current!.getBoundingClientRect(), q = (s: string) => view.current!.querySelector<HTMLElement>(s);
      const el = id.startsWith('k:') ? q(`[data-link="${CSS.escape(id.slice(2))}"]`) : id === '' ? document.activeElement?.closest<HTMLElement>('.sx-loose') ?? null : q(`.blk[data-id="${CSS.escape(id)}"]`);
      const b = el?.getBoundingClientRect();
      openOn(el ?? null, b ? { x: b.left - vr.left, y: b.top - vr.top } : { x: vr.width / 2, y: vr.height / 2 });
    },
    // beside the script, at the block's height
    park: (id) => {
      const q = (s: string) => view.current!.querySelector(s)?.getBoundingClientRect(), vr = view.current!.getBoundingClientRect();
      const s = q('.sx-script'), b = q(`.blk[data-id="${CSS.escape(id)}"]`);
      if (!s || !b) return;
      const o = toWorld(camRef.current, { x: s.right - vr.left, y: b.top - vr.top });
      parkIds(sel.has(stepKey(id)) ? top() : [id], id, { x: o.x + 40, y: o.y });
    },
    // the detached block gets a place of its own, beside the script at the height it stood (the stack closes up, so the same spot would cover the next block); the other free blocks keep theirs
    detach: (id) => {
      const q = (s: string) => view.current!.querySelector(s)?.getBoundingClientRect(), vr = view.current!.getBoundingClientRect();
      const s = q('.sx-script'), b = q(`.blk[data-id="${CSS.escape(id)}"]`);
      const at = s && b && toWorld(camRef.current, { x: s.right - vr.left + 40, y: b.top - vr.top }), others = Object.fromEntries(freePlaces());
      flow([id], detach, `\`${id}\` is now a free block: it runs only when a link points to it.`, at && ((l) => ({ ...l, free: { ...others, ...l.free, [id]: at } })));
    },
    attach: (id) => flow([id], attach, `\`${id}\` is back in the stack.`),
    putEnd: () => { const keys = [...sel].filter((k) => k.startsWith('l:')); if (keys.length) unparkTo(keys, { top: 'end' }); },
    showInChat: (id) => onShowInChat?.(id),
    editInText: (id) => {
      const l = id.startsWith('k:') ? parseLink(id) : undefined, s = flatSteps(w.steps).find((x) => x.id === (l?.from ?? id));
      onEditInText((l && s?.links[l.index]?.pos?.line) || s?.pos?.line || 1);
    },
  };
  const keydown = (e: KeyEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (isTyping(t.tagName)) return;
    const lo = t.closest<HTMLElement>('.sx-loose'), blk = t.matches('.blk[data-id]'), link = t.closest<HTMLElement>('[data-link]');
    const cur = lo ? `l:${lo.dataset.loose}` : blk ? stepKey(t.dataset.id!) : '';
    const on: On = lo || (blk && freeIds.has(t.dataset.id!)) ? 'positioned' : blk ? 'block' : link ? 'link' : t === view.current ? 'view' : 'any';
    const act = matchKey({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey }, on);
    if (!act) return;
    e.preventDefault(); // also swallows Alt+Left / Alt+Right, the browser's Back / Forward, on a block
    ACTS[act](blk ? t.dataset.id! : link && !lo ? `k:${link.dataset.link}` : '', { key: e.key, cur });
  };

  const ghosts = useRef<HTMLDivElement>(null);
  const home = lay.script ?? HOME;
  // Legality is asked of the same pure functions that do the edit: a drop is legal iff it would change the model.
  const drag = useDrag({
    view, ghosts, cam: () => camRef.current, setCam: (c, save) => (save ? commit(c) : set(c)),
    legal: (src, t) => {
      if ('hex' in t) return 'cond' in src && setCond(w, t.hex.id, t.hex.path, { t: 'approve' }) !== w;
      if ('move' in src) {
        const free = src.move.filter((k) => k.startsWith('s:')).map((k) => k.slice(2)), to = 'hit' in t ? dropPlace(w, t.hit) : undefined;
        if (free.length) return 'hit' in t && free.every((id) => attach(w, id, t.hit));
        return !!to && unpark(w, looseOf(src.move).map((l) => l.step), to).w !== w;
      }
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
        moved((m) => dropSteps(m, ids, t.hit), ids);
      } else if ('hit' in t && 'move' in src) {
        if (src.move[0]!.startsWith('s:')) flow(src.move.map((k) => k.slice(2)), (m, id) => attach(m, id, t.hit), 'Put back in the stack.');
        else unparkTo(src.move, t.hit);
      }
      else if ('surface' in t && 'id' in src) parkIds(src.ids ?? [src.id], src.id, pt);
      else if ('surface' in t && 'kind' in src) {
        stash([{ id: newId(w, src.kind), kind: src.kind, attrs: {}, cards: [], links: [], ...KINDS[src.kind].fresh!() }], [pt]);
      } else if (place && 'kind' in src && onEdit((m) => addStepAt(m, src.kind, place))) one(newId(w, src.kind));
    },
    move: (keys, d) => { onLayout((l) => moveItems(keys.some((k) => k.startsWith('s:')) ? { ...l, free: { ...Object.fromEntries(base.current), ...l.free } } : l, keys, d)); },
  });
  const movingFree = new Set((drag.keys ?? []).filter((k) => k.startsWith('s:')).map((k) => k.slice(2)));
  // a free block is placed from its saved place; while one is dragged, all of them stand where they were so nothing jumps
  const freeAt = new Map<string, Pt>();
  for (const s of tail) {
    const p = lay.free?.[s.id] ?? (movingFree.size ? base.current.get(s.id) : undefined);
    if (p) freeAt.set(s.id, movingFree.has(s.id) ? { x: p.x + (drag.d?.x ?? 0), y: p.y + (drag.d?.y ?? 0) } : p);
  }
  useLayoutEffect(measure, [w, diags, text, lay.free, drag.keys]);
  press.current = drag.press;
  const hatMoving = !!drag.keys?.includes('hat');
  const scriptAt = { x: home.x + (hatMoving ? drag.d?.x ?? 0 : 0), y: home.y + (hatMoving ? drag.d?.y ?? 0 : 0) };
  const world = new Map([...rects].map(([id, r]): [string, Rect] => { const o = (r.c ? freeAt.get(r.c) : scriptAt) ?? scriptAt; return [id, { x: r.x + o.x, y: r.y + o.y, w: r.w, h: r.h }]; }));
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
      live.current.onUserCam?.();
      const r = v.getBoundingClientRect();
      const f = e.ctrlKey ? Math.exp(-e.deltaY / 100) : e.deltaY < 0 ? ZOOM.wheel : 1 / ZOOM.wheel;
      set(zoomAt(camRef.current, { x: e.clientX - r.left, y: e.clientY - r.top }, f));
      clearTimeout(timer);
      timer = setTimeout(() => onCam(camRef.current), 250);
    };
    const key = (e: KeyboardEvent) => { if (e.key === ' ') space.current = e.type === 'keydown' && !isTyping((e.target as Element).tagName); };
    const blur = () => { space.current = false; }; // a keyup that lands in another window must not leave Space held
    v.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', blur);
    return () => { v.removeEventListener('wheel', wheel); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', blur); clearTimeout(timer); };
  }, []);

  // One window-level gesture at a time. `stop` drops its listeners and is also what a second press or an unmount calls; a release runs `done` after it.
  const track = (move: (m: globalThis.PointerEvent) => void, done: (m: globalThis.PointerEvent) => void, onStop: () => void, esc: boolean) => {
    gesture.current?.();
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('keydown', key, true);
      gesture.current = undefined;
      onStop();
    };
    const up = (m: globalThis.PointerEvent) => { stop(); done(m); };
    // capture + stop: the Escape that cancels a gesture must not also clear the selection
    const key = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); stop(); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
    if (esc) window.addEventListener('keydown', key, true);
    gesture.current = stop;
  };

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
      const { w, sel, onSel } = live.current;
      if (!moved) return add ? undefined : onSel(new Set());
      const c = camRef.current;
      const rects = [...view.current!.querySelectorAll<HTMLElement>('.blk[data-id], .sx-loose[data-loose]')].map((el) => {
        const r = el.getBoundingClientRect(), o = toWorld(c, { x: r.left - vr.left, y: r.top - vr.top });
        return { key: el.dataset.id === undefined ? `l:${el.dataset.loose}` : stepKey(el.dataset.id), r: { ...o, w: r.width / c.zoom, h: r.height / c.zoom } };
      });
      const n = withoutNested(w, new Set([...boxSelect(rects, rect(m)), ...(add ? sel : [])]));
      onSel(n, stepIds(n).at(-1));
    };
    track(move, up, () => setBox(undefined), true);
  };

  // Press a handle and drag: a rubber band follows; releasing over another block in the file sets the link.
  const startLink = (e: PointerEvent<HTMLDivElement>) => {
    const h = (e.target as Element).closest<HTMLElement>('.sx-handle')!;
    const from = h.dataset.zid!, kind = h.dataset.lk as WireKind;
    const vr = view.current!.getBoundingClientRect(), hb = h.getBoundingClientRect();
    const at = (x: number, y: number) => toWorld(camRef.current, { x: x - vr.left, y: y - vr.top });
    const a = at(hb.left + hb.width / 2, hb.top + hb.height / 2), x0 = e.clientX, y0 = e.clientY;
    let to: string | undefined, lk: string | undefined, moved = false;
    const move = (m: globalThis.PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG_PX) return;
      moved = true;
      const el = document.elementFromPoint(m.clientX, m.clientY), over = el?.closest<HTMLElement>('.blk[data-id]')?.dataset.id;
      to = over === from ? undefined : over;
      lk = to === undefined ? el?.closest<HTMLElement>('.sx-loose')?.dataset.loose : undefined;
      setBand({ a, b: at(m.clientX, m.clientY), to: to ?? (lk === undefined ? undefined : `l:${lk}`) });
    };
    const up = () => { if (to) live.current.onEdit((m) => setLink(m, from, kind, to!)); else if (lk !== undefined) live.current.link(from, kind, lk); };
    track(move, up, () => setBand(undefined), true);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    user(); // any press in the view: a drag must never be panned under the pointer
    const p: Press = { button: e.button, shift: e.shiftKey, space: space.current && !isTyping(document.activeElement?.tagName ?? ''), on: onOf(e.target as Element) };
    const g = pickGesture(p);
    if (g === 'pending') {
      const hat = (e.target as Element).closest<HTMLElement>('.sx-hat'), blk = (e.target as Element).closest<HTMLElement>('.blk');
      const lo = (e.target as Element).closest<HTMLElement>('.sx-loose'), fr = blk?.closest<HTMLElement>('.sx-free');
      if (hat) drag.press(e.nativeEvent, { move: ['hat'] }, hat);
      else if (blk && fr && fr.dataset.zid === blk.dataset.id) {
        // a free block moves live like a loose one; the places of all free blocks are noted first
        const k = `s:${blk.dataset.id}`;
        base.current = freePlaces();
        drag.press(e.nativeEvent, { move: sel.has(k) ? [...sel].filter((x) => x.startsWith('s:') && freeIds.has(x.slice(2))) : [k] }, fr);
      }
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
    if (g === 'link') return startLink(e);
    if (g === 'linkclick') return onSel(new Set([`k:${(e.target as Element).closest<HTMLElement>('[data-link]')!.dataset.link}`]));
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
      if (moved) live.current.onCam(camRef.current);
      else if (p.on === 'empty' && p.button === 0 && !p.space) live.current.onSel(new Set());
    };
    track(move, up, () => setPanning(false), false);
  };

  return (
    <div ref={view} className={cx('sx-view', sel.size > 1 && 'sx-multi', panning && 'sx-panning', drag.kind && 'sx-dragging', parking && 'sx-parking', drag.kind && drag.kind !== 'move' && !drag.ok && 'sx-nodrop')} role="region" aria-label="Workspace" aria-describedby="sx-help" tabIndex={0}
      style={{ backgroundPosition: `${cam.x}px ${cam.y}px`, backgroundSize: `${gridPx(cam.zoom)}px ${gridPx(cam.zoom)}px` }}
      onKeyDown={keydown} onContextMenu={contextmenu} onPointerDown={down} onPointerMove={(e) => { ptr.current = { x: e.clientX, y: e.clientY }; }} onPointerLeave={() => { ptr.current = undefined; }} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}>
      <div className="sx-world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}>
        <BlocksPane w={w} steps={steps} diags={diags} text={text} sel={sel} primary={primary} rev={rev} condDrag={drag.kind === 'cond'} src={drag.src} over={drag.over} linkOver={band?.to}
          at={scriptAt} missing={gone} free={{ at: freeAt, moving: movingFree }} onEdit={onEdit} onSelect={pick} />
        <LinkLayer arrows={arrows} then={then} rects={world} lanes={lane} selected={[...sel].find((k) => k.startsWith('k:'))?.slice(2)} band={band} went={wentKeys} />
        {(lay.loose ?? []).map((l) => {
          const k = `l:${l.key}`, d = drag.keys?.includes(k) ? drag.d : undefined;
          return <BlocksPane key={l.key} w={{ ...w, steps: [l.step] }} steps={[]} diags={[]} text="" sel={sel} rev={rev} at={{ x: l.at.x + (d?.x ?? 0), y: l.at.y + (d?.y ?? 0) }} linkOver={band?.to}
            loose={{ key: l.key, selected: sel.has(k), moving: !!drag.keys?.includes(k), onPick: (add) => pickLoose(l.key, add) }} onEdit={() => false} onSelect={() => {}} />;
        })}
        <div className="sx-ghosts" ref={ghosts} />
        {box && <div className="sx-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      </div>
      <p id="sx-help" className="sx-sr">Up and Down move between blocks, Shift extends the selection. Alt with the arrows moves a block, or nudges a free or loose one. Arrows pan the view. Delete removes, Shift+F10 opens the menu.</p>
      <div className="sx-zoom" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" onClick={() => ACTS.zoomOut('')}>−</button>
        <output aria-live="polite">{Math.round(cam.zoom * 100)}%</output>
        <button aria-label="Zoom in" onClick={() => ACTS.zoomIn('')}>+</button>
        <button aria-label="Fit view" onClick={() => ACTS.fit('')}>Fit</button>
        <button aria-label="Reset zoom" onClick={() => ACTS.zoomReset('')}>1:1</button>
      </div>
      {menu && <ContextMenu items={itemsFor(menu.t, menuCtx(menu))} at={menu.at} onRun={(act) => ACTS[act](menu.t === 'block' || menu.t === 'link' ? menu.id : '')}
        onClose={(refocus) => { setMenu(undefined); if (refocus) (menu.opener.isConnected ? menu.opener : view.current)?.focus({ preventScroll: true }); }} />}
    </div>
  );
}
