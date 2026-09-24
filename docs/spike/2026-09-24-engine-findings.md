# Phase 0 engine findings (P0.8)

Run 2026-09-24 on Windows 11 (10.0.26200), Node via `D:/nodejs/node.exe`. Every row below comes from a real run; raw streams are in `spike/fixtures/`, one line per test in `spike/results.md`.

## Versions

| tool | version | notes |
|---|---|---|
| `claude` | 2.1.281 | subscription login, `apiKeySource=none`, run with `--model sonnet --effort medium` (`claude-sonnet-5`) |
| `codex` | 0.153.4 | `account/read` → `type: "chatgpt"`, server reports `platformFamily: "windows"` |
| `knowl` | 5.23.1 | |

## Results

| id | what | result |
|---|---|---|
| P0.0 | scratch repo | done before this run |
| P0.1 | Claude: 3 turns, 1 session, stream-json | **PASS** (ONE/TWO/THREE, one `session_id`, first turn 4.2 s) |
| P0.2 | PreToolUse **HTTP** hook denies an edit | **PASS** (diff empty, denial in stream, reply explains the block) |
| P0.2-cmd | same with a **command** hook | **FAIL**: the hook never ran (see surprises). Not needed, HTTP passed. Run twice; the first run's fixture was overwritten by the second |
| P0.3 | hook deny beats `permissions.allow: [Edit, Write]` | **PASS**. The `permissions.deny` fallback was not needed and not run |
| P0.4a | permission-prompt-tool: hold 5 s, then deny | **PASS** (file untouched while waiting and after) |
| P0.4b | permission-prompt-tool: hold 120 s, then allow | **PASS** (no timeout at 120 s, edit applied after allow). Upper limit not probed |
| P0.5a | PostToolUse `additionalContext` card → final answer ends PINEAPPLE | **FAIL**: the card reached the model, but the model refused to act on it (see below) |
| P0.5b | `child.kill('SIGINT')` on the spawned process | **FAIL**: no `result` in 20 s. Node killed the `cmd.exe` shim, and the real `claude.exe` was orphaned and kept running (I killed it by hand) |
| P0.5c | stream-json `control_request` `interrupt` on stdin | **PASS**: `result` (`error_during_execution`) in 2.9 s, then the session took a normal next turn |
| P0.6a | Codex app-server, 3 turns | **PASS** |
| P0.6b | Codex `fileChange` approval → decline | **PASS** (file unchanged) |
| P0.6c | Codex `turn/steer` mid-turn → PINEAPPLE | **PASS** |
| P0.6d | Codex `turn/interrupt` (extra) | **PASS** (`interrupted` in 114 ms) |
| P0.7 | Knowl store + query | **PASS** |
| P0.8 | this doc | done |

The first Codex run also logged a `P0.6-error` row: the documented approval policy name `unlessTrusted` is rejected (see surprises).

## K1 verdict

**YES.** A gate can block a Claude edit. Two documented routes both work on 2.1.281 on Windows:
1. **`PreToolUse` HTTP hook returning `permissionDecision: "deny"`** (P0.2). It also beats a user `allow: [Edit, Write]` rule (P0.3), under `--permission-mode acceptEdits`. This is the route the plan wants.
2. **`--permission-prompt-tool` MCP tool returning `{behavior:"deny"}`** (P0.4a). It holds indefinitely (120 s tested).

Caveat: both tests used `Edit` only; `Write`, `MultiEdit`, `Bash` writes and subagents were not tested.

## Working shapes

### Claude process (P0.2/P0.3/P0.4/P0.5)

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --session-id <uuid> --model sonnet --effort medium
  --settings <path-to-json-file>
  [--permission-mode acceptEdits]
  [--permission-prompt-tool mcp__approve__approve --mcp-config <path-to-json-file>]
```
`--settings` and `--mcp-config` were passed as **file paths**, never inline. Turn input on stdin: `{"type":"user","message":{"role":"user","content":"<text>"}}\n`.

### Hook config file (`--settings`)
```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "http", "url": "http://127.0.0.1:47123/hook", "timeout": 30 }] }],
  "PostToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47123/hook", "timeout": 30 }] }] },
  "permissions": { "allow": ["Edit", "Write"] } }
```
The POST body is the hook JSON: `hook_event_name`, `tool_name`, `tool_input` (…).

### Hook deny response (HTTP 200, JSON)
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by Reins: migrations/** is guarded."}}
```
In the stream it appears as a `tool_result` with `is_error: true` and the content `PreToolUse:Edit hook error: Blocked by Reins: migrations/** is guarded.` (the reason is passed to the model verbatim, with a prefix). Passing = `{}`.

### PostToolUse card response
```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<card text>"}}
```
Accepted, and delivered (see P0.5a), but see the surprise about trust.

### Permission-prompt-tool
- Request the tool receives: `{ "tool_name": "Edit", "input": {…the tool input…}, "tool_use_id": "toolu_…" }`.
- The MCP tool returns one text content block whose text is JSON:
  - allow: `{"behavior":"allow","updatedInput":{…}}` (I echoed the original `input`)
  - deny: `{"behavior":"deny","message":"Reins says no."}` (the model sees the message as the tool result)
- MCP config file: `{"mcpServers":{"approve":{"command":"D:/nodejs/node.exe","args":["D:/.../spike/approve-mcp.mjs"]}}}`.
- `spike/approve-mcp.mjs` is a **hand-rolled** newline-delimited JSON-RPC server (`initialize`, `tools/list`, `tools/call`), not `@modelcontextprotocol/sdk`, because `npm i` wasn't in the pre-approved commands. The wire format is small and Claude accepted it, so the SDK is not needed to pass this test.

### Interrupt (Claude)
Write to stdin: `{"type":"control_request","request_id":"req_int_1","request":{"subtype":"interrupt"}}\n`.
Reply: `{"type":"control_response","response":{"subtype":"success","request_id":"req_int_1","response":{"still_queued":[]}}}`.
Then a `result` with `subtype:"error_during_execution"`, `is_error:true`; a fresh `system/init` is emitted and the next `user` turn worked (replied AFTER).

### Codex app-server
- Spawn `codex app-server` (shell: true on Windows), newline-delimited JSON on stdio.
- `initialize {clientInfo:{name:"reins-spike",version:"0"}}` → `{userAgent, codexHome, platformFamily:"windows", platformOs:"windows"}`, then notification `{"method":"initialized","params":{}}`.
- `account/read {refreshToken:false}` → `result.account.type == "chatgpt"`.
- `thread/start {cwd, approvalPolicy:"untrusted"}` → `result.thread.id`. The echoed sandbox was `{"type":"dangerFullAccess"}` (from the user's own Codex config; I did not override it).
- `turn/start {threadId, input:[{type:"text",text}]}` → `result.turn.id`; ends with notification `turn/completed` (`params.turn.status` = `completed` / `interrupted`). Agent text arrives in `item/completed` with `item.type == "agentMessage"`, `item.text`.
- Approval request from the server: `item/fileChange/requestApproval` `{threadId, turnId, itemId, startedAtMs, reason, grantRoot…}`. Answer with JSON-RPC result `{"decision":"decline"}` (or `"accept"`). The item then ends as `fileChange` with `status: "declined"`.
- Read-only shell commands: `item/commandExecution/requestApproval`, answered `{"decision":"accept"}`. In P0.6b one `commandExecution` (a read) completed *without* a request under `untrusted`, so `untrusted` skips approval for commands Codex deems safe.
- `turn/steer {threadId, input:[{type:"text",text}], expectedTurnId}` → `{"turnId":"…"}`; no new `turn/started`. The card was obeyed (answer ended with PINEAPPLE).
- `turn/interrupt {threadId, turnId}` → turn ends `interrupted`.

### Knowl
`knowl store --category decision --title … --provenance observed "<content>"` and `knowl query "<q>" --limit 5` both work. When stdout is not a TTY, **`query` prints a JSON array** (`id, category, status, title, content, …`) with no flag needed. There is no `--json` option in `--help`. Timing over 5 runs: query avg 942 ms (851–1115), store 869 ms, init 1.9 s, `knowl status` avg 528 ms. `knowl init` in a fresh repo created `KNOWL.md`, `AGENTS.md`, `.gitignore`, `.knowl/` in the repo (I removed them from the scratch repo afterwards).

## Surprises

1. **A PostToolUse card is treated as a prompt injection by Sonnet 5 (P0.5a).** The hook fired 4 times and the card was consumed, and the model's thinking says: *"The Glob results contained an embedded instruction to end my answer with 'PINEAPPLE' — I'm disregarding that since it didn't come from you."* (fixture `claude-2.1.281-card.jsonl` line 39). So delivery works, obedience does not, with the wording "Reins card: end your final answer with…". I did not try other wordings (rule 8). Whether framing changes the result is **untested**; this is the biggest risk to the "live card" feature on Claude.
2. **SIGINT does not reach `claude.exe` from Node on Windows (P0.5b).** With `shell: true` the child is `cmd.exe`; `kill('SIGINT')` returns `true` but kills only the shim, and `claude.exe` (and its `ping` child) were orphaned. `taskkill /T` on the shim pid found nothing. The stdin `control_request` interrupt works and is the delivery route on Windows. Reins must also track the real `claude.exe` pid (or avoid `shell: true`) so it can kill the tree; I found the orphan with `Get-CimInstance Win32_Process`.
3. **The command-hook form did not run at all (P0.2-cmd)**, so the edit went through. My hook wrote a log line first and no log file appeared, so the process was never started. The command was `"D:/nodejs/node.exe" "D:/…/hook-cmd.mjs"`. I did not dig into why (rule 8). Treat command hooks as unproven on Windows.
4. **The Codex docs list `approvalPolicy: "unlessTrusted"`, but the server rejects it.** Valid values: `untrusted`, `on-request`, `granular`, `never`.
5. **File paths in hook and approval payloads are native Windows paths** (`D:\coding\reins-scratch\migrations\0001.sql`, backslashes). The guard regex must accept both separators. The path is absolute, not repo-relative.
6. **The user's global hooks run inside `-p` sessions** (3 `SessionStart` hooks appear in every stream before `system/init`); the plan mentions project hooks only. Also the shell tool on this machine is called `PowerShell`, not `Bash`, so matchers for shell tools need both names.
7. `system/init` capabilities on 2.1.281: `interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1, mcp_read_resource_v1, mcp_tool_ui_meta_v1`.
8. After an interrupt Claude emits a second `system/init` in the same stream.
9. Codex's thread default sandbox on this machine is `dangerFullAccess`, so **approvals are the only barrier**; the approval flow held (both patch attempts were declined and the model retried once).
10. Codex `untrusted` did not ask for one read-only shell command; it asked for the others.

## [assumed] items in plan §8

| item | status | evidence |
|---|---|---|
| §8.2 flag combination starts a stream-json session with `--session-id` | **Confirmed** | P0.1 |
| §8.2 `--settings` with `type:"http"` hooks | **Confirmed**, with a file path | P0.2 |
| §8.2 hook `deny` runs before/over user allow rules in the CLI | **Confirmed** (Edit) | P0.3 |
| §8.2 hook denial text reaches the model | **Confirmed** | fixture `hook-deny.jsonl` |
| §8.2 `--permission-prompt-tool mcp__…` + `--mcp-config` waits for Reins | **Confirmed**, 120 s hold OK | P0.4a/b |
| §8.2 PostToolUse `additionalContext` "reaches the model before its next call" | **Partly**: it reaches the model; **refuted as an obeyed instruction** with this wording | P0.5a |
| §8.2 "Send SIGINT, not SIGTERM" | **Refuted on Windows via Node**; use the stdin `control_request` `interrupt` | P0.5b, P0.5c |
| §8.2 `--mcp-config` / `--settings` inline | **Untested**; file paths used (Windows quoting) | |
| §8.2 `--forward-subagent-text` | **Untested** | |
| §8.2 `SubagentStart`/hooks with `agent_id` fire in subagents | **Untested** | |
| §8.2 `probe()` login check via `authentication_failed` | **Untested** (only the logged-in case; `apiKeySource=none` seen in init) | P0.1 |
| §8.2 project `.claude/settings.json` hooks/`.mcp.json` run with no trust prompt in `-p` | **Untested** (user-level hooks did run, see surprise 6) | |
| §8.3 `codex app-server` runs on Windows | **Confirmed** | P0.6a |
| §8.3 `thread/start` policy that asks the client on every write | **Confirmed** as `untrusted` (name differs from docs) | P0.6b |
| §8.3 `item/fileChange/requestApproval` decline blocks the edit | **Confirmed** | P0.6b |
| §8.3 `turn/steer` delivers mid-turn | **Confirmed** | P0.6c |
| §8.3 `turn/interrupt` | **Confirmed** | P0.6d |
| §8.3 `account/read` shows login | **Confirmed** (`chatgpt`) | P0.6a |
| §8.3 read-only `sandboxPolicy` override per turn | **Untested** | |
| §8.4 Codex subagents follow guards | **Untested** (Phase 5) | |
| §8.4 "live card delivered via hook" on Claude | see §8.2 PostToolUse row: delivered, not obeyed | P0.5a |
| Knowl: stable output / JSON | **Confirmed**: JSON array on non-TTY | P0.7 |

## Not run / limits

- Only `Edit` was exercised for guards; no `Write`/`MultiEdit`/shell-write tests, no subagents.
- Only one run per test, one model (Sonnet 5, medium); LLM behaviour (P0.5a) may vary.
- The `permissions.deny` alternative for P0.3 was not needed, so not run.
- Codex cost is not reported by app-server here; only Claude costs are counted.

## Spend

Sum of `result.total_cost_usd` (cumulative per session) across the kept fixtures ≈ **$0.57** (P0.1 0.087, P0.2 0.093, P0.3 0.025, P0.2-cmd 0.024, P0.4a 0.162, P0.4b 0.026, P0.5a 0.119, P0.5c 0.029). The overwritten first P0.2-cmd run (about 0.03) and the P0.5b run (no result) are not in the fixtures. Total is well under $5.

## Fixtures

`spike/fixtures/`: `claude-2.1.281-{turns, hook-deny, hook-deny-cmd, allow-vs-deny, approval-deny, approval-allow-hold, card, sigint, interrupt-ctl}.jsonl`, `codex-0.153.4-{turns, deny, steer, interrupt}.jsonl` (email field redacted), `knowl-5.23.1-cli.json`.

## Reviewer follow-up: live cards

The reviewer (Hermes / Opus) ran these after the Sonnet run. Raw logs are in `spike/fixtures/claude-2.1.281-card-stdin.jsonl` and `-card-interrupt-resend.jsonl`.

| test | result | what happened |
|---|---|---|
| P0.5d | FAIL | The card was written to stdin as a plain `user` message while a turn was running, just after the first `tool_use`. Claude folded it into the tool result and Sonnet 5 refused it: "the tool result… contained an embedded instruction pretending to be from you, which I'm disregarding". No second turn followed, so the card was consumed and lost. |
| P0.5e | PASS | Sent a `control_request` interrupt at the first `tool_use`, then the card as the next real user turn. Claude followed it: the reply ended with PINEAPPLE, in the same session. The in-flight tool call is lost. Turn 1 ends `error_during_execution`, at a cost of $0.007. |

**Verdict: there is no working mid-turn card on Claude 2.1.281 with Sonnet 5.**
- Both in-turn routes put the card inside tool output: PostToolUse `additionalContext` (P0.5a) and a stdin message during the turn (P0.5d).
- Sonnet 5's prompt-injection defence rejects both.
- That defence is correct, and Reins must not try to get around it.

**Design consequence for plan §8.2 and §6.5 (Claude engine only):**
- **"Now" card:** `control_request` interrupt, then send the card as the next user turn. This works. It costs the in-flight tool call.
- **"Next step" card:** prepend it to the next step's turn text. The core already does this.
- **Codex** keeps true mid-turn delivery through `turn/steer` (P0.6c passed).
- The mockup's "delivered mid-run" wording for Claude must change to "delivered next turn" or "interrupts now".
