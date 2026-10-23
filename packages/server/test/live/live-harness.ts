// The live checks harness (Milestone P, Task 29 live). The row files next to it run against a REAL provider (REINS_LIVE=1, keys from the
// REINS_LIVE_*_KEY variables) or, to prove the harness itself, against the scripted fake provider (REINS_LIVE_DRY=1). With neither set every
// row is skipped. The server is started the way production starts it (cli.ts): the real mods, one Redactor, the real send path. Nothing here
// ever prints, logs or writes a key: the evidence writer refuses a block that holds one.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { CATALOG_DIR, makeEngineFrom, probeFrom, redactEnvNames, startMods } from '../../src/engines.js';
import type { Question } from '../../src/drive.js';
import type { Mods } from '../../src/mods/types.js';
import { Redactor } from '../../src/secrets.js';
import { startServer, type Server } from '../../src/server.js';
import { openStore, redactingStore, type LogRow, type Store } from '../../src/store.js';
import { shellToolName } from '../../src/loop/tools.js';
import { startFakeProvider, type FakeReply } from '../fake-provider.js';
import { openQuestions, request, type Res } from '../http-helpers.js';

// ---- modes and skips

export type Mode = 'real' | 'dry' | 'off';
/** Dry wins when both are set: a run that might reach the network never starts by accident. */
export const MODE: Mode = process.env.REINS_LIVE_DRY === '1' ? 'dry' : process.env.REINS_LIVE === '1' ? 'real' : 'off';
/** Up to 10 minutes per row against a real provider; the scripted run is fast. */
export const LONG = MODE === 'real' ? 600_000 : 30_000;

export type Provider = 'anthropic' | 'openrouter' | 'gemini';
const token = (n: number) => randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, n);
/** The variable the key comes from, and the shape of the made-up key dry mode uses. */
export const PROVIDERS: Record<Provider, { keyVar: string; shape: () => string; wire: 'anthropic-messages' | 'openai-chat' }> = {
  anthropic: { keyVar: 'REINS_LIVE_ANTHROPIC_KEY', shape: () => `sk-ant-api03-${token(48)}`, wire: 'anthropic-messages' },
  openrouter: { keyVar: 'REINS_LIVE_OPENROUTER_KEY', shape: () => `sk-or-v1-${token(64)}`, wire: 'openai-chat' },
  gemini: { keyVar: 'REINS_LIVE_GEMINI_KEY', shape: () => `AIza${token(35)}`, wire: 'openai-chat' },
};

export interface Needs { key?: Provider; windows?: boolean }
/** Why a row does not run here, or undefined when it does. */
export function skipReason(o: Needs, mode: Mode = MODE, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (mode === 'off') return 'set REINS_LIVE=1 (real providers) or REINS_LIVE_DRY=1 (the scripted fake) to run the live checks';
  if (o.windows && process.platform !== 'win32') return 'this row is for Windows only';
  if (mode === 'real' && o.key && !env[PROVIDERS[o.key].keyVar]) return `${PROVIDERS[o.key].keyVar} is not set`;
  return undefined;
}
/** A describe that is skipped, with the reason as the name of its one skipped test, unless the row can run. */
export function liveSuite(title: string, needs: Needs, define: () => void): void {
  const why = skipReason(needs);
  if (why) describe(title, () => { it.skip(`skipped: ${why}`, () => {}); });
  else describe(title, define);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- money: the Budget's own count

export interface Price { input: number; output: number; cacheRead?: number; cacheWrite?: number }
/** What the Budget charges for a model with no price in the manifest: dearer than any model, so the count is never too small. */
export const FALLBACK_PRICE: Price = { input: 15, output: 75, cacheRead: 15, cacheWrite: 18.75 };
/** USD per million tokens, a cache price that is not given is the input price. Written here on purpose: not Reins's own function. */
export function costOf(u: { input: number; output: number; cacheRead: number; cacheWrite: number }, p: Price): number {
  return (u.input * p.input + u.output * p.output + u.cacheRead * (p.cacheRead ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}
/** Equal to the cent, and no further apart than a hundred-thousandth of a dollar (both sums come from the same tokens). */
export const sameCost = (a: number, b: number): boolean => Math.round(a * 100) === Math.round(b * 100) && Math.abs(a - b) < 1e-5;

export class BudgetExceeded extends Error {}
/** Adds up what the test has spent by its own count and throws before the next call once the limit is reached. */
export class Budget {
  private extra = 0;
  private readers: Array<() => number> = [];
  constructor(readonly limit = 1.0) {}
  add(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error('A cost added to the Budget must be a number of 0 or more.');
    this.extra += usd;
  }
  /** A source of cost counted afresh each time (the usage rows of the conversation files). */
  watch(read: () => number): void { this.readers.push(read); }
  get spent(): number { return this.extra + this.readers.reduce((a, f) => a + f(), 0); }
  /** Called before every call that could cost money. */
  check(): void {
    const spent = this.spent;
    if (!(spent < this.limit)) throw new BudgetExceeded(`The live Budget is used up: $${spent.toFixed(4)} counted, limit $${this.limit.toFixed(2)}. Nothing more was sent.`);
  }
}

// ---- the conversation file

export interface RawUsage { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; cost?: number }
export const conversationLines = (dir: string, engineSessionId: string): any[] => {
  const file = path.join(dir, 'conversations', `${engineSessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
};
export const rawUsage = (lines: any[]): RawUsage[] => lines.flatMap((l) => (l?.t === 'usage' ? [l] : l?.usage ? [l.usage] : [])) as RawUsage[];
const allConversations = (dir: string): string[] => {
  const d = path.join(dir, 'conversations');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)) : [];
};

// ---- the sweep

export interface SweepResult { files: number; unreadable: number; hits: Array<{ where: string; part: 'full' | 'tail' }> }
/** Scans every file under `dir` (links are not followed) and every extra text for the whole secret and for its last 8 characters. Never returns the secret. */
export function sweep(dir: string, secret: string, extra: Array<{ name: string; text: string }> = []): SweepResult {
  if (secret.length < 8) throw new Error('A secret to sweep for must be at least 8 characters.');
  const full = Buffer.from(secret);
  const tail = Buffer.from(secret.slice(-8));
  const out: SweepResult = { files: 0, unreadable: 0, hits: [] };
  const clean = (s: string) => s.split(secret).join('<secret>').split(secret.slice(-8)).join('<tail>');
  const look = (where: string, buf: Buffer) => {
    if (buf.includes(full)) out.hits.push({ where: clean(where), part: 'full' });
    if (buf.includes(tail)) out.hits.push({ where: clean(where), part: 'tail' });
  };
  const walk = (d: string) => {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { out.unreadable++; return; }
    for (const n of names) {
      const p = path.join(d, n);
      look(`${path.relative(dir, p)} (name)`, Buffer.from(n));
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { out.unreadable++; continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile()) continue;
      try { look(path.relative(dir, p), fs.readFileSync(p)); out.files++; } catch { out.unreadable++; }
    }
  };
  walk(dir);
  for (const e of extra) look(e.name, Buffer.from(e.text));
  return out;
}

// ---- the evidence

export interface Evidence {
  row: string; model: string; pass: boolean | 'inconclusive';
  counts?: Record<string, string | number | boolean>;
  cost?: number;
  notes?: string[];
  swept?: SweepResult;
}
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
/** Real runs append to the evidence file of the plan; dry runs have a file of their own, so a rehearsal never reads as evidence. */
export const evidenceFile = (mode: Mode = MODE): string =>
  process.env.REINS_LIVE_EVIDENCE ?? path.join(repoRoot, 'docs', 'plan', mode === 'real' ? 'p-real-checks.md' : 'p-real-checks-dry.md');
/** One block per row, appended. Refuses (throws, writes nothing) when the block holds a secret or its last 8 characters. */
export function record(e: Evidence, o: { secrets?: string[]; file?: string; mode?: Mode } = {}): string {
  const mode = o.mode ?? MODE;
  const lines = [
    `## Row ${e.row} | ${new Date().toISOString().slice(0, 10)} | ${mode} | ${e.model} | ${e.pass === true ? 'PASS' : e.pass === false ? 'FAIL' : 'INCONCLUSIVE'}`,
    ...(e.cost !== undefined ? [`- cost by the Budget's own count: $${e.cost.toFixed(4)}`] : []),
    ...(e.counts ? [`- counts: ${Object.entries(e.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`] : []),
    ...(e.swept ? [`- swept: ${e.swept.hits.length} hits (${e.swept.files} files${e.swept.unreadable ? `, ${e.swept.unreadable} unreadable` : ''})`] : []),
    ...(e.notes ?? []).map((n) => `- ${n}`),
  ];
  const block = `${lines.join('\n')}\n\n`;
  for (const s of o.secrets ?? []) {
    if (s.length >= 8 && (block.includes(s) || block.includes(s.slice(-8)))) throw new Error('The evidence block holds a key (or its last 8 characters), so it was not written.');
  }
  const file = o.file ?? evidenceFile(mode);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, block);
  return block;
}

// ---- off-task answers

/** Runs `first`; when the model did not do the task, `stricter` once. `onTask` false after both: the row is inconclusive (report the length only). */
export async function twice<T extends { onTask: boolean }>(first: () => Promise<T>, stricter: () => Promise<T>): Promise<{ result: T; tries: number }> {
  const a = await first();
  if (a.onTask) return { result: a, tries: 1 };
  return { result: await stricter(), tries: 2 };
}

// ---- the world

export type Handler = (q: Question, rows: LogRow[]) => string | undefined;
/**
 * Say yes to a tool question, a folder trust question and a judge, approve a gate, and STOP at any other pause (a budget, a blocked agent, a
 * USD limit), so a run that goes somewhere unplanned ends instead of waiting for the timeout. A row that wants a pause answers it itself.
 */
export const allowAll: Handler = (q) => (q.kind === 'tool' || q.kind === 'trust' || q.kind === 'judge' ? 'y' : q.kind === 'gate' ? 'approve' : q.kind === 'switch' ? 'n' : 'stop');

export interface Outcome { ended: boolean; failed?: string; text: string; cost?: number; unknown?: boolean; rows: LogRow[]; seen: Question[] }

export interface WorldOptions {
  provider: Provider;
  model: string;
  /** Edits the test-local copy of the manifest (an effort level, a price, the models). */
  edit?: (m: Record<string, any>) => void;
  /** More copies of the manifest under other ids, each with its own key variable and key (row 6a: a wrong key). */
  copies?: Array<{ id: string; keyVar: string; key: string; edit?: (m: Record<string, any>) => void }>;
  /** Another env var of the server that holds the same key under a name no manifest lists (an alias): it must not reach a child either. */
  alias?: string;
  /** Settings of the store, such as { maxCallsPerTurn: 8 }. */
  settings?: Record<string, unknown>;
  /** Dry mode: the ids the fake's model list answers with. */
  list?: string[];
  budget?: number;
  /** The provider's catalog manifest has no price for this model: the test-local copy gets this one (so the Budget and the cost rows can work). */
  assumePrice?: Price;
  /** Runs once the folders exist and before the mods load: a test writes a mod of its own into <dir>/mods (and its trust) here. */
  prepare?: (c: { root: string; dir: string; proj: string; userHome: string }) => void;
}

const ASSUMED: Price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export interface World {
  mode: Mode;
  provider: Provider;
  model: string;
  keyVar: string;
  key: string;
  fake?: Awaited<ReturnType<typeof startFakeProvider>>;
  root: string; dir: string; proj: string; userHome: string;
  env: NodeJS.ProcessEnv;
  srv: Server; store: Store; mods: Mods; redactor: Redactor;
  manifest: Record<string, any>;
  budget: Budget;
  stdout: string[]; stderr: string[];
  api(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Res>;
  /** The yes of the user through the real consent route, for the provider's current address. */
  consent(id?: string): Promise<void>;
  session(extra?: Record<string, unknown>): Promise<string>;
  rows(id: string, type?: string): LogRow[];
  /** Dry mode: queues scripted replies on the fake; real mode: does nothing. */
  script(...r: FakeReply[]): void;
  /** Sends a message and answers the questions with `handler` until the turn has ended. Throws BudgetExceeded before a send that would pass the limit. */
  say(id: string, text: string, handler?: Handler, ms?: number): Promise<Outcome>;
  /** Only the send: the log position to wait from. Throws BudgetExceeded before a send that would pass the limit. */
  send(id: string, text: string): Promise<number>;
  /** Waits (answering with `handler`) until the turn that began after `mark` has ended or failed and the session is settled. */
  settle(id: string, mark: number, handler?: Handler, ms?: number): Promise<Outcome>;
  /** Answers questions with `handler` until `done` is true. */
  pump(id: string, done: () => boolean, handler?: Handler, ms?: number): Promise<Question[]>;
  stop(id: string): Promise<Res>;
  /** Writes a workflow file in the project, runs it through the run API, answers with `handler` until the run ends (finished, stopped or detached). */
  workflow(id: string, name: string, body: string, handler?: Handler, ms?: number): Promise<{ rid: string; rows: LogRow[]; receipt?: any; seen: Question[] }>;
  usage(id: string): RawUsage[];
  /** The Budget's own price for a model: the manifest's, else the fallback. */
  priceOf(model: string): Price;
  /** The text with every key of this world, and its last 8 characters, replaced: for a value an assertion may print. */
  scrub(text: string): string;
  /** Words saying where the price of a model came from (the manifest, or assumed by this harness), or that there is none. */
  priceNote(model: string): string;
  sweepAll(): SweepResult;
  evidence(e: Omit<Evidence, 'model' | 'swept' | 'cost'> & { model?: string; swept?: boolean }): string;
  close(): Promise<void>;
}

const readCatalog = (id: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, id, 'mod.json'), 'utf8'));
export const catalogIds = (id: string): string[] => (readCatalog(id).models as Array<{ id: string }>).map((m) => m.id);

/** Every stdout and stderr write of this process, kept until `restore`. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const wrap = (sink: string[], real: typeof process.stdout.write) => ((chunk: any, ...rest: any[]) => { sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); return (real as any)(chunk, ...rest); }) as typeof process.stdout.write;
  process.stdout.write = wrap(out, o);
  process.stderr.write = wrap(err, e);
  return { out, err, restore: () => { process.stdout.write = o; process.stderr.write = e; } };
}

/** The raw bytes of /api/stream, kept for the sweep. */
function listen(srv: { port: number; token: string }) {
  let raw = '';
  const req = http.request({ host: '127.0.0.1', port: srv.port, path: `/api/stream?token=${srv.token}`, agent: false });
  req.on('error', () => {});
  req.on('response', (res) => { res.setEncoding('utf8'); res.on('error', () => {}); res.on('data', (d: string) => { raw += d; }); });
  req.end();
  return { raw: () => raw, close: () => req.destroy() };
}

/** The manifest of a provider as this test installs it: the catalog's copy, its key variable renamed, in dry mode its address the fake's. */
function localManifest(o: { provider: Provider; id: string; keyVar: string; fakeUrl?: string; model: string; assumePrice: Price; edit?: (m: Record<string, any>) => void }): Record<string, any> {
  const m = readCatalog(o.provider);
  m.id = o.id;
  m.auth = { ...m.auth, keyEnv: [o.keyVar] };
  delete m.catalog;
  if (o.fakeUrl) m.baseUrl = PROVIDERS[o.provider].wire === 'anthropic-messages' ? o.fakeUrl : `${o.fakeUrl}/v1`;
  // A model of the row that the manifest lists with no price gets the assumed one (the Budget and the cost row need a price); an unlisted model is left as Reins finds it.
  for (const x of m.models as Array<{ id: string; price?: Price }>) if (x.id === o.model && !x.price) x.price = o.assumePrice;
  o.edit?.(m);
  return m;
}

export async function startWorld(o: WorldOptions): Promise<World> {
  const mode = MODE;
  if (mode === 'off') throw new Error('The live world starts only with REINS_LIVE=1 or REINS_LIVE_DRY=1.');
  const spec = PROVIDERS[o.provider];
  const key = mode === 'real' ? process.env[spec.keyVar] ?? '' : spec.shape();
  if (!key) throw new Error(`${spec.keyVar} is not set.`);
  const fake = mode === 'dry' ? await startFakeProvider({ strictPairs: true }) : undefined;
  if (fake && o.list) fake.list.data = o.list.map((id) => ({ id, object: 'model' }));

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-live-')));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  const userHome = path.join(root, 'home');
  const emptyCatalog = path.join(root, 'no-catalog');
  for (const d of [dir, proj, userHome, emptyCatalog]) fs.mkdirSync(d, { recursive: true });

  // The env the server and its children start from: this process's, without any REINS_* and without anything that looks like a secret of the
  // user's, plus the key of this row (and of its copies) under the names the manifests give.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^REINS_/i.test(k) && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) env[k] = v;
  env[spec.keyVar] = key;
  if (o.alias) env[o.alias] = key;
  for (const c of o.copies ?? []) env[c.keyVar] = c.key;

  const install = (id: string, m: Record<string, any>) => {
    const folder = path.join(dir, 'mods', id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify(m, null, 2));
  };
  const assumePrice = o.assumePrice ?? ASSUMED;
  const manifest = localManifest({ provider: o.provider, id: o.provider, keyVar: spec.keyVar, ...(fake ? { fakeUrl: fake.url } : {}), model: o.model, assumePrice, ...(o.edit ? { edit: o.edit } : {}) });
  install(o.provider, manifest);
  for (const c of o.copies ?? []) install(c.id, localManifest({ provider: o.provider, id: c.id, keyVar: c.keyVar, ...(fake ? { fakeUrl: fake.url } : {}), model: o.model, assumePrice, ...(c.edit ? { edit: c.edit } : {}) }));

  o.prepare?.({ root, dir, proj, userHome });

  const seen = capture();
  // Built as cli.ts builds it: the mods first, then the one Redactor, then the store behind it, then the engine factory and the probe.
  const mods = await startMods({ dir, env });
  const problems = mods.mods.filter((m) => m.source === 'user').flatMap((m) => m.problems);
  if (problems.length) throw new Error(`The test-local manifest was not accepted: ${problems.join(' ')}`);
  const redactor = new Redactor({ home: dir, env, keyEnvNames: () => redactEnvNames(mods) });
  const store = redactingStore(openStore(path.join(dir, 'reins.db')), redactor);
  for (const [k, v] of Object.entries(o.settings ?? {})) store.putSetting(k, v);
  const host = { env, home: dir };
  const srv = await startServer({
    store, dir, mods, env, redactor, catalogDir: emptyCatalog, userHome,
    makeEngine: makeEngineFrom(mods, host, (id, origin) => store.hasConsent(id, origin), redactor),
    // The server probes every provider it starts with. The built-in command-line one is not under test and its probe waits for a program that may
    // not be installed, so only the providers of this world are probed.
    probe: (provider) => (provider === o.provider || (o.copies ?? []).some((c) => c.id === provider)
      ? probeFrom(mods, provider, host, redactor)
      : Promise.resolve({ installed: false, loggedIn: false, capabilities: { midTurnSteer: 'none' as const, preToolDeny: false, resume: false }, problems: ['not probed by the live harness'] })),
  });
  const stream = listen(srv);

  const bodies: string[] = [];
  const api: World['api'] = async (method, url, body) => {
    const r = await request(srv, method, url, body === undefined ? {} : { body });
    bodies.push(r.text);
    return r;
  };

  const catalogPriced = (readCatalog(o.provider).models as Array<{ id: string; price?: Price }>).find((x) => x.id === o.model)?.price !== undefined;
  const priceNote = (model: string): string => {
    const row = (manifest.models as Array<{ id: string; price?: Price }>).find((x) => x.id === model);
    const price = row?.price ?? manifest.price;
    if (!price) return `${model}: no price in the manifest (Reins counts the cost as unknown; the Budget charges ${JSON.stringify(FALLBACK_PRICE)} per million)`;
    return `${model}: ${JSON.stringify(price)} USD per million, ${model === o.model && !catalogPriced && !o.edit ? 'ASSUMED by this harness (the catalog manifest has no price for it)' : 'from the manifest'}`;
  };
  const priceOf = (model: string): Price => {
    const row = (manifest.models as Array<{ id: string; price?: Price }>).find((x) => x.id === model);
    return row?.price && row.price.output !== undefined ? row.price : manifest.price ?? FALLBACK_PRICE;
  };
  const budget = new Budget(o.budget ?? 1.0);
  // Its own count: the raw token counts of every usage row of every conversation file, at the manifest price (never Reins's own cost field).
  budget.watch(() => allConversations(dir).reduce((a, id) => a + rawUsage(conversationLines(dir, id)).reduce((b, u) => b + costOf(u, priceOf(u.model)), 0), 0));

  const rows: World['rows'] = (id, type) => store.readLog(id).filter((r) => !type || r.type === type);
  const lastSeq = (id: string) => store.readLog(id).at(-1)?.seq ?? 0;

  const outcomeAfter = (id: string, mark: number): Outcome | undefined => {
    const after = store.readLog(id).filter((r) => r.seq > mark);
    const end = after.findIndex((r) => r.type === 'turn_ended' || r.type === 'turn_failed');
    if (end < 0 || !after.slice(end).some((r) => r.type === 'status')) return undefined;
    const failed = after.find((r) => r.type === 'turn_failed');
    const ended = after.filter((r) => r.type === 'turn_ended');
    const last = ended.at(-1)?.data as { text?: string; cost?: number; unknown?: boolean } | undefined;
    return {
      ended: ended.length > 0, ...(failed ? { failed: String((failed.data as { error?: unknown }).error) } : {}), text: last?.text ?? '',
      ...(last?.cost !== undefined ? { cost: last.cost } : {}), ...(last?.unknown ? { unknown: true } : {}), rows: after, seen: [],
    };
  };

  const stop: World['stop'] = (id) => api('POST', `/api/sessions/${id}/card`, { text: '', kind: 'stop' });
  // A wait on one session: 4 minutes against a real provider, 20 seconds against the fake. A row's own timeout is longer and covers several waits.
  const pump: World['pump'] = async (id, done, handler = allowAll, ms = mode === 'real' ? 240_000 : 20_000) => {
    const answered = new Set<string>();
    const asked: Question[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const all = store.readLog(id);
      for (const q of openQuestions(all)) {
        if (answered.has(q.id)) continue;
        const a = handler(q, all);
        if (a === undefined) continue;
        answered.add(q.id);
        asked.push(q);
        await api('POST', `/api/sessions/${id}/answer`, { questionId: q.id, answer: a });
      }
      for (const q of openQuestions(all)) if (!asked.some((x) => x.id === q.id) && !answered.has(q.id)) asked.push(q);
      if (done()) return asked;
      try {
        budget.check();
      } catch (e) {
        await stop(id).catch(() => {});
        throw e;
      }
      if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting on session ${id}.`);
      await sleep(mode === 'dry' ? 15 : 300);
    }
  };

  const send: World['send'] = async (id, text) => {
    budget.check();
    const mark = lastSeq(id);
    const r = await api('POST', `/api/sessions/${id}/message`, { text });
    if (r.status !== 200) throw new Error(`POST message: ${r.status} ${r.text.slice(0, 300)}`);
    return mark;
  };
  const settle: World['settle'] = async (id, mark, handler, ms) => {
    const asked = await pump(id, () => outcomeAfter(id, mark) !== undefined, handler, ms);
    return { ...outcomeAfter(id, mark)!, seen: asked };
  };
  const say: World['say'] = async (id, text, handler, ms) => settle(id, await send(id, text), handler, ms);

  const workflow: World['workflow'] = async (id, name, body, handler, ms) => {
    budget.check();
    const file = path.join(proj, `${name}.reins.md`);
    fs.writeFileSync(file, body);
    const mark = lastSeq(id);
    const r = await api('POST', `/api/sessions/${id}/run`, { path: file });
    if (r.status !== 200) throw new Error(`POST run: ${r.status} ${r.text.slice(0, 300)}`);
    // The receipt row is logged right after the run's last row.
    const ends = () => {
      const now = store.readLog(id).filter((x) => x.seq > mark);
      return now.some((x) => x.type === 'run_detached') || (now.some((x) => x.type === 'run_finished' || x.type === 'run_stopped') && now.some((x) => x.type === 'receipt'));
    };
    const asked = await pump(id, ends, handler, ms);
    const after = store.readLog(id).filter((x) => x.seq > mark);
    const rid = after.find((x) => x.runId)?.runId ?? '';
    return { rid, rows: after, receipt: after.find((x) => x.type === 'receipt')?.data, seen: asked };
  };

  const sweepAll: World['sweepAll'] = () => {
    const extra = [
      { name: 'sse stream', text: stream.raw() },
      { name: 'api replies', text: bodies.join('\n') },
      { name: 'server stdout', text: seen.out.join('') },
      { name: 'server stderr', text: seen.err.join('') },
    ];
    const keys = [key, ...(o.copies ?? []).map((c) => c.key)];
    const results = keys.map((k) => sweep(root, k, extra));
    return { files: results[0]!.files, unreadable: results[0]!.unreadable, hits: results.flatMap((r) => r.hits) };
  };

  return {
    mode, provider: o.provider, model: o.model, keyVar: spec.keyVar, key, ...(fake ? { fake } : {}), root, dir, proj, userHome, env, srv, store, mods, redactor, manifest, budget,
    stdout: seen.out, stderr: seen.err,
    api,
    async consent(id = o.provider) {
      const origin = new URL(id === o.provider ? manifest.baseUrl : (mods.mods.find((m) => m.id === id)?.manifest as { baseUrl: string }).baseUrl).origin;
      const r = await api('POST', `/api/mods/${id}/consent`, { origin });
      if (r.status !== 200) throw new Error(`consent: ${r.status} ${r.text.slice(0, 300)}`);
    },
    async session(extra = {}) {
      const r = await api('POST', '/api/sessions', { cwd: proj, engine: o.provider, model: o.model, ...extra });
      if (r.status !== 200) throw new Error(`POST /api/sessions: ${r.status} ${r.text.slice(0, 300)}`);
      return r.json.id as string;
    },
    rows,
    script: (...r) => { fake?.push(...r); },
    say, send, settle, pump, stop, workflow,
    usage: (id) => {
      const engineId = store.getSession(id)?.engineSessionId;
      return engineId ? rawUsage(conversationLines(dir, engineId)) : [];
    },
    priceOf, priceNote,
    scrub: (text) => [key, ...(o.copies ?? []).map((c) => c.key)].reduce((t, k) => t.split(k).join('<key>').split(k.slice(-8)).join('<tail>'), text),
    sweepAll,
    evidence(e) {
      const { swept: wanted, ...rest } = e;
      const swept = wanted === false ? undefined : sweepAll();
      return record({ ...rest, model: e.model ?? o.model, cost: budget.spent, ...(swept ? { swept } : {}) },{ secrets: [key, ...(o.copies ?? []).map((c) => c.key)] });
    },
    async close() {
      stream.close();
      await srv.close();
      store.close();
      mods.dispose();
      await fake?.close();
      seen.restore();
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS temp cleaner */ }
    },
  };
}

// ---- small helpers the rows share

/** The name of the shell tool on this machine (PowerShell on Windows, Bash elsewhere). */
export const SHELL = shellToolName(process.platform);
/** A scripted reply that calls a tool. */
export const call = (name: string, input: Record<string, unknown>, id?: string): FakeReply => ({ toolCalls: [{ ...(id ? { id } : {}), name, args: JSON.stringify(input) }] });
/** The messages-wire usage of one scripted reply. */
export const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Record<string, unknown> => ({
  input_tokens: input, output_tokens: output, ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}), ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
});
/** The chat-wire usage of one scripted reply. */
export const chatTokens = (input: number, output: number, cached = 0): Record<string, unknown> => ({
  prompt_tokens: input, completion_tokens: output, total_tokens: input + output, ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
});
/** The requests the fake saw on its chat route (dry mode). */
export const chatRequests = (w: World) => (w.fake?.requests ?? []).filter((r) => /\/(messages|chat\/completions)$/.test(r.path));
/** Dry mode: how many requests carried the key in the header the wire uses. Real mode: undefined (nothing to look at). */
export function keySent(w: World): number | undefined {
  if (!w.fake) return undefined;
  const header = PROVIDERS[w.provider].wire === 'anthropic-messages' ? (h: Record<string, string>) => h['x-api-key'] === w.key : (h: Record<string, string>) => h.authorization === `Bearer ${w.key}`;
  return chatRequests(w).filter((r) => header(r.headers)).length;
}
/** The tool results and calls the engine showed in the log, in order. */
export const toolResults = (rows: LogRow[]): Array<{ tool: string; text: string }> =>
  rows.flatMap((r) => (r.type === 'engine' && (r.data as { type?: string }).type === 'tool_result' ? [{ tool: String((r.data as any).tool), text: String((r.data as any).output ?? '') }] : []));
export const toolCalls = (rows: LogRow[]): Array<{ tool: string; input: any }> =>
  rows.flatMap((r) => (r.type === 'engine' && (r.data as { type?: string }).type === 'tool_call' ? [{ tool: String((r.data as any).tool), input: (r.data as any).input }] : []));
/** The assistant lines of a conversation file whose blocks are of `kind` (the file's own names: reasoning, tool_call, text). */
export const blocksOf = (lines: any[], kind: string): any[] => lines.flatMap((l) => (l?.t === 'msg' && l.role === 'assistant' ? (l.blocks as any[]).filter((b) => b?.type === kind) : []));
/** A shell result is the output and then a line `exit N`. */
export const shellOutput = (text: string): string => text.replace(/\r?\n?exit \S+\s*$/, '').trim();
/** The env var is hidden when its command printed nothing, or only the redaction marker. */
export const hiddenOutput = (text: string): boolean => shellOutput(text) === '' || /^\[key [^\]]*\]$/.test(shellOutput(text));
/** Text of a log row's data as one string (for a look through the rows). */
export const asText = (rows: LogRow[]) => JSON.stringify(rows.map((r) => r.data));
