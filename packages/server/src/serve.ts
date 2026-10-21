import path from 'node:path';
import type { EngineProbe } from '@reins/core';
import { createCatalog } from './catalog.js';
import type { LockInfo } from './lock.js';
import type { Mods } from './mods/types.js';
import { startServer } from './server.js';
import type { MakeEngine } from './session.js';
import type { Redactor } from './secrets.js';
import type { ConsentCheck } from './engines.js';
import { openStore, redactingStore } from './store.js';

export interface ServeOptions {
  home: string;
  /** The loaded mods (cli.ts loads them first: its `makeEngine` and `probe` go through them). */
  mods: Mods;
  port?: number;
  /** The engine factory, given the store's consent check (the store opens here, after cli.ts built its options). */
  makeEngine: (consent: ConsentCheck) => MakeEngine;
  probe: (provider: string) => Promise<EngineProbe>;
  out: (line: string) => void;
  err: (line: string) => void;
  stop: Promise<void>;
  appDir?: string;
  pickFolder?: (signal: AbortSignal) => Promise<string | null>;
  open?: (url: string) => void;
  /** The network fetch for the model catalog; none = the cached copy only, no network call. */
  fetch?: typeof fetch;
  /** The injected env (cli.ts `io.env`): the source of env keys to hide, and of what workflow commands get. None: this process's. */
  env?: NodeJS.ProcessEnv;
  /** The process's one Redactor (cli.ts makes it); serving makes no other. */
  redactor: Redactor;
}

/** `reins serve`: one server per machine (serve.lock), until `stop`. Returns the exit code. */
export async function runServe(o: ServeOptions): Promise<number> {
  const dir = path.join(o.home, '.reins');
  const env = o.env ?? process.env;
  const { redactor } = o;
  const store = redactingStore(openStore(path.join(dir, 'reins.db')), redactor);
  try {
    const server = await startServer({
      store, dir, mods: o.mods, env, redactor, makeEngine: o.makeEngine((id, origin) => store.hasConsent(id, origin)), probe: o.probe, lockFile: path.join(dir, 'serve.lock'),
      catalog: createCatalog({ file: path.join(dir, 'models-dev-cache.json'), ...(o.fetch ? { fetch: o.fetch } : {}) }),
      ...(o.port !== undefined ? { port: o.port } : {}),
      ...(o.appDir ? { appDir: o.appDir } : {}), ...(o.pickFolder ? { pickFolder: o.pickFolder } : {}),
    });
    o.out(server.url);
    if (o.open) {
      o.open(server.url);
      o.out('If the browser cannot open the page, paste the address above.');
    }
    await o.stop;
    await server.close();
    return 0;
  } catch (e) {
    const running = (e as { running?: LockInfo }).running;
    if (!running) throw e;
    const url = `http://127.0.0.1:${running.port}/#token=${running.token}`;
    o.out(url);
    if (o.open) {
      o.open(url);
      return 0;
    }
    o.err(`Reins is already serving (pid ${running.pid}). Open the address printed above.`);
    return 1;
  } finally {
    store.close();
  }
}
