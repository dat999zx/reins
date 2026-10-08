export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Cam = { x: number; y: number; zoom: number }; // screen = world * zoom + (x, y), in viewport pixels
export const ZOOM = { min: 0.25, max: 2, step: 1.25, wheel: 1.1, fit: 0.1 }; // `fit`: the floor of Fit's overview, below the manual minimum

export const toScreen = (c: Cam, p: Pt): Pt => ({ x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y });
export const toWorld = (c: Cam, p: Pt): Pt => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom });
export const clampZoom = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));

export function zoomAt(c: Cam, at: Pt, factor: number): Cam {
  const zoom = factor < 1 ? Math.max(c.zoom * factor, Math.min(c.zoom, ZOOM.min)) : clampZoom(c.zoom * factor); // zooming out never zooms in from a Fit overview
  const w = toWorld(c, at);
  return { x: at.x - w.x * zoom, y: at.y - w.y * zoom, zoom };
}

export function boundsOf(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

export function fitBounds(b: Rect, view: { w: number; h: number }, pad = 40): Cam {
  const zoom = Math.max(ZOOM.fit, Math.min(1, (view.w - 2 * pad) / Math.max(b.w, 1), (view.h - 2 * pad) / Math.max(b.h, 1)));
  return { zoom, x: view.w / 2 - (b.x + b.w / 2) * zoom, y: view.h / 2 - (b.y + b.h / 2) * zoom };
}

// How far to pan the camera per frame: toward the surface's inside, so it reveals what is past the edge the pointer is at.
export function edgePan(p: Pt, view: { w: number; h: number }, margin = 40, max = 12): Pt {
  const axis = (v: number, size: number) => {
    if (v < margin) return Math.min(max, ((margin - v) / margin) * max);
    if (v > size - margin) return -Math.min(max, ((v - (size - margin)) / margin) * max);
    return 0;
  };
  return { x: axis(p.x, view.w), y: axis(p.y, view.h) };
}

export const inside = (i: Rect, o: Rect) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;

// Where the camera must go to show a block: nowhere when it is already inside the view (past margin on every side), else centred at the same zoom.
export function reveal(cam: Cam, r: Rect, view: { w: number; h: number }, margin = 44): Cam | undefined {
  const a = toScreen(cam, r), z = cam.zoom;
  if (a.x >= margin && a.y >= margin && a.x + r.w * z <= view.w - margin && a.y + r.h * z <= view.h - margin) return undefined;
  return { zoom: z, x: view.w / 2 - (r.x + r.w / 2) * z, y: view.h / 2 - (r.y + r.h / 2) * z };
}
