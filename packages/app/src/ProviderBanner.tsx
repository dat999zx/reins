import type { EngineProbe } from '@reins/core';

export type Engines = Array<{ id: string } & EngineProbe>;

/** The selected session's provider problems (spec 9.5): nothing when no session is selected or its provider is fine. */
export function ProviderBanner({ engines, engine }: { engines: Engines; engine: string | undefined }) {
  const p = engine === undefined ? undefined : engines.find((e) => e.id === engine);
  if (!p || (p.installed && p.loggedIn)) return null;
  return <div className="banner bad" role="alert">{p.problems.join(' ') || 'The engine is not ready.'}</div>;
}
