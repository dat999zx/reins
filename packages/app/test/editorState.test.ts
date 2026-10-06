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

describe('cleanEditorState loose blocks', () => {
  const P = '/w/a.reins.md';
  const step = (o: Record<string, unknown> = {}) => ({ id: 'plan', kind: 'phase', attrs: {}, cards: [], links: [], ...o });
  const loose = (key: string, s: unknown = step(), at: unknown = { x: 5, y: 6 }) => ({ key, at, step: s });
  const read = (list: unknown[], onDropped?: (n: number) => void) => cleanEditorState({ canvas: { [P]: { loose: list } } }, onDropped).canvas![P]!.loose;

  it('keeps a good loose block, with a C block and its kids', () => {
    const c = step({ id: 'r', kind: 'repeat', attrs: { max: '3' }, cond: { t: 'tests' }, kids: [step({ id: 'k', kind: 'run', attrs: { cmd: 'x' } })] });
    expect(read([loose('l1'), loose('l2', c)])).toEqual([loose('l1'), loose('l2', c)]);
  });
  it('drops pos from the step, its cards and its links', () => {
    const s = step({ pos: { line: 3, col: 1 }, cards: [{ kind: 'guard', text: 'x', pos: { line: 4, col: 1 } }], links: [{ kind: 'next', to: 'b', max: 2, pos: { line: 5, col: 1 } }] });
    expect(read([loose('l1', s)])).toEqual([loose('l1', step({ cards: [{ kind: 'guard', text: 'x' }], links: [{ kind: 'next', to: 'b', max: 2 }] }))]);
  });
  it('drops bad entries and counts them', () => {
    const bad = [
      loose('', step()), loose('l1', step()), loose('l1', step()), // empty key, then a duplicate key
      loose('l2', step({ kind: 'nope' })), loose('l3', step({ id: '' })), loose('l4', step({ attrs: { a: 1 } })),
      loose('l5', step({ cards: [{ kind: 'zzz', text: 'x' }] })), loose('l6', step({ links: [{ kind: 'next', to: 'b', max: 0 }] })),
      loose('l7', step({ links: [{ kind: 'sideways', to: 'b' }] })), loose('l8', step({ cond: { t: 5 } })),
      loose('l9', step({ kids: [step()] })), // phase has no body
      loose('l10', step(), { x: 'a', y: 1 }), loose('l11', 'x'), 5, null,
    ];
    const n = vi.fn();
    expect(read(bad, n)!.map((l) => l.key)).toEqual(['l1']);
    expect(n).toHaveBeenCalledWith(bad.length - 1);
  });
  it('does not call onDropped when everything reads', () => {
    const n = vi.fn();
    read([loose('l1')], n);
    expect(n).not.toHaveBeenCalled();
  });
  it('keeps at most 100 loose blocks and counts the rest as dropped', () => {
    const many = Array.from({ length: 103 }, (_, i) => loose(`l${i}`));
    const n = vi.fn();
    expect(read(many, n)).toHaveLength(100);
    expect(n).toHaveBeenCalledWith(3);
  });
  it('drops a loose that is not an array', () => {
    expect(cleanEditorState({ canvas: { [P]: { loose: 'x' } } })).toEqual({ canvas: { [P]: {} } });
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

describe('cleanEditorState free blocks', () => {
  const P = '/w/a.reins.md';
  const read = (free: unknown) => cleanEditorState({ canvas: { [P]: { free } } }).canvas![P]!.free;
  it('keeps good positions and drops bad ones', () => {
    expect(read({ fix: { x: 1, y: 2 }, bad: { x: 'a', y: 1 }, nan: { x: NaN, y: 1 }, half: { x: 1 }, str: 5 })).toEqual({ fix: { x: 1, y: 2 } });
  });
  it('drops free that is not an object, or that has nothing good in it', () => {
    for (const f of [[], 'x', 5, null, {}, { a: 1 }]) expect(read(f)).toBeUndefined();
  });
});