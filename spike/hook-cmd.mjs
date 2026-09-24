// Command-hook form of the guard: reads hook JSON on stdin, prints decision JSON.
import { appendFileSync } from 'node:fs';
let b = ''; process.stdin.on('data', (d) => { b += d; });
process.stdin.on('end', () => {
  const body = JSON.parse(b || '{}');
  appendFileSync(new URL('./tmp/hook-cmd.log', import.meta.url), body.hook_event_name + ' ' + (body.tool_input?.file_path ?? '') + '\n');
  const fp = String(body.tool_input?.file_path ?? '');
  if (body.hook_event_name === 'PreToolUse' && /migrations[\\/]/.test(fp)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Blocked by Reins: migrations/** is guarded.' } }));
  } else console.log('{}');
});
