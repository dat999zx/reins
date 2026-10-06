import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type PointerEvent } from 'react';
import type { Diagnostic, Workflow } from '@reins/core';
import { BlocksPane } from './BlocksPane.js';
import { addStepAt, dropPlace, moveStep, newId, setCond, type Place } from './blocks.js';
import { COND_KINDS } from './condKinds.js';
import type { Layout } from './editorState.js';
import { cx } from './generic.js';
import { DRAG_PX, isTyping, pickGesture, type Press } from './gesture.js';
import { fitBounds, toWorld, ZOOM, zoomAt, type Cam, type Pt } from './surface.js';
import { useDrag, type Start } from './useDrag.js';

const HOME = { x: 40, y: 40 };
const NATIVE = 'input, textarea, select, option, button, .sx-menu, .sx-zoom';
const onOf = (t: Element): Press['on'] => (t.closest(NATIVE) ? 'input' : t.closest('.sx-hat') ? 'hat' : t.closest('.blk') ? 'block' : 'empty');

export function Workspace({ w, steps, diags, text, selected, rev, cam: saved, lay, press, onEdit, onSelect, onDelete, onCam, onLayout }: {
  w: Workflow; steps: Array<{ id: string; cond?: string }>; diags: Diagnostic[]; text: string; selected?: string; rev: unknown;
  cam?: Cam; lay: Layout; press: MutableRefObject<Start | undefined>;
  onEdit: (fn: (w: Workflow) => Workflow) => boolean; onSelect: (id: string | undefined) => void; onDelete: (id: string) => void; onCam: (c: Cam) => void;
  onLayout: (fn: (l: Layout) => Layout) => boolean;
}) {
  const view = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Cam>(saved ?? { x: 0, y: 0, zoom: 1 });
  const camRef = useRef(cam);
  const [panning, setPanning] = useState(false);
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

  // The model changes asynchronously (edit -> server print -> new w); focus follows the moved block once it re-renders.
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (refocus.current !== undefined) view.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = undefined;
  }, [w]);
  const move = (id: string, to: Place) => { refocus.current = onEdit((m) => moveStep(m, id, to)) ? id : undefined; };

  const ghosts = useRef<HTMLDivElement>(null);
  const home = lay.script ?? HOME;
  // Legality is asked of the same pure functions that do the edit: a drop is legal iff it would change the model.
  const drag = useDrag({
    view, ghosts, cam: () => camRef.current, setCam: (c, save) => (save ? commit(c) : set(c)),
    legal: (src, t) => {
      if ('hex' in t) return 'cond' in src && setCond(w, t.hex.id, t.hex.path, { t: 'approve' }) !== w;
      const place = 'hit' in t ? dropPlace(w, t.hit) : undefined;
      return !!place && ('id' in src ? moveStep(w, src.id, place) !== w : 'kind' in src && addStepAt(w, 'phase', place) !== w);
    },
    drop: (src, t) => {
      const place = 'hit' in t ? dropPlace(w, t.hit) : undefined;
      if ('hex' in t && 'cond' in src) onEdit((m) => setCond(m, t.hex.id, t.hex.path, COND_KINDS[src.cond]!.fresh()));
      else if (place && 'id' in src) move(src.id, place);
      else if (place && 'kind' in src && onEdit((m) => addStepAt(m, src.kind, place))) onSelect(newId(w, src.kind));
    },
    hat: (d: Pt) => { onLayout((l) => ({ ...l, script: { x: home.x + d.x, y: home.y + d.y } })); },
  });
  press.current = drag.press;

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

  const down = (e: PointerEvent<HTMLDivElement>) => {
    const p: Press = { button: e.button, shift: e.shiftKey, space: space.current && !isTyping(document.activeElement?.tagName ?? ''), on: onOf(e.target as Element) };
    const g = pickGesture(p);
    if (g === 'pending') {
      const hat = (e.target as Element).closest<HTMLElement>('.sx-hat'), blk = (e.target as Element).closest<HTMLElement>('.blk');
      if (hat) drag.press(e.nativeEvent, { hat: true }, hat);
      else if (blk) drag.press(e.nativeEvent, { id: blk.dataset.id! }, blk);
      return;
    }
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
      else if (p.on === 'empty' && p.button === 0 && !p.space) onSelect(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <div ref={view} className={cx('sx-view', panning && 'sx-panning', drag.kind && 'sx-dragging', drag.kind && drag.kind !== 'hat' && !drag.over && 'sx-nodrop')} role="region" aria-label="Workspace" tabIndex={0}
      style={{ backgroundPosition: `${cam.x}px ${cam.y}px`, backgroundSize: `${18 * cam.zoom}px ${18 * cam.zoom}px` }}
      onPointerDown={down} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}>
      <div className="sx-world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}>
        <BlocksPane w={w} steps={steps} diags={diags} text={text} selected={selected} rev={rev} condDrag={drag.kind === 'cond'} src={drag.src} over={drag.over}
          at={{ x: home.x + (drag.d?.x ?? 0), y: home.y + (drag.d?.y ?? 0) }} onEdit={onEdit} onSelect={onSelect} onDelete={onDelete} onMove={move} />
        <div className="sx-ghosts" ref={ghosts} />
      </div>
      <div className="sx-zoom" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" onClick={() => zoom(1 / ZOOM.step)}>−</button>
        <output aria-live="polite">{Math.round(cam.zoom * 100)}%</output>
        <button aria-label="Zoom in" onClick={() => zoom(ZOOM.step)}>+</button>
        <button aria-label="Fit view" onClick={fit}>Fit</button>
        <button aria-label="Reset zoom" onClick={() => zoom(1 / camRef.current.zoom)}>1:1</button>
      </div>
    </div>
  );
}
