import path from 'node:path';
import type { EngineProbe } from '@reins/core';
import type { LockInfo } from './lock.js';
import { startServer } from './server.js';
import type { MakeEngine } from './session.js';
import { openStore } from './store.js';

export interface ServeOptions {
  home: string;
  port?: number;
  makeEngine: MakeEngine;
  probe: () => Promise<EngineProbe>;
  out: (line: string) => void;
  err: (line: string) => void;
  stop: Promise<void>;
}

/** `reins serve`: one server per machine (serve.lock), until `stop`. Returns the exit code. */
export async function runServe(o: ServeOptions): Promise<number> {
  const dir = path.join(o.home, '.reins');
  const store = openStore(path.join(dir, 'reins.db'));
  try {
    const server = await startServer({
      store, dir, makeEngine: o.makeEngine, probe: o.probe, lockFile: path.join(dir, 'serve.lock'),
      ...(o.port !== undefined ? { port: o.port } : {}),
    });
    o.out(server.url);
    await o.stop;
    await server.close();
    return 0;
  } catch (e) {
    const running = (e as { running?: LockInfo }).running;
    if (!running) throw e;
    o.out(`http://127.0.0.1:${running.port}/#token=${running.token}`);
    o.err(`Reins is already serving (pid ${running.pid}). Open the address printed above.`);
    return 1;
  } finally {
    store.close();
  }
}
