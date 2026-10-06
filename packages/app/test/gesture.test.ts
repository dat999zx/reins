import { describe, expect, it } from 'vitest';
import { DRAG_PX, pickGesture, type Press } from '../src/gesture.js';

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
  it('left on a block, hat or loose block is none until the drag engine exists', () => {
    for (const on of ['block', 'hat', 'loose'] as const) expect(pickGesture(press({ on }))).toBe('none');
  });
  it('left on empty surface pans', () => {
    expect(pickGesture(press({}))).toBe('pan');
  });
  it('right button and presses outside do nothing', () => {
    expect(pickGesture(press({ button: 2 }))).toBe('none');
    expect(pickGesture(press({ on: 'outside' }))).toBe('none');
  });
  it('the drag threshold is 4 px', () => {
    expect(DRAG_PX).toBe(4);
  });
});
