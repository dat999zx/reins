import { describe, expect, it } from 'vitest';
import { boundsOf, clampZoom, edgePan, fitBounds, inside, reveal, toScreen, toWorld, zoomAt, ZOOM, type Cam } from '../src/surface.js';

const cam: Cam = { x: 30, y: -20, zoom: 1.5 };

describe('surface', () => {
  it('toWorld inverts toScreen', () => {
    const p = { x: 123.5, y: -77 };
    const q = toWorld(cam, toScreen(cam, p));
    expect(q.x).toBeCloseTo(p.x, 9);
    expect(q.y).toBeCloseTo(p.y, 9);
  });
  it('clampZoom keeps 25 %..200 %', () => {
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(9)).toBe(2);
    expect(clampZoom(1)).toBe(1);
  });
  it('zoomAt keeps the point under the cursor and clamps', () => {
    const at = { x: 400, y: 250 };
    const w = toWorld(cam, at);
    const n = zoomAt(cam, at, 1.1);
    expect(n.zoom).toBeCloseTo(1.65, 9);
    const s = toScreen(n, w);
    expect(s.x).toBeCloseTo(at.x, 9);
    expect(s.y).toBeCloseTo(at.y, 9);
    expect(zoomAt(cam, at, 100).zoom).toBe(2);
    expect(zoomAt(cam, at, 0.001).zoom).toBe(0.25);
  });
  it('ZOOM.step from 1 gives 1.25', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, ZOOM.step).zoom).toBe(1.25);
  });
  it('boundsOf unions rects; none gives undefined', () => {
    expect(boundsOf([])).toBeUndefined();
    expect(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 30, h: 15 });
  });
  it('fitBounds centres, pads, and never zooms in past 100 %', () => {
    const view = { w: 800, h: 600 };
    const small = fitBounds({ x: 0, y: 0, w: 100, h: 100 }, view);
    expect(small.zoom).toBe(1);
    expect(toScreen(small, { x: 50, y: 50 })).toEqual({ x: 400, y: 300 });
    const big = fitBounds({ x: 0, y: 0, w: 1680, h: 100 }, view, 40);
    expect(big.zoom).toBeCloseTo(720 / 1680, 9);
    expect(toScreen(big, { x: 0, y: 0 }).x).toBeCloseTo(40, 9);
  });
  it('fitBounds may go below the manual minimum (to 10 %) for an overview; zooming out never zooms in', () => {
    const view = { w: 800, h: 600 };
    expect(fitBounds({ x: 0, y: 0, w: 4800, h: 100 }, view).zoom).toBeCloseTo(0.15, 9);
    expect(fitBounds({ x: 0, y: 0, w: 99999, h: 100 }, view).zoom).toBe(0.1);
    expect(zoomAt({ x: 0, y: 0, zoom: 0.1 }, { x: 5, y: 5 }, 1 / ZOOM.step).zoom).toBe(0.1);
    expect(zoomAt({ x: 0, y: 0, zoom: 0.3 }, { x: 5, y: 5 }, 1 / ZOOM.step).zoom).toBe(0.25);
  });
  it('edgePan is zero inside the margin and pushes toward the edge', () => {
    const view = { w: 800, h: 600 };
    expect(edgePan({ x: 400, y: 300 }, view)).toEqual({ x: 0, y: 0 });
    expect(edgePan({ x: 790, y: 300 }, view).x).toBeLessThan(0);
    expect(edgePan({ x: 5, y: 300 }, view).x).toBeGreaterThan(0);
    expect(edgePan({ x: 400, y: 599 }, view).y).toBeLessThan(0);
    expect(Math.abs(edgePan({ x: 1000, y: 300 }, view).x)).toBe(12);
  });
  it('inside is full containment', () => {
    const outer = { x: 0, y: 0, w: 100, h: 100 };
    expect(inside({ x: 10, y: 10, w: 20, h: 20 }, outer)).toBe(true);
    expect(inside({ x: 90, y: 10, w: 20, h: 20 }, outer)).toBe(false);
  });
});

describe('reveal', () => {
  const view = { w: 800, h: 600 };
  const c: Cam = { x: 10, y: 20, zoom: 1.25 };
  it('a block fully inside the view (past the margin) needs no move', () => {
    expect(reveal(c, { x: 100, y: 100, w: 200, h: 80 }, view)).toBeUndefined();
  });
  it('a block outside is centred at the same zoom', () => {
    const r = { x: 2000, y: -900, w: 200, h: 80 };
    const n = reveal(c, r, view)!;
    expect(n.zoom).toBe(c.zoom);
    const mid = toScreen(n, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    expect(mid.x).toBeCloseTo(400, 9);
    expect(mid.y).toBeCloseTo(300, 9);
  });
  it('a block inside the view but inside the margin is moved too', () => {
    const r = { x: -5, y: 100, w: 50, h: 40 };
    expect(toScreen(c, r).x).toBeGreaterThan(0);
    expect(reveal(c, r, view)).toBeDefined();
    expect(reveal(c, r, view, 0)).toBeUndefined();
  });
});