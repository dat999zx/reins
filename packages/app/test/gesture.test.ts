import { describe, expect, it } from 'vitest';
import { DRAG_PX, hitOf, pickGesture, snapOf, zoneKey, type Press, type Zone } from '../src/gesture.js';

const press = (p: Partial<Press>): Press => ({ button: 0, shift: false, space: false, on: 'empty', ...p });

describe('pickGesture', () => {
  it('middle button pans anywhere, even over a block', () => {
    expect(pickGesture(press({ button: 1 }))).toBe('pan');
    expect(pickGesture(press({ button: 1, on: 'block' }))).toBe('pan');
  });
  it('left with Space pans', () => {
    expect(pickGesture(press({ space: true }))).toBe('pan');
    expect(pickGesture(press({ space: true, on: 'block' }))).toBe('pan');
  });
  it('left on an input, select, button or menu is native', () => {
    expect(pickGesture(press({ on: 'input' }))).toBe('none');
    expect(pickGesture(press({ on: 'input', space: true }))).toBe('none');
  });
  it('left on a block, hat or loose block is a pending drag', () => {
    for (const on of ['block', 'hat', 'loose'] as const) expect(pickGesture(press({ on }))).toBe('pending');
  });
  it('left on empty surface pans', () => {
    expect(pickGesture(press({}))).toBe('pan');
  });
  it('Shift on empty surface draws a selection box; Shift on a block still drags; Space still pans', () => {
    expect(pickGesture(press({ shift: true }))).toBe('box');
    expect(pickGesture(press({ shift: true, on: 'block' }))).toBe('pending');
    expect(pickGesture(press({ shift: true, space: true }))).toBe('pan');
  });
  it('left on a link handle draws a link; left on an arrow selects it', () => {
    expect(pickGesture(press({ on: 'handle' }))).toBe('link');
    expect(pickGesture(press({ on: 'link' }))).toBe('linkclick');
    expect(pickGesture(press({ on: 'handle', button: 2 }))).toBe('none');
    expect(pickGesture(press({ on: 'link', button: 2 }))).toBe('none');
  });
  it('right button and presses outside do nothing', () => {
    expect(pickGesture(press({ button: 2 }))).toBe('none');
    expect(pickGesture(press({ on: 'outside' }))).toBe('none');
  });
  it('the drag threshold is 4 px', () => {
    expect(DRAG_PX).toBe(4);
  });
});

const z = (type: Zone['type'], id?: string, extra: Partial<Zone> = {}): Zone => ({ type, id, ...extra });

describe('hitOf', () => {
  it('a block is before in its top half, after in its bottom half', () => {
    expect(hitOf(z('block', 'a'), 'top')).toEqual({ hit: { block: 'a', edge: 'before' } });
    expect(hitOf(z('block', 'a'), 'bottom')).toEqual({ hit: { block: 'a', edge: 'after' } });
  });
  it('ids end and hat are plain block ids, the end and hat zones are other zones', () => {
    expect(hitOf(z('block', 'end'), 'bottom')).toEqual({ hit: { block: 'end', edge: 'after' } });
    expect(hitOf(z('block', 'hat'), 'top')).toEqual({ hit: { block: 'hat', edge: 'before' } });
    expect(hitOf(z('end'), 'top')).toEqual({ hit: { top: 'end' } });
    expect(hitOf(z('hat'), 'bottom')).toEqual({ hit: { top: 'start' } });
    expect(zoneKey(z('block', 'end'))).not.toBe(zoneKey(z('end')));
  });
  it('a cap takes a drop in its top half only', () => {
    expect(hitOf(z('cap', 'e'), 'top')).toEqual({ hit: { block: 'e', edge: 'before' } });
    expect(hitOf(z('cap', 'e'), 'bottom')).toBeUndefined();
  });
  it('a C head is before in the top half and into the body in the bottom half', () => {
    expect(hitOf(z('chead', 'r'), 'top')).toEqual({ hit: { block: 'r', edge: 'before' } });
    expect(hitOf(z('chead', 'r'), 'bottom')).toEqual({ hit: { block: 'r', edge: 'into' } });
  });
  it('a body, else bar and foot', () => {
    expect(hitOf(z('body', 'r', { branch: 'else' }), 'top')).toEqual({ hit: { body: 'r', branch: 'else' } });
    expect(hitOf(z('mid', 'r'), 'bottom')).toEqual({ hit: { block: 'r', edge: 'else' } });
    expect(hitOf(z('foot', 'r'), 'top')).toEqual({ hit: { block: 'r', edge: 'after' } });
  });
  it('a hexagon carries its block and condition path', () => {
    expect(hitOf(z('hex', 'r', { path: '' }), 'top')).toEqual({ hex: { id: 'r', path: [] } });
    expect(hitOf(z('hex', 'r', { path: 'a.b' }), 'top')).toEqual({ hex: { id: 'r', path: ['a', 'b'] } });
  });
  it('free blocks take no drop; loose blocks and the surface are the surface', () => {
    expect(hitOf(z('free', 'f'), 'top')).toBeUndefined();
    expect(hitOf(z('loose'), 'top')).toEqual({ surface: true });
    expect(hitOf(z('surface'), 'bottom')).toEqual({ surface: true });
  });
});

describe('snapOf', () => {
  it('names the element that shows the bar, and its class', () => {
    expect(snapOf(z('block', 'a'), 'top')).toEqual({ el: z('block', 'a'), cls: 'sx-before' });
    expect(snapOf(z('block', 'a'), 'bottom')).toEqual({ el: z('block', 'a'), cls: 'sx-after' });
    expect(snapOf(z('chead', 'r'), 'bottom')).toEqual({ el: z('body', 'r', { branch: 'kids' }), cls: 'sx-into' });
    expect(snapOf(z('mid', 'r'), 'top')).toEqual({ el: z('body', 'r', { branch: 'else' }), cls: 'sx-into' });
    expect(snapOf(z('end'), 'top')).toEqual({ el: z('end'), cls: 'sx-end' });
    expect(snapOf(z('hex', 'r', { path: '' }), 'top')).toEqual({ el: z('hex', 'r', { path: '' }), cls: 'sx-hexover' });
  });
});