import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Files claude -p runs with no prompt: their hooks, MCP servers, apiKeyHelper and permissions.allow (plan 15d 3b.4).
const FOLDER_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
export const FOLDER_PATH = '.claude/';

export function folderHash(cwd: string): { hash: string; detail: string } | undefined {
  const found = FOLDER_FILES.flatMap((f) => {
    try {
      return [{ f, text: fs.readFileSync(path.join(cwd, f), 'utf8') }];
    } catch {
      return [];
    }
  });
  if (!found.length) return undefined;
  const h = createHash('sha256');
  for (const x of found) h.update(`${x.f}\0${x.text.length}\0${x.text}\0`); // the length keeps file boundaries
  return { hash: h.digest('hex'), detail: found.map((x) => `${x.f}\n${x.text.slice(0, 4096)}`).join('\n\n') };
}
