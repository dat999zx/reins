// P0.2: PreToolUse HTTP hook blocks an edit. Optional argv[2]=command for the command-hook form.
import { runGuard, hooksBlock } from './hook-server.mjs';
const type = process.argv[2] === 'command' ? 'command' : 'http';
await runGuard(type === 'http' ? 'P0.2' : 'P0.2-cmd', `claude-2.1.281-hook-deny${type === 'http' ? '' : '-cmd'}.jsonl`,
  { hooks: hooksBlock(undefined, type) }, type);
process.exit(0);
