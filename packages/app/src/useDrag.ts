import { useRef, useState } from 'react';
import type { StepKind } from '@reins/core';
import { DRAG_PX, hitOf, snapOf, zoneKey, type Target, type Zone } from './gesture.js';
import { edgePan, toWorld, type Cam, type Pt } from './surface.js';

export type Src = { id: string } | { kind: StepKind } | { cond: string } | { hat: true };
export type Start = (e: PointerEvent, src: Src, el: Element) => void;
export type Over = { el: Zone; cls: string };
type Live = { kind?: 'step' | 'cond' | 'hat'; src?: string; over?: Over; d?: Pt };
type Opts = {
  view: { current: HTMLElement | null }; ghosts: { current: HTMLElement | null };
  cam(): Cam; setCam(c: Cam, save?: boolean): void;
  legal(src: Src, t: Target): boolean; drop(src: Src, t: Target): void; hat(d: Pt): void;
};

const ZONE_ATTRS = ['data-id', 'data-zone', 'data-zid', 'data-zb', 'data-zpath'];
const zoneOf = (el: HTMLElement): Zone => ({ type: el.dataset.zone as Zone['type'], id: el.dataset.zid, branch: el.dataset.zb as Zone['branch'], path: el.dataset.zpath });

// One pointer engine for every drag: a press becomes a drag after DRAG_PX, the drop is found with elementFromPoint.
// ponytail: the ghost is a DOM clone; its look is frozen at press time. Wheel zoom during a drag is not followed.
export function useDrag(o: Opts) {
  const oref = useRef(o);
  oref.current = o;
  const [live, setLive] = useState<Live>({});

  const press: Start = (e, src, el) => {
    if (e.button !== 0) return;
    const from = { x: e.clientX, y: e.clientY };
    const at = { ...from };
    const box = el.getBoundingClientRect();
    const grab = { x: from.x - box.left, y: from.y - box.top };
    const zoom0 = oref.current.cam().zoom;
    const kind = 'hat' in src ? 'hat' : 'cond' in src ? 'cond' : 'step';
    const card = 'kind' in src || 'cond' in src;
    const rel = (p: Pt) => { const r = oref.current.view.current!.getBoundingClientRect(); return { x: p.x - r.left, y: p.y - r.top }; };
    const start = toWorld(oref.current.cam(), rel(from));
    let ghost: HTMLElement | undefined, on = false, panned = false, key = '', raf = 0;

    // What a release here would do: the drop target and its snap bar, only when legal.
    const probe = (): { t?: Target; snap?: Over } => {
      const v = oref.current.view.current!, r = v.getBoundingClientRect();
      if (at.x < r.left || at.x > r.right || at.y < r.top || at.y > r.bottom) return {};
      let z = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>('[data-zone]');
      if (z?.dataset.zone === 'hex' && kind !== 'cond') z = z.parentElement?.closest<HTMLElement>('[data-zone]'); // a step over a hexagon falls through to its block
      const zone = z && v.contains(z) ? zoneOf(z) : undefined;
      if (kind === 'cond' && zone?.type !== 'hex') return {};
      const b = z?.getBoundingClientRect();
      const half = b && at.y < b.top + b.height / 2 ? 'top' : 'bottom';
      const t = zone ? hitOf(zone, half) : { surface: true as const };
      return t && oref.current.legal(src, t) ? { t, snap: zone && snapOf(zone, half) } : {};
    };
    const update = () => {
      const c = oref.current.cam();
      if (ghost) {
        const g = { x: at.x - grab.x, y: at.y - grab.y }, p = card ? g : toWorld(c, rel(g));
        ghost.style.left = `${p.x}px`;
        ghost.style.top = `${p.y}px`;
      }
      if (kind === 'hat') {
        const w = toWorld(c, rel(at));
        return setLive((s) => ({ ...s, d: { x: w.x - start.x, y: w.y - start.y } }));
      }
      const { snap } = probe();
      const k = snap ? zoneKey(snap.el) + snap.cls : '';
      if (k !== key) { key = k; setLive((s) => ({ ...s, over: snap })); }
    };
    const begin = () => {
      on = true;
      if (kind !== 'hat') {
        ghost = el.cloneNode(true) as HTMLElement;
        for (const n of [ghost, ...ghost.querySelectorAll('[data-id], [data-zone]')]) for (const a of ZONE_ATTRS) n.removeAttribute(a);
        ghost.inert = true;
        ghost.classList.add('sx-ghost', card ? 'sx-ghost-card' : 'sx-ghost-block');
        ghost.style.width = `${box.width / (card ? 1 : zoom0)}px`;
        (card ? document.body : oref.current.ghosts.current!).append(ghost);
      }
      setLive({ kind, src: 'id' in src ? src.id : undefined });
      const tick = () => {
        const r = oref.current.view.current!.getBoundingClientRect();
        if (at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom) {
          const v = edgePan(rel(at), { w: r.width, h: r.height }), c = oref.current.cam();
          if (v.x || v.y) { panned = true; oref.current.setCam({ ...c, x: c.x + v.x, y: c.y + v.y }); update(); }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const end = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', esc);
      ghost?.remove();
      setLive({});
      if (panned) oref.current.setCam(oref.current.cam(), true);
    };
    const move = (m: globalThis.PointerEvent) => {
      at.x = m.clientX; at.y = m.clientY;
      if (!on && Math.hypot(at.x - from.x, at.y - from.y) < DRAG_PX) return;
      if (!on) begin();
      update();
    };
    const up = (m: globalThis.PointerEvent) => {
      at.x = m.clientX; at.y = m.clientY;
      const done = on;
      const t = done && kind !== 'hat' ? probe().t : undefined;
      const w = toWorld(oref.current.cam(), rel(at));
      end();
      if (!done) return;
      // the click that follows a drag must not select or press anything
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      if (kind === 'hat') oref.current.hat({ x: w.x - start.x, y: w.y - start.y });
      else if (t) oref.current.drop(src, t);
    };
    const esc = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.preventDefault(); end(); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', esc);
  };

  return { press, ...live };
}
