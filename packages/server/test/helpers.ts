import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

export interface FakeTurn {
  fixture: string;
  turn?: number;
  approve?: boolean;
  text?: string;
  ignoreInterrupt?: boolean;
  delayMs?: number;
}

/** A temp project folder plus a fake-claude script; `log()` reads what the fake saw. */
export function fakeSetup(turns: FakeTurn[], delayMs = 10) {
  // realpath: the fake reports process.cwd(), which is the real path (macOS /var → /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-fake-')));
  const logFile = path.join(dir, '.fake-log.jsonl');
  const scriptFile = path.join(dir, '.fake-script.json');
  fs.writeFileSync(scriptFile, JSON.stringify({ log: logFile, delayMs, turns }));
  process.env.FAKE_CLAUDE_SCRIPT = scriptFile;
  return {
    dir,
    log: (): any[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(pred: () => boolean, ms = 10_000) {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
