import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanEditorState, makeSaver, restoreFile, restoreStep } from '../src/editorState.js';

describe('cleanEditorState', () => {
  it('keeps good fields', () => {
    expect(cleanEditorState({ workflow: '/a/b.reins.md', tab: 'text', stepId: 'plan' })).toEqual({ workflow: '/a/b.reins.md', tab: 'text', stepId: 'plan' });
  });
  it('drops wrong types, keeps the rest', () => {
    expect(cleanEditorState({ workflow: 5, tab: 'zzz', stepId: 'x' })).toEqual({ stepId: 'x' });
  });
  it('keeps tab blocks; migrates tab map to blocks', () => {
    expect(cleanEditorState({ tab: 'blocks' })).toEqual({ tab: 'blocks' });
    expect(cleanEditorState({ tab: 'map' })).toEqual({ tab: 'blocks' });
  });
  it('migrates a stored tab canvas to blocks', () => {
    expect(cleanEditorState({ tab: 'canvas' })).toEqual({ tab: 'blocks' });
  });
  it('gives {} for arrays, null, strings and undefined', () => {
    for (const raw of [[], null, 'text', 3, undefined]) expect(cleanEditorState(raw)).toEqual({});
  });
});

describe('cleanEditorState canvas', () => {
  const P = '/w/a.reins.md';
  it('maps tab canvas to blocks and keeps a good cam and script', () => {
    const entry = { cam: { x: 0, y: -5, zoom: 1.5 }, script: { x: 40, y: 60 } };
    expect(cleanEditorState({ tab: 'canvas', canvas: { [P]: entry } })).toEqual({ tab: 'blocks', canvas: { [P]: entry } });
  });
  it('drops the old Map view and a stored pos', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(cleanEditorState({ canvas: { [P]: { pos: { a: { x: 1, y: 2 } }, view: { x: 1, y: 1, zoom: 1 }, cam } } })).toEqual({ canvas: { [P]: { cam } } });
  });
  it('clamps cam zoom to 25 %..200 %; drops a cam with zoom <= 0 or missing numbers', () => {
    expect(cleanEditorState({ canvas: { [P]: { cam: { x: 1, y: 2, zoom: 9 } } } })).toEqual({ canvas: { [P]: { cam: { x: 1, y: 2, zoom: 2 } } } });
    expect(cleanEditorState({ canvas: { [P]: { cam: { x: 1, y: 2, zoom: 0.01 } } } })).toEqual({ canvas: { [P]: { cam: { x: 1, y: 2, zoom: 0.25 } } } });
    for (const cam of [{ x: 0, y: 0, zoom: 0 }, { x: 0, y: 0, zoom: -1 }, { x: 0, y: 0 }, { x: 'a', y: 0, zoom: 1 }, 5]) {
      expect(cleanEditorState({ canvas: { [P]: { cam } } })).toEqual({ canvas: { [P]: {} } });
    }
  });
  it('drops a bad script', () => {
    for (const script of [{ x: 1 }, { x: 'a', y: 2 }, 5, null, { x: NaN, y: 1 }]) {
      expect(cleanEditorState({ canvas: { [P]: { script } } })).toEqual({ canvas: { [P]: {} } });
    }
  });
  it('drops a canvas that is an array or a string', () => {
    expect(cleanEditorState({ canvas: [] })).toEqual({});
    expect(cleanEditorState({ canvas: 'x' })).toEqual({});
  });
  it('drops a per-path entry that is not an object', () => {
    expect(cleanEditorState({ canvas: { [P]: 'x', '/w/b': [], '/w/c': null, '/w/d': { cam: { x: 1, y: 2, zoom: 1 } } } }))
      .toEqual({ canvas: { '/w/d': { cam: { x: 1, y: 2, zoom: 1 } } } });
  });
});

describe('restoreFile / restoreStep', () => {
  const list = [{ path: '/p/.reins/workflows/a.reins.md', name: 'a' }, { path: '/home/.reins/workflows/a.reins.md', name: 'a' }];
  it('matches the absolute path, not the name', () => {
    expect(restoreFile('/home/.reins/workflows/a.reins.md', list)).toBe('/home/.reins/workflows/a.reins.md');
    expect(restoreFile('a', list)).toBeUndefined();
    expect(restoreFile('/gone.reins.md', list)).toBeUndefined();
    expect(restoreFile(undefined, list)).toBeUndefined();
  });
  it('keeps a step only if the preview lists it', () => {
    const steps = [{ id: 'plan' }, { id: 'build' }];
    expect(restoreStep('build', steps)).toBe('build');
    expect(restoreStep('gone', steps)).toBeUndefined();
    expect(restoreStep(undefined, steps)).toBeUndefined();
  });
});

describe('makeSaver', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const make = () => {
    const put = vi.fn(async (_cwd: string, _s: unknown) => ({}));
    return { put, saver: makeSaver('/proj', put, 500) };
  };

  it('is silent until ready', () => {
    const { put, saver } = make();
    saver.set({ tab: 'text' });
    saver.flush();
    vi.advanceTimersByTime(2000);
    expect(put).not.toHaveBeenCalled();
  });

  it('three quick sets give one PUT of the full merged state after 500 ms', () => {
    const { put, saver } = make();
    saver.ready({ workflow: '/w.reins.md', tab: 'chat' });
    saver.set({ tab: 'text' });
    saver.set({ stepId: 'a' });
    saver.set({ stepId: 'b' });
    vi.advanceTimersByTime(499);
    expect(put).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/proj', { workflow: '/w.reins.md', tab: 'text', stepId: 'b' });
  });

  it('flush PUTs a pending save at once, then nothing is pending', () => {
    const { put, saver } = make();
    saver.ready({});
    saver.set({ tab: 'text' });
    saver.flush();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/proj', { tab: 'text' });
    saver.flush();
    vi.advanceTimersByTime(2000);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('flush with nothing pending makes no PUT', () => {
    const { put, saver } = make();
    saver.ready({ tab: 'text' });
    saver.flush();
    vi.advanceTimersByTime(2000);
    expect(put).not.toHaveBeenCalled();
  });

  it('a failed PUT does not throw', async () => {
    const put = vi.fn(async () => { throw new Error('down'); });
    const saver = makeSaver('/proj', put, 500);
    saver.ready({});
    saver.set({ tab: 'text' });
    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('calls onError once when the PUT rejects', async () => {
    const put = vi.fn(async () => { throw new Error('413'); });
    const onError = vi.fn();
    const saver = makeSaver('/proj', put, 500, onError);
    saver.ready({});
    saver.set({ tab: 'text' });
    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]![0].message).toBe('413');
  });
});
