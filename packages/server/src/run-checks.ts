import type { Workflow } from '@reins/core';
import { parseModel } from './models.js';
import { retiredProviders } from './mods/retired.js';
import { modelStepsOf } from './trust.js';

/** What the run-start checks need to know of one installed, enabled provider (built from its manifest and its key state, `engines.ts`). */
export interface ProviderFacts {
  id: string;
  label: string;
  conversation: 'own' | 'reins';
  /** `missing`: it needs a key and none is set. */
  key: 'set' | 'missing' | 'none';
  /** The env var names it reads its key from, for the words. */
  keyEnv: string[];
  defaultModel: string;
  /** What `model` is on this provider: whether it can call tools, which reasoning levels it takes, whether Reins can price it. */
  model(id: string): { tools: boolean; efforts: string[]; priced: boolean };
}

export interface CheckEnv {
  /** Whether `id` is an installed, enabled provider. */
  installed(id: string): boolean;
  /** None = not installed, or not known to this host (checks 2 to 6 skip it). */
  facts(id: string): ProviderFacts | undefined;
  /** Whether the provider's model list has the model; none = no list is known (the terminal). */
  listed?(provider: string, model: string): boolean;
}

export interface RunSession { provider: string; model?: string | undefined }

export const missingProviderWords = (id: string) => retiredProviders.includes(id)
  ? `This session uses ${id}, which no longer exists. Start a new session.`
  : `This session uses ${id}, which is not installed. Install it in Settings > Providers, or start a new session.`;

/** What the UI shows of a session's provider: `ok`, `missing` (not installed or disabled; installing fixes it) or `gone` (retired; only a new session helps). */
export type ProviderStatus = { status: 'ok' } | { status: 'missing' | 'gone'; words: string };

export const providerStatus = (id: string, installed: (id: string) => boolean): ProviderStatus =>
  installed(id) ? { status: 'ok' } : { status: retiredProviders.includes(id) ? 'gone' : 'missing', words: missingProviderWords(id) };
export const noKeyWords = (f: Pick<ProviderFacts, 'label' | 'keyEnv'>) =>
  `${f.label} has no key. ${f.keyEnv.length ? `Set ${f.keyEnv.join(' or ')}, or add` : 'Add'} a key in Settings > Providers.`;

/** One model a run would use: the session's own, or a step's, with the provider that step's name resolved to. */
interface Used { step?: string; switches?: boolean; provider: string; before: string; model: string; reasoning?: string }
interface Ctx { env: CheckEnv; w: Pick<Workflow, 'budget'>; used: Used[]; usd: string | undefined }
type Check = (c: Ctx) => string | undefined;

const withFacts = (c: Ctx, u: Used) => {
  const f = c.env.facts(u.provider);
  return f && u.model ? { f, m: f.model(u.model) } : undefined;
};
const firstWords = (c: Ctx, f: (u: Used, x: NonNullable<ReturnType<typeof withFacts>>) => string | undefined) => {
  for (const u of c.used) {
    const x = withFacts(c, u);
    const why = x && f(u, x);
    if (why) return why;
  }
  return undefined;
};

// 10.2, checks 2 to 6, in the order listed there. The first that fails is the only one said.
const key: Check = (c) => {
  for (const u of c.used) {
    const f = c.env.facts(u.provider);
    if (f?.key === 'missing') return noKeyWords(f);
  }
  return undefined;
};
const tools: Check = (c) => firstWords(c, (u, { m }) =>
  m.tools ? undefined : `${u.model} cannot call tools, so it cannot edit files or run commands. Pick a model with tools for workflows.`);
const effort: Check = (c) => firstWords(c, (u, { m }) => {
  if (u.reasoning === undefined || m.efforts.includes(u.reasoning)) return undefined;
  return m.efforts.length
    ? `Reasoning ${u.reasoning} in step \`${u.step}\` is not one of the levels of ${u.model}: ${m.efforts.join(', ')}.`
    : `${u.model} has no reasoning levels, so step \`${u.step}\` cannot set reasoning ${u.reasoning}.`;
});
// A provider that reports its own cost (conversation 'own') needs no price from Reins.
const price: Check = (c) => {
  const n = c.w.budget.usd ?? c.usd;
  if (n === undefined) return undefined;
  return firstWords(c, (u, { f, m }) =>
    f.conversation === 'reins' && !m.priced ? `${u.model} has no price, so Reins cannot hold the $${n} budget. Add a price in Settings > Providers, or remove the budget.` : undefined);
};
/** Spec 9.3: the words when a session cannot move between two providers because one of them keeps its own conversation; none when it can. */
export const crossWords = (from: Pick<ProviderFacts, 'label' | 'conversation'> | undefined, to: Pick<ProviderFacts, 'label' | 'conversation'> | undefined) =>
  from && to && from.conversation !== to.conversation
    ? `${from.label} keeps its own conversation, so Reins cannot move it to ${to.label}. Start a new session for ${to.label}.`
    : undefined;
const conversation: Check = (c) => {
  for (const u of c.used) {
    const why = u.switches ? crossWords(c.env.facts(u.before), c.env.facts(u.provider)) : undefined;
    if (why) return why;
  }
  return undefined;
};
const LATER: Check[] = [key, tools, effort, price, conversation];

/**
 * Check 1 (every model resolves to an installed provider, 9.2), which also works out who runs what.
 * ponytail: the models are followed in program order and a branch is not told apart, so a model block in a branch counts as always taken.
 */
function resolve(env: CheckEnv, session: RunSession, w: Workflow, resolveBlock: (name: string) => Workflow | undefined): { used: Used[]; usd: string | undefined } | { error: string } {
  if (!env.installed(session.provider)) return { error: missingProviderWords(session.provider) };
  let provider = session.provider;
  let model = session.model ?? env.facts(provider)?.defaultModel ?? '';
  const used: Used[] = [{ provider, before: provider, model }];
  let usd: string | undefined;
  for (const s of modelStepsOf(w, resolveBlock)) {
    usd ??= s.usd;
    if (s.model === undefined && s.reasoning === undefined) continue;
    const before = provider;
    let at = provider;
    let name = model;
    if (s.model !== undefined) {
      const p = parseModel(s.model, provider, env.installed, s.step);
      if ('error' in p) return p;
      if (p.provider === session.provider && p.model !== session.model && env.listed && !env.listed(p.provider, p.model)) {
        return { error: `Unknown model ${p.model} in step \`${s.step}\`: it is not in this session's provider list.` };
      }
      at = p.provider;
      name = p.model;
    }
    used.push({ step: s.step, switches: s.switches, provider: at, before, model: name, ...(s.reasoning !== undefined ? { reasoning: s.reasoning } : {}) });
    if (s.switches) { provider = at; model = name; }
  }
  return { used, usd };
}

/** The six checks of spec 10.2, before trust and spend: the words of the first that fails, or undefined when the run may start. */
export function runChecks(env: CheckEnv, session: RunSession, w: Workflow, resolveBlock: (name: string) => Workflow | undefined): string | undefined {
  const r = resolve(env, session, w, resolveBlock);
  if ('error' in r) return r.error;
  const c: Ctx = { env, w, ...r };
  for (const check of LATER) {
    const why = check(c);
    if (why) return why;
  }
  return undefined;
}

/**
 * The provider, model and reasoning a subagent opens with (spec 10.3): its step's `model` parsed, then checks 1 to 4 for that provider,
 * as they are when it opens (the provider may be gone or its key removed since the run started). A name-less subagent is on `base`.
 */
export function resolveSubagent(
  env: CheckEnv, base: { provider: string; model?: string | undefined; effort?: string | undefined }, o: { step: string; model?: string | undefined; reasoning?: string | undefined },
): { provider: string; model?: string; effort?: string } | { error: string } {
  const p = o.model ? parseModel(o.model, base.provider, env.installed, o.step) : { provider: base.provider };
  if ('error' in p) return p;
  if (!env.installed(p.provider)) return { error: missingProviderWords(p.provider) };
  const same = p.provider === base.provider;
  const model = 'model' in p ? p.model : same ? base.model : undefined;
  const level = o.reasoning ?? (same ? base.effort : undefined);
  const named = model ?? env.facts(p.provider)?.defaultModel ?? '';
  const c: Ctx = { env, w: { budget: { turns: 0, minutes: 0 } }, usd: undefined, used: [{ step: o.step, provider: p.provider, before: base.provider, model: named, ...(o.reasoning !== undefined ? { reasoning: o.reasoning } : {}) }] };
  for (const check of [key, tools, effort]) {
    const why = check(c);
    if (why) return { error: why };
  }
  return { provider: p.provider, ...(model ? { model } : {}), ...(level ? { effort: level } : {}) };
}
