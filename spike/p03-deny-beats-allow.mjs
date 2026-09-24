// P0.3: hook deny beats permissions.allow. argv[2]=deny-rule to try the permissions.deny alternative.
import { runGuard, hooksBlock } from './hook-server.mjs';
const alt = process.argv[2] === 'deny-rule';
const settings = alt
  ? { permissions: { allow: ['Edit', 'Write'], deny: ['Edit(migrations/**)', 'Write(migrations/**)'] } }
  : { hooks: hooksBlock(), permissions: { allow: ['Edit', 'Write'] } };
await runGuard(alt ? 'P0.3-denyrule' : 'P0.3', `claude-2.1.281-allow-vs-deny${alt ? '-denyrule' : ''}.jsonl`, settings, alt ? 'permissions.deny' : 'http');
process.exit(0);
