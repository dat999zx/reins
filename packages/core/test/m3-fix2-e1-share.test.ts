// M3 fix round 2, group E1, item N1: a track with no share and no `usd:` of its own, started by a track that HAS a share (an own playbook in a fork branch),
// is held to what that share has left, not to the workflow room. The pack is registered by the core project's setup; `split` is the toy that starts tracks with no share.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseWorkflow } from '../src/format/parse.js';
import { Run, type RunSnapshot } from '../src/run.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { receipt } from '../src/receipt.js';
import { m2harness } from './m2-harness.js';

const FIX = path.join(__dirname, 'fixtures', 'blocks');
const resolver = (extra: Record<string, string> = {}) => (name: string): Workflow | undefined => {
  if (Object.hasOwn(extra, name)) return parseWorkflow(extra[name]!).workflow;
  const p = path.join(FIX, `${name}.reins.md`);
  return /^[a-z-]+$/.test(name) && fs.existsSync(p) ? parseWorkflow(fs.readFileSync(p, 'utf8')).workflow : undefined;
};
const blockText = (body: string) => `---\nreins: 1\nblock: b\n---\n\n${body}\n`;
const wf = (body: string, usd?: number): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 60, minutes: 60${usd === undefined ? '' : `, usd: ${usd.toFixed(2)}`} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};
type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, usd?: number, extra: Record<string, string> = {}) =>
  new Run({ workflow: wf(body, usd), engine: h.engine, openSubagent: h.openSubagent, now: h.now, resolveBlock: resolver(extra) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drive = async (run: Run) => {
  for (let k = 0; k < 60 && run.status === 'running'; k++) if (await Promise.race([run.step().then(() => 'ok'), sleep(2000).then(() => 'stuck')]) === 'stuck') return;
};
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const opensOf = (h: Harness, key: string) => h.subagentOpens.filter((o) => o.step === key);
const done = (text: string, cost = 0): ScriptedTurn => ({ text: `${text}\nREINS: done`, cost });
const cut = (cost: number): ScriptedTurn => ({ text: '', cost, isError: true });

const FORK = (a: string, b: string) => `## fork\nnext: ${a}\nnext: ${b}\n\n## phase after\n> after\n\n## end\n\n`;
const OWN = (id: string, extra = '') => `## playbook review-pass\nid: ${id}\ninput: target = t; depth = 1\nsession: own\n${extra}\n## end\n\n`;
const TWO = FORK('p1', 'p2') + OWN('p1') + OWN('p2');
const sub = (s: string, step: string) => `${s}-sub-${step}`;
const runCost = (run: Run) => run.snapshot().runCost!;

describe('N1: two fork branches, each with an own playbook with no usd:', () => {
  it('the playbook tracks open with the branch share (1 each), not the room (2 each)', async () => {
    const h = m2harness('N1a');
    const run = mk(h, TWO, 2);
    await drive(run);
    expect(opensOf(h, 'p1#own')[0]!.maxUsd).toBe(1);
    expect(opensOf(h, 'p2#own')[0]!.maxUsd).toBe(1);
    await run.close();
  });

  it('one track spending does not lift the other: its live room stays at its own share', async () => {
    const h = m2harness('N1b');
    h.script(sub('N1b', 'p1#own'), done('r', 0.75), done('FOUND', 0.75), { text: 'fine' });
    const h1 = h.hold(sub('N1b', 'p1#own'));
    const h2 = h.hold(sub('N1b', 'p2#own'));
    const run = mk(h, TWO, 2);
    const driven = drive(run);
    await Promise.all([h1.started, h2.started]);
    expect(opensOf(h, 'p1#own')[0]!.usdRoom!()).toBe(1);
    expect(opensOf(h, 'p2#own')[0]!.usdRoom!()).toBe(1);
    const h1b = h.hold(sub('N1b', 'p1#own'));
    h1.release();
    await h1b.started;
    expect(opensOf(h, 'p1#own')[0]!.usdRoom!()).toBeCloseTo(0.25, 6);   // its share less what it spent
    expect(opensOf(h, 'p2#own')[0]!.usdRoom!()).toBe(1);   // at HEAD: 1.25 (the room less p1's spend)
    h1b.release(); h2.release();
    await Promise.race([driven.catch(() => {}), sleep(3000)]);
    await run.close();
  });

  it('a branch that goes over its share is cut at the share: a re-share row or the card, never silent', async () => {
    const h = m2harness('N1c');
    // p1 spends 0.8 and then a reply cut off at its share (0.8 more); p2 spends little.
    h.script(sub('N1c', 'p1#own'), done('r', 0.8), cut(0.8), done('FOUND', 0), { text: 'fine' });
    h.script(sub('N1c', 'p2#own'), done('r', 0.1), done('FOUND', 0.1), { text: 'fine', cost: 0.1 });
    const run = mk(h, TWO, 2);
    await drive(run);
    const warned = named(run, 'budget_warning').some((e) => /used its share/.test(String(e.data.text)));
    expect(warned || named(run, 'budget_reached').length > 0).toBe(true);   // at HEAD: neither
    await run.close();
  });

  it('the receipt adds up: the track rows and the main line are the run total', async () => {
    const h = m2harness('N1d');
    h.script(sub('N1d', 'p1#own'), done('r', 0.2), done('FOUND', 0.2), { text: 'fine', cost: 0.1 });
    h.script(sub('N1d', 'p2#own'), done('r', 0.3), done('FOUND', 0.1), { text: 'fine', cost: 0.1 });
    const run = mk(h, TWO, 2);
    await drive(run);
    expect(run.status).toBe('done');
    const r = receipt(run.getEvents());
    expect(r.totalCostUsd).toBeCloseTo(1.0, 6);
    expect(runCost(run)).toBeCloseTo(1.0, 6);
    const costOf = (k: string) => r.tracks!.find((t) => t.key === k)!.usd;
    expect(costOf('p1#own')).toBeCloseTo(0.5, 6);
    expect(costOf('p2#own')).toBeCloseTo(0.5, 6);
    expect(r.tracks!.reduce((a, t) => a + t.usd, 0)).toBeCloseTo(r.totalCostUsd, 6);
    await run.close();
  });

  it('an own usd: is still held to what the branch share has left', async () => {
    const h = m2harness('N1e');
    const run = mk(h, FORK('p1', 'p2') + OWN('p1', 'usd: 0.5\n') + OWN('p2', 'usd: 5\n'), 2);
    await drive(run);
    expect(opensOf(h, 'p1#own')[0]!.maxUsd).toBe(0.5);
    expect(opensOf(h, 'p2#own')[0]!.maxUsd).toBe(1);
    await run.close();
  });
});

describe('N1: the share rules for tracks inside branches', () => {
  /** p2's playbook has spent 0.1 and waits on its second reply; p1's playbook gets a first reply cut off at 1.0 (its whole share). Returns the run at that point. */
  const crossed = async (name: string, p2Ends: boolean) => {
    const h = m2harness(name);
    h.script(sub(name, 'p1#own'), cut(1.0), done('r'), done('FOUND'), { text: 'fine' });
    h.script(sub(name, 'p2#own'), done('r', 0.1), done('FOUND'), { text: 'fine' });
    const hp1 = h.hold(sub(name, 'p1#own'));
    h.hold(sub(name, 'p1#own'));   // a reopened session of the same id waits here, so the shares can be read as the re-share left them
    const hp2 = h.hold(sub(name, 'p2#own'));
    const hp2b = p2Ends ? undefined : h.hold(sub(name, 'p2#own'));
    const run = mk(h, TWO, 2);
    const driven = drive(run);
    await Promise.all([hp1.started, hp2.started]);
    hp2.release();
    if (hp2b) await hp2b.started;
    else await until(() => named(run, 'track_ended').some((e) => e.data.track === 'p2'));
    hp1.release();
    await sleep(100);
    return { h, run, driven, hp2b };
  };
  const shareOf = (run: Run, k: string) => run.tracks.get(k)!.share!;

  it('what the other branch still holds is not free: the cut branch asks (the card), and its own parent is not counted twice', async () => {
    const { run, driven, hp2b } = await crossed('N1i', false);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used' });
    expect(named(run, 'budget_warning')).toEqual([]);
    hp2b!.release();
    await run.stop();
    await Promise.race([driven.catch(() => {}), sleep(2000)]);
    await run.close();
  });

  it('an Allow shares the new room among the tracks that spend, and each branch keeps at least what its playbook has left', async () => {
    const { run, driven, hp2b } = await crossed('N1j', false);
    expect(run.allowUsd(1)).toBeUndefined();
    expect(run.usdLeft()).toBeCloseTo(1.9, 6);   // 2 + 1 - 1.1
    expect(shareOf(run, 'p1#own')).toBeCloseTo(1.95, 6);   // spent 1.0 + 1.9 / 2
    expect(shareOf(run, 'p2#own')).toBeCloseTo(1.05, 6);   // spent 0.1 + 1.9 / 2
    expect(shareOf(run, 'p1')).toBeCloseTo(1.95, 6);   // the branch holds what the playbook holds
    expect(shareOf(run, 'p2')).toBeCloseTo(1.05, 6);
    hp2b!.release();
    await Promise.race([driven.catch(() => {}), sleep(3000)]);
    await run.close();
  });

  it('a branch that ended gives its unused share back: the cut playbook takes it, and its branch is lifted to it', async () => {
    const { run, driven } = await crossed('N1k', true);
    expect(named(run, 'budget_warning').some((e) => /used its share of the USD budget; it goes on with \$0\.90 the others/.test(String(e.data.text)))).toBe(true);
    expect(shareOf(run, 'p1#own')).toBeCloseTo(1.9, 6);
    expect(shareOf(run, 'p1')).toBeCloseTo(1.9, 6);
    await Promise.race([driven.catch(() => {}), sleep(3000)]);
    await run.close();
  });

  it('a live branch holds its share once (not the branch and its playbook both): a third branch that ended leaves its unused part free', async () => {
    const h = m2harness('N1n');
    h.script(sub('N1n', 'p1#own'), cut(1.0), done('r'), { text: 'fine' });
    h.script(sub('N1n', 'p3'), done('p3', 0.1));
    const hp1 = h.hold(sub('N1n', 'p1#own'));
    h.hold(sub('N1n', 'p1#own'));   // the reopened session waits here
    const hp2 = h.hold(sub('N1n', 'p2#own'));
    const run = mk(h, `## fork\nnext: p1\nnext: p2\nnext: p3\n\n## phase after\n> after\n\n## end\n\n` + OWN('p1') + OWN('p2') + `## phase p3\nid: p3\n> p3\n\n## end\n\n`, 3);
    const driven = drive(run);
    await Promise.all([hp1.started, hp2.started]);
    await until(() => named(run, 'track_ended').some((e) => e.data.track === 'p3'));
    hp1.release();
    await sleep(100);
    // room 3 - 1.1 spent = 1.9; the live branch p2 holds 1; so 0.9 is free (a double count of p2 and its playbook would leave none)
    expect(named(run, 'budget_warning').some((e) => /goes on with \$0\.90 the others/.test(String(e.data.text)))).toBe(true);
    expect(shareOf(run, 'p1#own')).toBeCloseTo(1.9, 6);
    hp2.release();
    await Promise.race([driven.catch(() => {}), sleep(1500)]);
    await run.close();
  });

  it('a playbook started when the room is less than its branch share left gets the room', async () => {
    const h = m2harness('N1q');
    h.script(sub('N1q', 'p2'), done('p2', 1.5));   // p2 spends past its share of 1 (a fake engine holds no cap)
    const h1 = h.hold(sub('N1q', 'p1'));
    const hp = h.hold(sub('N1q', 'pb#own'));
    const branch = `## phase p1\nid: p1\n> p1\n\n## playbook review-pass\nid: pb\ninput: target = t; depth = 1\nsession: own\n\n## end\n\n`;
    const run = mk(h, FORK('p1', 'p2') + branch + `## phase p2\nid: p2\n> p2\n\n## end\n\n`, 2);
    const driven = drive(run);
    await h1.started;
    await until(() => named(run, 'track_ended').some((e) => e.data.track === 'p2'));
    h1.release();
    await hp.started;
    expect(opensOf(h, 'pb#own')[0]!.maxUsd).toBeCloseTo(0.5, 6);   // not the 1 the branch share has left
    expect(run.tracks.get('pb#own')!.share).toBeCloseTo(0.5, 6);
    hp.release();
    await Promise.race([driven.catch(() => {}), sleep(1500)]);
    await run.close();
  });

  it('a live track that spent past its share does not add to the free room', async () => {
    const h = m2harness('N1r');
    h.script(sub('N1r', 'p1#own'), cut(1.0), done('r'));
    h.script(sub('N1r', 'p2#own'), done('r', 1.4), done('FOUND'));
    h.script(sub('N1r', 'p3'), done('p3', 0.1));
    const hp1 = h.hold(sub('N1r', 'p1#own'));
    h.hold(sub('N1r', 'p1#own'));   // the reopened session waits here
    const hp2 = h.hold(sub('N1r', 'p2#own'));
    const hp2b = h.hold(sub('N1r', 'p2#own'));
    const run = mk(h, `## fork\nnext: p1\nnext: p2\nnext: p3\n\n## phase after\n> after\n\n## end\n\n` + OWN('p1') + OWN('p2') + `## phase p3\nid: p3\n> p3\n\n## end\n\n`, 3);
    const driven = drive(run);
    await Promise.all([hp1.started, hp2.started]);
    hp2.release();
    await hp2b.started;   // p2's playbook has spent 1.4 of its 1
    await until(() => named(run, 'track_ended').some((e) => e.data.track === 'p3'));
    hp1.release();
    await sleep(100);
    // room 3 - (1.0 + 1.4 + 0.1) = 0.5; the overspent p2 holds nothing and takes nothing from it
    expect(named(run, 'budget_warning').some((e) => /goes on with \$0\.50 the others/.test(String(e.data.text)))).toBe(true);
    hp2b.release();
    await Promise.race([driven.catch(() => {}), sleep(1500)]);
    await run.close();
  });

  it('a limit crossed by two playbook tracks at once: the run asks once and keeps both replies', async () => {
    const h = m2harness('N1l');
    h.script(sub('N1l', 'p1#own'), cut(0.7));
    h.script(sub('N1l', 'p2#own'), cut(0.7));
    const a = h.hold(sub('N1l', 'p1#own')), b = h.hold(sub('N1l', 'p2#own'));
    const run = mk(h, TWO, 1);
    const driven = drive(run);
    await Promise.all([a.started, b.started]);
    expect(opensOf(h, 'p1#own')[0]!.maxUsd).toBe(0.5);
    a.release(); b.release();
    await Promise.race([driven.catch(() => {}), sleep(3000)]);
    expect(run.status).toBe('paused');
    expect(named(run, 'budget_reached')).toHaveLength(1);
    expect(runCost(run)).toBeCloseTo(1.4, 6);
    await run.close();
  });

  it('a branch whose group ended reopens its session under what its share has left', async () => {
    const h = m2harness('N1m');
    h.script(sub('N1m', 'pb#own'), done('r', 0.6), done('FOUND', 0), { text: 'fine' });
    const branch = `## phase p1\nid: p1\n> p1\n\n## playbook review-pass\nid: pb\ninput: target = t; depth = 1\nsession: own\n\n## phase fin\nid: fin\n> fin\n\n## end\n\n`;
    const run = mk(h, FORK('p1', 'p2') + branch + `## phase p2\nid: p2\n> p2\n\n## end\n\n`, 2);
    await drive(run);
    expect(run.status).toBe('done');
    // the branch's own session opened for its first phase (the whole share), and again after the playbook spent 0.6 of it
    expect(opensOf(h, 'p1').map((o) => o.maxUsd)).toEqual([1, 0.4]);
    await run.close();
  });
});

describe('N1: nesting', () => {
  const outer = blockText('## playbook review-pass\ninput: target = t; depth = 1\nsession: own\n\n## phase tail\n> tail');
  const NEST = FORK('a', 'o') + `## phase a\nid: a\n> a\n\n## end\n\n## playbook outer\nid: o\nsession: own\n\n## end\n\n`;

  it('a track inside a track inside a branch is held to the branch share at every level', async () => {
    const h = m2harness('N1f');
    const run = mk(h, NEST, 2, { outer });
    await drive(run);
    expect(run.status).toBe('done');
    const all = h.subagentOpens.map((o) => [o.step, o.maxUsd]);
    const own = all.filter(([s]) => String(s).startsWith('o'));
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const [, cap] of own) expect(cap).toBe(1);
    await run.close();
  });

  it('a re-share of the inner track lifts every track above it, not only the one next to it', async () => {
    const h = m2harness('N1p');
    const inner = 'o/playbook-1#own';
    h.script(sub('N1p', inner), cut(1.0), done('r'));
    h.script(sub('N1p', 'b'), done('b', 0.1));
    const hi = h.hold(sub('N1p', inner));
    h.hold(sub('N1p', inner));   // the reopened session waits here
    const run = mk(h, FORK('o', 'b') + `## playbook outer\nid: o\nsession: own\n\n## end\n\n## phase b\nid: b\n> b\n\n## end\n\n`, 2, { outer });
    const driven = drive(run);
    await hi.started;
    await until(() => named(run, 'track_ended').some((e) => e.data.track === 'b'));
    hi.release();
    await sleep(100);
    expect(run.tracks.get(inner)!.share).toBeCloseTo(1.9, 6);   // 1.0 spent + 0.9 free
    expect(run.tracks.get('o#own')!.share).toBeCloseTo(1.9, 6);
    expect(run.tracks.get('o')!.share).toBeCloseTo(1.9, 6);
    await Promise.race([driven.catch(() => {}), sleep(1500)]);
    await run.close();
  });

  it('the inner track spending counts against the branch share, so a sibling room does not grow by it', async () => {
    const h = m2harness('N1g');
    const run = mk(h, NEST, 2, { outer });
    const innerId = () => h.subagentOpens.map((o) => o.step).find((s) => String(s).includes('/'));
    const d = drive(run);
    await until(() => innerId() !== undefined || run.status !== 'running');
    await d;
    const inner = innerId();
    expect(inner).toBeDefined();
    expect(opensOf(h, inner!)[0]!.maxUsd).toBe(1);
    await run.close();
  });
});

describe('N1: a snapshot taken mid-way keeps the shares', () => {
  it('the playbook tracks have their share in the snapshot, and the restored run caps the reopened session at the share left', async () => {
    const h = m2harness('N1h');
    h.script(sub('N1h', 'p1#own'), done('r', 0.4), done('FOUND', 0.1), { text: 'fine' });
    const hold = h.hold(sub('N1h', 'p1#own'));
    const hold2 = h.hold(sub('N1h', 'p1#own'));
    const run = mk(h, TWO, 2);
    const driven = drive(run);
    await hold.started;
    hold.release();
    await hold2.started;
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    const p1 = snap.tracks!.find((t) => t.key === 'p1#own')!;
    expect(p1.share).toBe(1);   // what the branch share had left when the playbook started
    hold2.release();
    await run.stop();
    await Promise.race([driven.catch(() => {}), sleep(2000)]);
    await run.close();
    const back = Run.restore(snap, { engine: h.engine, openSubagent: h.openSubagent, now: h.now, resolveBlock: resolver() });
    expect(back.tracks.get('p1#own')!.share).toBe(p1.share);
    expect(back.tracks.get('p1')!.share).toBe(snap.tracks!.find((t) => t.key === 'p1')!.share);
    await back.close();
  });
});
