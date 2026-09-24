# Reins: full version plan

Written 2026-09-23. It covers everything from the first test to the public release.

Status: **draft for review**. Nothing is built yet, and nothing below is committed.

How to read this:
- Sections 1–12 are the **design**: what we build and how it works.
- Section 13 is the **order of work**, with an exit test for each phase.
- Sections 14–15 break **Phase 0 and Phase 1 into small tasks** you can start today.
- Later phases get their own detailed task list when we reach them. Their design is already fixed here, but writing their step-by-step tasks now would be guessing, because Phase 0 can still change things.

Every claim about Claude Code, Codex or Knowl is tagged:
- **[checked]**: read in the vendor docs or source on the date given.
- **[assumed]**: we believe it but have not run it. Phase 0 proves or kills it.

---

## 1. What Reins is

**One line:** a chat app for coding agents where you build the agent's workflow from blocks, and Reins makes the agent follow it.

**The problem it solves:** today you steer an agent with plain text ("plan first", "don't touch migrations", "run the tests until they pass") and hope it listens. Reins turns those sentences into **blocks that are enforced**:
- A gate really stops edits until you approve.
- A guard really blocks the file.
- A loop really runs the tests, and really stops at its limit.

**Who it is for:** developers who already use Claude Code or Codex and want more control, less drift and less repeated typing. It is for every model, not only weak ones. The value is control and making your intent visible, not a benchmark score.

**What you see:**
- A normal chat with an agent.
- A list of your sessions.
- A workflow for each session, shown three ways:
  - **Blocks**: a Scratch-style editor.
  - **Map**: a boxes-and-arrows picture.
  - **Text**: the `.reins.md` file itself.
- A palette of cards you can drop onto the workflow, or onto a running session to steer it live.
- A receipt at the end of each run that lists every time Reins stepped in.

The clickable mockup (`mockup.html`) shows all of this. **The mockup is the UI spec.** Where this document and the mockup disagree, this document wins, and the mockup gets updated.

---

## 2. Decisions already made

| # | Decision | Source | Replaces |
|---|---|---|---|
| D1 | **TypeScript everywhere.** Rust only where it clearly wins. Nothing needs it in v1. | user, 2026-09-23 | CONTEXT.md §12b (Rust core) |
| D2 | **Reins is its own harness (a chat app), not a plugin or MCP server inside someone else's.** | user, 2026-09-23 | CONTEXT.md §11 steps 1–3 |
| D3 | **Reins does not write the agent loop.** It drives existing engines: the official `claude` CLI and `codex app-server`. | agreed, 2026-09-23 | — |
| D4 | **Login is always the engine's own login.** Reins never reads, copies or refreshes Claude or ChatGPT tokens. The user logs in to Claude Code or Codex, and Reins runs the unmodified binary. | Anthropic legal page [checked] | the "copy Hermes OAuth" idea |
| D5 | **Text is the source of truth.** A workflow is a `.reins.md` file. Blocks and Map are drawn from it. Editing them rewrites the file. | CONTEXT.md §9.5 | — |
| D6 | **Each workflow step is its own agent turn.** Reins sends a step, waits for the turn to end, judges the result, then sends the next step. | this plan | Stop-hook chaining (it hit the cap of 8 blocks per turn) |
| D7 | **Every cycle has a budget.** A loop has `max:`. A link that jumps backward has `max:`. The whole run has limits on turns and minutes. No budget, no run. | CONTEXT.md §9.4 | — |
| D8 | **Knowl is optional.** Its nodes are always shown. Without Knowl installed they do nothing, and they say so. | 2026-09-21 | — |
| D9 | **Open source first**, released like Knowl. SaaS and a desktop app are later and not decided. | user, 2026-09-21 | — |

Why D4 matters. Anthropic's terms say [checked, `code.claude.com/docs/en/legal-and-compliance`]:
- Third-party developers may not *"route requests through Free, Pro, or Max plan credentials on behalf of their users"*, and may not *"collect, store, or intermediate Claude.ai credentials or session tokens."*
- They **do** allow *"an end user … signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."*
- Two conditions: the binary stays unmodified, and Reins does not use the Claude Code name or logo in its own name, logo or branding.

---

## 3. Open decisions (each has a default, so work does not stop)

| # | Question | Default if you don't answer | Needed by |
|---|---|---|---|
| Q1 | Which engine ships first? | **Claude CLI.** You use Claude. Codex follows in Phase 5. | Phase 2 |
| Q2 | Allow free links (jump anywhere), or snap-only? | **Allow both.** Blocks snap together. Links are separate, drawn on the Map and shown as tags on a block. Every backward link needs `max:`. | Phase 1 (format) |
| Q3 | Where do workflow files live? | Project workflows in **`.reins/workflows/*.reins.md`**, committed to git so a team shares them. Personal ones in `~/.reins/workflows/`. My blocks in `.reins/blocks/` and `~/.reins/blocks/`. | Phase 1 |
| Q4 | UI framework? | **React + Vite.** The editor needs real component state, and it is what Hermes desktop uses. | Phase 3 |
| Q5 | License? | **Apache-2.0**, same as Knowl. Check Knowl's LICENSE and CLA setup and copy them. | Phase 7 |
| Q6 | npm name and GitHub org? | `reins` on npm (free on 2026-09-21; check again before publishing), repo `dat999zx/reins`. Domain not checked. | Phase 7 |
| Q7 | Desktop app wrapper? | **Not in v1.** `npx reins` opens the app in your browser. Tauri or Electron gets decided after launch. | after v1 |

---

## 4. The big picture

```
 ┌────────────────────────────── your machine ───────────────────────────────┐
 │                                                                            │
 │  Browser tab (packages/app)          reins server (packages/server)        │
 │  ┌───────────────────────┐   HTTP    ┌───────────────────────────────┐     │
 │  │ chat · session list   │ ────────▶ │ sessions · store (SQLite)     │     │
 │  │ Blocks · Map · Text   │ ◀──────── │ run engine (packages/core)    │     │
 │  │ Block panel · palette │   SSE     │ judges · drift · receipts     │     │
 │  └───────────────────────┘           │ engine adapters               │     │
 │                                      │   ├─ claude (CLI, stream-json)│     │
 │                                      │   └─ codex (app-server, RPC)  │     │
 │                                      │ hook endpoint · approval MCP  │     │
 │                                      │ knowl bridge (CLI)            │     │
 │                                      └──────┬──────────────┬─────────┘     │
 │                                             │ stdio        │ stdio         │
 │                                      ┌──────▼─────┐  ┌─────▼──────────┐    │
 │                                      │ claude -p  │  │ codex          │    │
 │                                      │ (user's    │  │ app-server     │    │
 │                                      │  login)    │  │ (user's login) │    │
 │                                      └────────────┘  └────────────────┘    │
 └────────────────────────────────────────────────────────────────────────────┘
```

There are three packages. Keep it at three until one of them hurts.

| Package | Does | Talks to | Must not |
|---|---|---|---|
| `packages/core` | The workflow model, the `.reins.md` parser and printer, the condition language, the validator, the compiler (step to prompt text), the run engine, drift rules and receipts. | Nothing. It is pure logic, and all input and output goes through interfaces passed in. | Import `node:child_process`, `node:fs` or anything from a network. |
| `packages/server` | The `reins` CLI, the local HTTP server, the engine adapters, the hook endpoint, the approval MCP server, the SQLite store, the command runner and the Knowl bridge. | Engines, the file system, git, Knowl and the browser. | Hold workflow rules. Those belong in core. |
| `packages/app` | Everything you see. | Only the server's HTTP API. | Hold any rule that decides a run. The UI shows state; it never decides it. |

Why core is pure: the run engine is the product. It must be testable with a fake engine in milliseconds, with no real Claude or Codex, no clock and no disk.

---

## 5. The `.reins.md` format

The format is the first thing we lock, because every other part reads it.

### 5.1 Goals

- A person can write it in any editor, and a diff of it reads well in a PR.
- An agent can read it.
- Parse then print gives back the same file for any file Reins itself printed. Hand-written files get tidied into the standard layout on their first save.
- Errors point to a line and column, so the UI can underline them.

### 5.2 Example: the mockup's workflow

```markdown
---
reins: 1
name: upload-retry
task: add retry to the upload endpoint
engine: claude
budget: { turns: 40, minutes: 60, usd: 3.00 }
always:
  - No new dependencies.
  - Keep functions under 40 lines.
---

## recall
knowl: upload, retry

## phase plan
mode: read-only
> Write a plan for adding retry to the upload endpoint.
> Do not write code. Output the plan as a numbered list, then stop.

## gate
until: you approve

## phase implement
guard: migrations/**
note: Explain each change in one line.
> Implement the approved plan. Do not deviate; if you must, stop and say why.

## repeat
until: `npm test` passes
max: 5

### run `npm test`

### phase fix
> Read the error output first. Fix the cause, not the symptom.

## verify
against: plan
on-fail: implement (max 2)

## use review-pass

## store
knowl: decisions

## handoff
to: fresh session
focus: summary for the next agent

## whenever same error twice
nudge: Stop. Read the error before re-running.

## whenever diff > 300 lines
nudge: Split this into smaller steps.
```

### 5.3 Rules

**File sections:**
- **Frontmatter** is YAML. Keys: `reins` (format version, required), `name` (required, used as the id), `task`, `engine` (`claude` | `codex`), `model` (optional, passed to the engine), `budget` (required: `turns` and `minutes`; `usd` only matters for API-key users), `always` (a list of standing instructions), `test` (optional default test command; `tests pass` means this command exits 0).
- **Steps** are headings. `##` is a top-level step. `###` is a child of the nearest `##` container (`repeat` or `if`). `####` is one level deeper. Nesting goes as deep as heading levels allow (six), which is more than enough.
- **Heading text** is `<kind> [title or argument]`. Kinds: `phase`, `say`, `run`, `gate`, `repeat`, `if`, `else`, `verify`, `use`, `recall`, `store`, `handoff`, `whenever`.

**Inside a step:**
- **Attribute lines** under a heading are `key: value`. Unknown keys are an error, not ignored, because a typo like `gaurd:` that did nothing would be the worst kind of bug.
- **Prompt lines** start with `> `. They form the step's custom prompt, word for word. A blank `>` line is a blank line in the prompt.
- **Step ids**:
  - A `phase` step's default id is its title as a slug (`plan`, `implement`).
  - Any other step's default id is its kind plus a number (`gate-1`).
  - `id: foo` overrides it.
  - Ids must be unique within the file. Links, `verify against:` and live edits all refer to steps by id.

**Branches and links:**
- **`else`** can only appear as a direct child of an `if` (`### else`). Children that follow it belong to the false branch.
- **Links** are attribute lines on the step they leave from: `next:`, `on-pass:`, `on-fail:`, `retry:`, `verify-against:`, `hand-off:`. A backward link needs `(max N)`. The validator checks this.
- **Auto cards** (`## whenever <condition>`) sit at the top level, usually at the end, and hold exactly one steer line (`nudge:`, `checkpoint:`, `budget:`, `role:`, `undo:`). They do not run in order; they fire when their condition becomes true.
- **Attached cards** are attribute lines on a step:
  - `guard: <glob>` can repeat.
  - `note: <text>` is an instruction for this step only, and can repeat.
  - `nudge:`, `role:`, `checkpoint:`, `budget:` and `undo:` are delivered when the step starts.
- **My blocks:** `## use <name>` inserts the block defined in `.reins/blocks/<name>.reins.md` or `~/.reins/blocks/<name>.reins.md`. The project file wins. A block file has the same format, and its frontmatter has `reins: 1, block: <name>` and no budget. Editing a block changes every workflow that uses it.

### 5.4 Condition language

Hexagons in the UI and `until:`, `if`, `whenever` and `gate` in text all use one small grammar.

```
cond    := or
or      := and ("or" and)*
and     := unary ("and" unary)*
unary   := "not" unary | "(" cond ")" | atom
atom    := "you approve"
         | "tests pass"
         | "`" command "`" "passes"
         | "llm says" quoted
         | "reviewer approves" [quoted]
         | "agent says done"
         | "diff >" INT "lines"
         | "touches" glob
         | "attempts >" INT
         | "same error twice"
         | "drift"
```

Each atom maps to one **judge** (§7). The judge is chosen by the atom, never picked separately. That removes a whole class of "the condition says tests, but the judge is an LLM" mistakes.

### 5.5 Validator: errors that block a run

1. An unknown kind or attribute key.
2. A duplicate id.
3. A link or `verify against:` pointing to an id that doesn't exist.
4. A `repeat` without `max:`, or a backward link without `(max N)`.
5. A `gate` without `until:`.
6. An `else` outside an `if`, or two `else`s in one `if`.
7. `use` naming a block that can't be found.
8. A glob that won't compile.
9. A missing budget in the frontmatter.
10. A condition that won't parse. The error names the column.

Warnings that don't block:
- `llm says` / `reviewer approves` cost extra model calls.
- `tests pass` with no `test:` set in the frontmatter falls back to `npm test`.
- A `phase` step with no prompt.

### 5.6 Trust

A `.reins.md` file from a cloned repo can run shell commands: `run`, `` `cmd` passes ``, and `test:`. So the first time Reins sees a workflow file, and each time its commands change, it asks: *"This workflow runs these commands: … Trust it?"* Reins remembers a hash of the file's command lines per project. It is the same idea as Claude Code's folder trust. **Nothing runs from an untrusted workflow.**

---

## 6. Running a workflow

### 6.1 Compile the tree into a small program

Core flattens the step tree into a list of instructions with explicit jumps:

```
0  RECALL   topics=[upload, retry]
1  TURN     step=plan      policy=read-only
2  GATE     step=gate-1    cond=you approve
3  TURN     step=implement policy=write guards=[migrations/**]
4  LOOP_IN  step=repeat-1  max=5
5  RUN      step=run-1     cmd="npm test"   → on pass: JUMP 8
6  TURN     step=fix       policy=write
7  LOOP_BK  step=repeat-1  → 5 (counts an attempt; over max → BUDGET_STOP)
8  VERIFY   step=verify-1  against=plan  → on fail: JUMP 3 (link max 2)
9  USE ...  (block body inlined, ids prefixed "review-pass/")
…  STORE, HANDOFF, END
```

The run engine is a program counter over this list, plus counters for each loop and each link. After every instruction it saves its full state. So a crash, a closed laptop or a killed server resumes from the last saved step, not from the start.

### 6.2 What each step kind does

| Kind | What Reins does | Sends a turn to the agent? |
|---|---|---|
| `phase` | Sends the step's text (§6.3). Waits for the turn to end. Applies the step's permission policy while it runs. | yes |
| `say` | Sends the prompt word for word, plus the `always` rules. | yes |
| `run` | Reins runs the command itself: a child process in the project folder, with a timeout (default 10 min), output streamed to the UI. Pass = exit code 0. The agent cannot skip it or fake the result. | no |
| `gate` | Pauses. Asks the condition's judge. Resumes on "yes". While paused, the agent is idle. | no |
| `repeat` | Runs its children until the condition is true, up to `max`. When the budget is used up it pauses and asks you: *allow N more* or *stop*. | children may |
| `if` | Reins judges the condition, then runs one branch. | children may |
| `verify` | Sends "compare what you built against step X" with step X's final output quoted (the plan the agent wrote, not the prompt that asked for it). The step asks the agent to end with `REINS: pass` or `REINS: fail: <what is missing>` (§7.4). A fail follows `on-fail` if set. Otherwise it goes on and the receipt records the fail. | yes |
| `use` | Inlined at compile time. | children may |
| `recall` | Runs `knowl query`. The results are added to the **next** turn's text. | no |
| `store` | Asks the agent (in the next turn, or a short extra turn) for a one-paragraph decision summary, then runs `knowl store --provenance observed`. | yes (short) |
| `handoff` | Asks the agent for a hand-off summary. Then, depending on `to:`: `fresh session` starts a new session of the same engine with the summary as its first message. `Codex` / `Claude` starts one on the other engine. `a subagent` sends it as a note for the agent's own subagent. | yes |
| `whenever` | Not in the program. Checked after every agent event (§6.5). | no, it delivers a card |

### 6.3 What a turn's text looks like (the compiler)

One function builds the exact text for a turn: `compileTurn(step, runState) → string`. It is the "What the agent receives" box in the mockup, so the UI calls the same function for its preview. Layout:

```
[Reins · workflow "upload-retry" · step 3 of 9: implement]

Always:
- No new dependencies.
- Keep functions under 40 lines.

Context from Knowl:            ← only if a recall ran just before
- …

<the step's own prompt, word for word>

For this step:
- Do not touch migrations/**. (Enforced: edits there are blocked.)
- Explain each change in one line.

When you finish this step, end your reply with exactly one line:
REINS: done | blocked: <reason>
```

Rules for the compiler:
- **Your words are never rewritten.** The compiler only adds the labelled parts around them.
- **An enforced card says that it is enforced.** The agent learns early that the wall is real, so it retries less.
- **The last line is the status line** that Reins reads (§7.4).
- Golden tests pin the output. Changing the layout is a deliberate change to the golden files.

### 6.4 Permission policy for each step

For each step core computes a `Policy`:

```ts
interface Policy {
  mode: 'read-only' | 'write';   // read-only: no edits, no shell commands that write
  guards: string[];              // globs no tool may write to
  allowShell: boolean;           // default true in 'write' mode
  pendingGate?: string;          // set while a gate is waiting: every write is refused
}
```

The adapter enforces the policy **before** the tool runs (§8). A refusal goes back to the agent with a reason written for it, for example: *"Blocked by Reins: step 'plan' is read-only. Finish the plan; edits unlock after the gate."* Every refusal is logged, and the receipt counts them.

### 6.5 Live cards and auto cards

**Live cards:**
- You drop a card on a running session, or type into the chat box while a workflow runs. That creates a **pending card**.
- Delivery goes through the engine's mid-turn channel:
  - Claude: the PostToolUse hook's `additionalContext`.
  - Codex: `turn/steer`.
- If the turn ends before a tool call happens, the card goes into the next turn's text instead.
- The UI shows each card as `queued → delivered (mid-turn | next turn)`.

**Auto cards (`whenever`):**
- Checked after every agent event against the run's counters.
- Once one fires, it sleeps until its condition turns false and then true again. That stops it from repeating on every event.
- Delivered the same way as live cards.

**Live edits:**
- You can change the workflow while it runs.
- Core parses the new file again and matches steps by id. The program counter stays on the current step's id.
- If the current step was deleted, the run pauses and asks where to go on.
- Changes to steps already finished have no effect on this run, and the UI says so.

### 6.6 Budgets and stopping

- **Run budget:** turns, minutes, and optionally dollars (engines report cost; for subscription users it is shown but not enforced by default). At 80% the UI warns. At 100% the run pauses and asks.
- **Loop and link budgets:** pause and ask, as in the mockup.
- **Stop:** interrupts the current turn (the engine's interrupt), marks the run stopped, and writes the receipt.
- **Pause:** lets the current turn finish, then holds before the next step.

### 6.7 Events, state and the receipt

- Everything that happens is one row in an **append-only event log** (SQLite, one table): turn started or ended, tool call, refusal, card queued or delivered, judge asked or answered, budget warning, user action.
- **Run state** (the program counter and counters) is saved after each instruction.
- **The receipt** is built from the event log. It is never stored separately, so it can't disagree with what happened. It counts gates held, guard refusals, early finishes refused, loop attempts, auto cards fired, live cards, verify results, Knowl recalls and stores, time, turns and cost.

---

## 7. Judges: who decides a condition

| Atom | Judge | How | Cost |
|---|---|---|---|
| `you approve` | you | Pause; Approve / Request changes in the UI. "Request changes" sends your text as a turn and asks again. | free |
| `tests pass`, `` `cmd` passes `` | command | Reins runs it: exit 0 = true. On failure, the last 200 lines of output go into the next turn. | free |
| `diff > N lines` | deterministic | `git diff --numstat` against the run's start commit, counting added plus removed lines. | free |
| `touches <glob>` | deterministic | File paths from the tool events of this run. | free |
| `attempts > N` | deterministic | The loop counter. | free |
| `same error twice` | deterministic | The last two failed commands have the same normalised output hash (numbers, paths and timings stripped). | free |
| `drift` | deterministic | Any rule in §7.5 fires. | free |
| `agent says done` | the agent | The `REINS:` status line of the step's last reply. | free |
| `llm says "…"` | a model | One short turn in a **separate, tool-free** session of the same engine: the question plus the evidence, answered with `YES` or `NO` on the last line. Unclear = NO. | 1 small call |
| `reviewer approves ["…"]` | a sub-agent | A **separate** session in read-only mode gets the diff and the criterion, reviews, and ends with `VERDICT: pass` or `VERDICT: fail: <reasons>`. | 1 full turn |

### 7.1 Why the judge follows from the atom

If the condition text and the judge disagree, the graph lies to the user. Tying each atom to one judge makes that impossible.

### 7.2 Evidence the judges see

- A command judge sees nothing but the command.
- LLM and reviewer judges get a small evidence bundle: the criterion, the diff stat, the diff itself (trimmed to about 20k characters), and the step's last reply.
- The bundle goes into the receipt so you can see why a judge decided what it did.

### 7.3 Failure modes

- If a judge **crashes or times out**, the answer is "no", and the run pauses with the error shown. A broken judge never passes a gate.
- If a **model judge's reply can't be parsed**, it gets one retry with a stricter format. After that, the answer is "no".

### 7.4 The status line

Every agent step ends with `REINS: done` or `REINS: blocked: <reason>`. A `verify` step ends with `REINS: pass` or `REINS: fail: <what is missing>` instead.
- `blocked` pauses the run and shows the reason as a question to you.
- `fail` on a verify step follows its `on-fail` link.
- A missing status line counts as `done`, and the receipt notes it.

We don't lean on the status line for anything that matters. Tests, gates and guards never trust the agent's word.

### 7.5 Drift rules (v1 subset of LivePlan)

These are deterministic, with no LLM call. Each rule is a small pure function over the run's events, so each is easy to test and turn off.

| Rule | Fires when | Default card |
|---|---|---|
| repeated action | the same tool with the same arguments 3 times in one step | "You've run the same thing 3 times. Stop and read the output." |
| stagnation | more than 25 tool calls in one step with no file change | "25 steps with no change. Summarise where you are and what's blocking you." |
| edit before plan | a write attempt in a read-only step (it is also blocked) | none, the refusal is the message |
| skip validation | a step that says to test ends with no test command run | "You haven't run the tests in this step." |
| same error | see `same error twice` | "Same error again. Read it before retrying." |

The thresholds live in the frontmatter as `drift: { repeat: 3, stagnation: 25 }`.

---

## 8. Engine adapters

### 8.1 One interface, in core

```ts
export interface Engine {
  readonly id: 'claude' | 'codex';
  probe(): Promise<EngineProbe>;                  // installed? version? logged in? capabilities
  open(opts: OpenOptions): Promise<EngineSession>;
}

export interface EngineProbe {
  installed: boolean; version?: string; loggedIn: boolean | 'unknown';
  capabilities: { midTurnSteer: 'native' | 'hook' | 'none'; preToolDeny: boolean; resume: boolean };
  problems: string[];                              // shown by `reins doctor`, each with a fix
}

export interface OpenOptions {
  cwd: string;
  sessionId?: string;                              // resume
  model?: string;
  readOnly?: boolean;                              // judge / reviewer sessions
  policy: () => Policy;                            // read live, per tool call
  onApprove: (req: ToolRequest) => Promise<Decision>;   // ask the user (only when policy says "ask")
  pendingCards: () => string[];                    // drained on each mid-turn delivery chance
}

export interface EngineSession {
  readonly sessionId: string;
  turn(text: string): Promise<TurnResult>;         // resolves when the turn ends
  interrupt(): Promise<void>;
  events: AsyncIterable<EngineEvent>;              // normalised: text, tool_call, tool_result, refusal, cost, error
  close(): Promise<void>;
}
```

Core never sees a Claude or Codex message. Each adapter turns the engine's events into `EngineEvent`s. **One `FakeEngine`** in core's tests plays the same role from a script.

### 8.2 Claude adapter (`claude` CLI, unmodified)

**How the process starts** [flags checked in `cli-reference`, 2026-09-23; the combination is **assumed** until Phase 0]:

```
claude -p
  --input-format stream-json --output-format stream-json --verbose
  --session-id <uuid>            (or --resume <id>)
  --permission-prompt-tool mcp__reins__approve
  --mcp-config '<inline: { "reins": { command: "reins", args: ["mcp", "--run", "<runId>"] } }>'
  --settings '<inline: hooks, see below>'
  --forward-subagent-text
  [--model <m>]
```

**Hooks** passed in `--settings`, all `type: "http"` pointing at the Reins server, so there is **no extra process per tool call** [HTTP hooks checked in the hooks docs]:
- **`PreToolUse`: enforcement.** The server checks `policy()` and answers `permissionDecision: deny` with a reason, or passes. Hooks run **before** allow rules [checked in the Agent SDK permissions page], so a user's `allow: Edit` setting can't get around a guard. Whether the CLI applies the same order is **assumed**; Phase 0 test P0.3.
- **`PostToolUse`: live cards.** The response carries `additionalContext` with the pending cards [checked: it reaches the model before its next call; limit 10,000 characters].
- **`SubagentStart`/`PreToolUse` with `agent_id`**: subagents get the same guards [checked: hooks fire inside subagents with `agent_id`].

**Approvals.** Whatever the policy leaves open and Claude Code would ask about goes to the `mcp__reins__approve` tool. It is served by a tiny stdio MCP server (`reins mcp`) that forwards to the Reins server, which asks you in the UI.

**Turns.** Each step is one `user` message written to stdin. The turn ends at the `result` event, which holds the cost and the final text.

**Interrupt.** Send SIGINT, not SIGTERM. SIGTERM leaves the turn unfinished and records nothing [checked, headless docs].

**Login.**
- `probe()` runs `claude --version` and a tiny `claude -p "reply OK" --max-turns 1` with `--output-format json`.
- An `authentication_failed` error means "not logged in", and the UI says: *"Open a terminal and run `claude`, then log in. Reins uses Claude Code's own login."*
- **Reins never touches `~/.claude/.credentials.json`.**

**Watch out:**
- `-p` sessions run the project's `.claude/settings.json` hooks and `.mcp.json` servers with no trust prompt [checked]. Reins shows this in its own trust prompt (§5.6).
- `--bare` would skip them, but it also skips the subscription login [checked], so we don't use it.

### 8.3 Codex adapter (`codex app-server`)

Checked in the app-server docs on 2026-09-23; running it is **assumed** until Phase 0.

**How it runs:**
- Start `codex app-server` (JSON messages over stdio, one per line).
- Send `initialize` with `clientInfo.name = "reins"`.
- `thread/start { cwd, approvalPolicy }`, with a policy under which every write and command asks the client.

**Mapping steps and cards:**
- **Turns:** `turn/start` per step. Read-only steps pass a read-only `sandboxPolicy` override on that turn. The turn ends at `turn/completed`.
- **Enforcement:** `item/fileChange/requestApproval` and `item/commandExecution/requestApproval` come to Reins. Reins checks `policy()`, then denies, approves, or asks you.
- **Live cards:** `turn/steer` (native, mid-turn).
- **Interrupt:** `turn/interrupt`.

**Login:**
- `account/read`. If the user isn't logged in, the UI offers **"Log in with ChatGPT"**, which calls Codex's own `account/login/start` (chatgpt or device code). That is Codex's flow, not ours.
- Reins never reads Codex's token files.

**Watch out:** Knowl's notes say Codex *hooks* didn't run on Windows (Aug 2026). This adapter does **not use hooks**, so that doesn't apply. Still, app-server on Windows is Phase 0 test P0.6.

### 8.4 How each card behaves on each engine

The UI shows this on every card.

| Card | Claude CLI | Codex app-server |
|---|---|---|
| guard, read-only step, gate lock | **enforced** (PreToolUse deny) | **enforced** (approval deny) |
| run / command judge | **enforced** (Reins runs it) | **enforced** |
| live card mid-turn | **delivered** via hook, or the next turn if there is no tool call | **delivered** natively via `turn/steer` |
| nudge / role / checkpoint | **advised** (text; the agent can ignore it) | **advised** |
| subagent follows guards | **enforced** (hooks fire in subagents) | **assumed**; check in Phase 5 |

### 8.5 Engines we are not doing in v1, and why

- **Claude Agent SDK:** needs an API key for third-party apps [checked]. Could later be a third adapter for API-key users.
- **Cursor, Copilot, Windsurf, agy, Hermes:** no documented way for another app to drive them turn by turn with approvals. A later "Reins inside your harness" mode could reuse Knowl's host profiles (`knowl/src/session/hosts/*`), but with weaker enforcement. Out of scope for v1.

---

## 9. The server and its API

- **Start:** `reins` (or `npx reins`) starts the server on `127.0.0.1`, on a random free port, with a random 32-byte token, and opens `http://127.0.0.1:<port>/#token=<t>` in your browser.
- **Security:**
  - It binds to localhost only.
  - Every request needs the token, and every request's `Host` must be `127.0.0.1:<port>`, which blocks DNS rebinding.
  - The hook endpoint uses its own token for each run.
- **Transport:** plain HTTP JSON for commands, and **Server-Sent Events** for the live stream. No WebSocket library; Node has everything needed built in.
- **Storage:** `node:sqlite` (built into Node; it runs on this machine's Node 24.15 [checked]) in `~/.reins/reins.db`. Tables: `sessions`, `runs`, `events`, `trust`. Workflow files stay files.
- **Needs Node ≥ 22.** Match Knowl's `engines`.

### 9.1 Endpoints (v1)

```
GET  /api/state                         sessions, runs, engines (probe results)
GET  /api/stream                        SSE: every event for every open session
POST /api/sessions                      {engine, cwd, workflow?} → start a session
POST /api/sessions/:id/message          {text} → a normal turn, or a live card while a run is active
POST /api/sessions/:id/run              {workflow} → start a run
POST /api/runs/:id/{pause,resume,stop}
POST /api/runs/:id/approve              {requestId, decision, note?}
POST /api/runs/:id/budget               {allowMore: n}
POST /api/runs/:id/card                 {card, text?}
GET  /api/workflows                     list (project + personal + blocks)
GET  /api/workflows/:name               {text, parsed, diagnostics}
PUT  /api/workflows/:name               {text} → saved file + diagnostics
POST /api/workflows/:name/trust
POST /api/preview                       {workflow, stepId} → compileTurn output
POST /hook/:runToken                    Claude HTTP hooks
```

The UI edits by sending **text**. Blocks and Map edits turn into a new model, core prints it, and the UI sends the text. So the file really is the source of truth. The server reads it back and returns diagnostics.

### 9.2 CLI commands

```
reins                        start the server + open the app
reins run <file> [--engine claude|codex] [--yes]    run a workflow in the terminal (no UI)
reins check <file>           validate; print diagnostics; exit 1 on errors
reins print <file>           print the tidied file (the formatter)
reins doctor                 engines installed? logged in? versions known-good? Knowl? node:sqlite?
reins mcp --run <id>         (internal) the approval MCP server Claude starts
```

`reins run` is the first thing people will use, and our main dogfood tool in Phase 2, before the UI exists. Gates ask on the terminal, and live cards are typed in.

---

## 10. Knowl integration

- **Detection:** `knowl --version`. If the command is missing, Knowl nodes show "Knowl not installed – this block does nothing" and the run carries on.
- **Recall** (`recall` node, plus optional `auto-recall: true` in the frontmatter at run start):
  - Runs `knowl query "<topics>" --limit 5` in the project folder.
  - Reins adds the results to the next turn under "Context from Knowl".
  - It uses the **node's topics**, never your prompt text, as the search. Knowl's own rule: prompt text must not become the search string.
- **Store** (`store` node, plus optional `auto-store: decisions` at run end):
  - Runs `knowl store --category decision --provenance observed --title … --path …`.
  - The paths come from the files the run touched.
- **Shared memory:** every session on the machine that uses Knowl sees what was stored. The fleet bar in the mockup ("+1 memory") comes from this.
- **Machine-readable output:** Phase 0 checks whether `knowl query` has JSON output. If not, add `--json` in Knowl. You own it, so it's a small PR there, not a workaround here.
- **Later:** Knowl's `knowl_drift` (knowledge this branch may have broken) as a `drift` condition source.

---

## 11. The app (UI)

Built in React + Vite, so a build is one static folder the server hosts. The screens come straight from `mockup.html`, plus the two things you asked for.

| Area | v1 contents |
|---|---|
| **Session list** (new, left rail) | Every session Reins started, grouped by project. For each: engine, workflow, status (idle / running / waiting on you / done / stopped), last activity, cost. "New session" button (pick engine + folder). Sessions waiting on you float to the top with a badge. |
| **Chat** (right panel, "Session" tab) | Normal prompting: when no workflow runs, what you type is a normal turn. While a run is active, what you type becomes a live card. Streamed agent text, tool calls, refusals, gate cards with Approve / Request changes, budget prompts, the receipt. Slash commands: `/run <workflow>`, `/stop`, `/pause`, `/approve`. |
| **Blocks** | The mockup's Scratch editor: snap and nest, drag grip to move, drop on the palette to delete, hexagon slots for conditions, inline editable text, My blocks, the Always box, auto cards. |
| **Map** | The mockup's read-only-layout graph: live progress, loop boxes, verify-back and free links, drag between dots to link, click a link to change it. |
| **Text** | The `.reins.md` file, with syntax colours and inline diagnostics, editable. What you type is re-parsed about 300 ms after you stop typing, and the other views update. A "What the agent receives right now" box sits underneath. |
| **Block panel** | The selected step's prompt, attributes, condition (with the judge written out), cards, links, and a preview of the text the agent gets. |
| **Palette** | Flow / Conditions / Steer / Memory / Auto / My blocks, as in the mockup. Every card shows **enforced** or **advised** for the current engine (§8.4). |
| **Fleet bar** | The mockup's bottom bar, fed by the session list. "All sessions" broadcast sends a card to every running session. |
| **Settings** | Engines (probe results, fixes), default budget, trust list, Knowl status. |

What's not in v1: rewind or fork, team card decks, a mobile layout, themes beyond dark.

The **mockup's scripted demo** turns into a **test fixture**: the same run played by `FakeEngine` drives the real UI in the smoke test (§12).

---

## 12. Testing

The rule we follow: **a green test must fail when the behaviour breaks.** Every new test gets one deliberate mutation to prove it can fail.

| Layer | Tool | What |
|---|---|---|
| core | vitest | Parser and printer round-trip on every example workflow, plus randomly generated trees (parse(print(t)) == t). Condition grammar. Every validator rule, with an error position. `compileTurn` golden files. Run engine against `FakeEngine`: gate pause and resume, loop budget stop and allow-more, `on-fail` jump with link budget, verify-back, live card queued then delivered mid-turn and next-turn, auto card fire once and re-arm, live edit (step added, current step deleted), crash and resume from saved state, receipt counts. |
| server | vitest + real child processes | Policy decisions from recorded hook payloads. SSE stream. Trust hash. `reins check`. The command runner (timeout, output limit, Windows paths). Knowl bridge against a temp Knowl project. |
| adapters | recorded fixtures | Phase 0 records real JSONL from `claude` and `codex app-server`. The file name holds the version and date, e.g. `claude-2.1.280-2026-09-24-turns.jsonl`. Replay tests check we turn each one into the right `EngineEvent`s. When a CLI updates, record again and diff. |
| live E2E | vitest, only when `REINS_LIVE=1` | The same five checks as Phase 0, against real engines, with a real login. Run by hand before every release. **It uses real usage, so it never runs in CI.** |
| app | vitest + one headless-Chrome smoke | The scripted upload-retry run against `FakeEngine`: approve the gate, drop a live card, check the receipt. The same checks we ran on the mockup, now on the real app. |
| CI | GitHub Actions | ubuntu, windows and macos. typecheck, lint, all tests except live, build, `npm pack` then install the tarball in a clean folder and run `reins --version` and `reins check examples/*.reins.md`. |

---

## 13. Phases, exit tests and timeline

Rough estimates are for two people. Each phase ends with something you can run.

| Phase | Builds | Exit test (all must pass) | Est. |
|---|---|---|---|
| **0. Test the engines** | Throwaway scripts in `spike/`. Findings doc. Recorded fixtures. | P0.1–P0.8 pass (§14). **Kill switch K1:** if a gate can't block a Claude edit by any documented route, stop and rethink (fallback: the Agent SDK with an API key). | 2–3 days |
| **1. Core** | `packages/core`: model, format, conditions, validator, compiler, run engine, drift rules, receipt, FakeEngine. | All core tests green. The 4 mockup workflows parse, validate, print back byte-for-byte, and run end-to-end on FakeEngine with the right receipts. | 1–1.5 weeks |
| **2. Claude adapter + terminal runner** | `packages/server`: Claude adapter, hook endpoint, approval MCP, command runner, store, `reins run` / `check` / `print` / `doctor`. | `reins run examples/upload-retry.reins.md` on a real repo: read-only plan step blocks an edit, gate waits for your terminal approval, guard blocks a `migrations/` edit, test loop stops at max and asks, typed live card arrives mid-turn, receipt printed. **Dogfood starts.** | 1.5 weeks |
| **3. Server + first UI** | HTTP/SSE API, session list, chat with normal prompting, approvals in the UI, Text view with diagnostics, receipt. | You can do the Phase 2 run from the browser only, including approving and dropping a card. Two sessions run side by side. | 1.5–2 weeks |
| **4. Blocks, Map, Block panel** | Port the mockup editor onto the real model. | Every mockup interaction works on real files: snap and nest, move, delete, condition slots, links, My blocks, Always box, auto cards, live edit during a run. Each edit round-trips through the text. The smoke test passes. **Kill switch K3** measured after a week (below). | 2 weeks |
| **5. Codex adapter** | Codex app-server adapter, ChatGPT login flow through Codex, per-card enforcement labels for Codex. | Phase 2's exit test passes on Codex. `turn/steer` delivers mid-turn. | 1 week |
| **6. Knowl + drift + judges** | Knowl bridge (and a `--json` PR to Knowl if needed), all drift rules, LLM judge, reviewer judge, auto-recall and auto-store. | A run recalls, stores, and another session sees the stored item. Each drift rule fires on a scripted trace and not on a clean one. Reviewer judge blocks a planted bug. | 1 week |
| **7. Release v0.1** | npm packaging (`reins` bin, bundled app), `reins doctor` fixes, README, docs site pages, 6 example workflows, CI matrix, clean-install script, CHANGELOG, license and CLA. | A clean-machine script (wipe first) installs from the packed tarball on Windows and macOS, runs `reins doctor` green, and runs one example workflow on each engine. Then publish. | 1 week |
| **Later** | Desktop wrapper; Agent SDK adapter (API key); "inside your harness" mode using Knowl host profiles; rewind or fork with git worktrees; shared team decks; Map editing; SaaS. | — | — |

**Total to v0.1: about 11–13 weeks.** The estimate is least reliable in Phases 3–4 (UI).

### 13.1 Kill switches (measured, not felt)

- **K1** (end of Phase 0): enforcement works on Claude. If not, stop, see above.
- **K2** (after one week of daily dogfood with `reins run`, end of Phase 2):
  - Count the times **"the agent did something I had already told it not to"**, with Reins versus without it, over similar tasks.
  - Count **cards dropped vs. steering sentences typed.**
  - If enforced rules still get broken, the adapter is wrong; fix it before the UI.
  - If you still type more than you click, the card set is wrong; rethink the cards before Phase 4.
- **K3** (one week after Phase 4):
  - Record where edits happen: Blocks vs. Text vs. Map.
  - If under 20% of edits happen in Blocks, stop investing in the editor. Keep the Map as the viewer and Text as the editor.
- **K4** (before release): 10 real tasks, with and without a workflow. Count **rework**: times you had to redo or reject agent work. This is the number for the README, not the pass rate.

---

## 14. Phase 0: detailed tasks

**Where:** `spike/` in this repo, on branch `spike/engines` in its own worktree. Throwaway code: plain `.mjs` files, no build.
**Needs:** Node 24 (`/d/nodejs/node`, not Hermes's bundled node). `claude` 2.1.280 logged in. `codex` 0.153.4 logged in. A scratch git repo `D:/coding/reins-scratch` with a tiny `npm test` and a `migrations/` folder.
**Rule:** every test writes what it saw to `spike/fixtures/` and a PASS/FAIL line to `spike/results.md`.

### P0.0 Scratch repo

1. `mkdir D:/coding/reins-scratch && cd` there. `git init`. Add:
   - `package.json` with `"test": "node test.mjs"`.
   - `src/upload.mjs`, a function with no retry.
   - `test.mjs`, one assert that fails until retry exists.
   - `migrations/0001.sql`.
2. Commit. Run `npm test`. Expected: exit 1.

### P0.1 Claude: three turns in one session over stream-json

1. Write `spike/claude-turns.mjs`:
   - Spawn `claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid>` in the scratch repo.
   - Write three `user` messages, one after the previous `result` event: "Reply with the word ONE.", then "TWO", then "THREE".
   - Save every stdout line to `spike/fixtures/claude-<ver>-turns.jsonl`.
2. **Pass:** three `result` events, all with the same `session_id`, and the replies contain ONE, TWO, THREE in order.
3. Also record: whether a `system/init` event arrives and what its `capabilities` field says; and how many seconds the first turn takes.

### P0.2 Claude: PreToolUse HTTP hook blocks an edit

1. Write `spike/hook-server.mjs`: a `node:http` server on `127.0.0.1:47123`.
   - For `POST /hook`, it logs the body.
   - If `tool_input.file_path` matches `migrations/`, it answers:
     ```json
     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by Reins: migrations/** is guarded."}}
     ```
   - Otherwise it answers `{}`.
2. Start `claude` as in P0.1, adding `--settings` with the inline JSON that points a `PreToolUse` `type: "http"` hook at the server.
3. Prompt: "Add a column retries to migrations/0001.sql."
4. **Pass:** `git diff migrations/` is empty, the stream shows the denial, and the agent's reply mentions the block.

### P0.3 Claude: a hook deny beats the user's allow rule

1. Repeat P0.2, adding `--settings` `"permissions": {"allow": ["Edit", "Write"]}`.
2. **Pass:** still blocked.
3. **If it fails:** guards must also go into the session's deny rules (`permissions.deny` with `Edit(migrations/**)`). Write down which one works.

### P0.4 Claude: an approval waits for Reins (permission-prompt-tool)

1. Write `spike/approve-mcp.mjs`: a stdio MCP server with one tool, `approve`, using `@modelcontextprotocol/sdk` (the dependency Knowl already uses; `npm i` it inside `spike/` only).
   - It writes each request to `spike/pending/<id>.json`.
   - It waits until `spike/pending/<id>.answer` exists, which you create by hand, then returns `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}`.
2. Run `claude` with `--permission-prompt-tool mcp__approve__approve --mcp-config <inline>` and the prompt "Edit src/upload.mjs to add a retry loop."
3. **Pass:** nothing changes until you answer. "deny" leaves the file as it was. "allow" applies the edit.
4. Also time it: hold for **120 s** before answering. **Pass:** no timeout. Write down any limit you find.

### P0.5 Claude: live card mid-turn through PostToolUse

1. Extend `hook-server.mjs`: `POST /card?text=…` queues a card. The next `PostToolUse` call answers with `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<card>"}}`.
2. Prompt: "Read every file in src/ and test.mjs one at a time, then summarise."
3. After the first tool event, queue: "Reins card: end your final answer with the word PINEAPPLE."
4. **Pass:** the final answer ends with PINEAPPLE.
5. Also test: SIGINT during a turn gives a `result` event, and the session can take another turn afterwards.

### P0.6 Codex app-server: turns, approval deny, steer, Windows

1. Write `spike/codex.mjs`:
   - Spawn `codex app-server`.
   - `initialize` with `{clientInfo:{name:"reins-spike",version:"0"}}`.
   - `account/read`, and save the auth mode.
   - `thread/start { cwd: scratch, approvalPolicy: <the strictest policy that still asks the client> }`.
   - `turn/start` "Reply ONE", then TWO, then THREE.
2. **Pass:** three `turn/completed` events.
3. Next turn: "Add a column retries to migrations/0001.sql." Answer `item/fileChange/requestApproval` with deny. **Pass:** the file is unchanged.
4. Next turn: the long multi-read prompt from P0.5. Send `turn/steer` with the PINEAPPLE card mid-turn. **Pass:** PINEAPPLE at the end.
5. Record everything to `spike/fixtures/codex-<ver>-*.jsonl`. **This all runs on Windows**, which is itself the check.

### P0.7 Knowl CLI

1. In the scratch repo, run `knowl init` (if not done), then `knowl store --category decision --title "Upload retry policy" --provenance observed "max 5 attempts…"` and `knowl query "upload retry" --limit 5`.
2. **Record:**
   - Does the output have a stable format, or is there a JSON flag?
   - Time for each call, averaged over 5 runs.
3. **Pass:** the stored item comes back from the query.

### P0.8 Findings

1. Write `docs/spike/2026-09-xx-engine-findings.md`: a results table, fixture list, CLI versions, every surprise, and a decision on K1.
2. Store the key findings in Knowl, one fact per finding, with `spike/` paths.
3. Update §8 of this plan where an **[assumed]** became true or false.
4. **Exit:** you read the findings and say go or no-go for Phase 1.

---

## 15. Phase 1: detailed tasks

**Where:** branch `feat/core` in its own worktree. **TDD:** each task writes the failing test first, runs it and sees it fail for the right reason, writes the code, sees it pass, then does one deliberate mutation and sees the test fail. Commit after each task.

### 1.1 Repo setup

**Files:** `package.json` (workspaces: `packages/*`, `engines.node >=22`, `type: module`), `tsconfig.base.json`, `packages/core/{package.json,tsconfig.json,src/index.ts}`, `vitest.config.ts`, `eslint.config.mjs` (copied from Knowl and trimmed), `.github/workflows/ci.yml` (typecheck, lint and test on three OSes).

**Dependencies:**
- `yaml` (frontmatter, already used by Knowl) and `picomatch` (globs).
- Dev only: `typescript`, `vitest`, `eslint`, `typescript-eslint`, `@types/node`.
- **Nothing else.**

**Check:** `npm test` runs zero tests and passes. `npm run typecheck` passes. CI is green on all three OSes.

### 1.2 The model

`packages/core/src/model.ts`, types only:

```ts
export type StepKind = 'phase'|'say'|'run'|'gate'|'repeat'|'if'|'verify'|'use'|'recall'|'store'|'handoff';
export type CardKind = 'guard'|'note'|'nudge'|'role'|'checkpoint'|'budget'|'undo';
export type LinkKind = 'next'|'on-pass'|'on-fail'|'retry'|'verify-against'|'hand-off';

export interface Pos { line: number; col: number }
export interface Card { kind: CardKind; text: string; pos?: Pos }
export interface Link { kind: LinkKind; to: string; max?: number; pos?: Pos }

export interface Step {
  id: string; kind: StepKind; title?: string; prompt?: string;   // prompt: the '>' lines, joined with \n
  attrs: Record<string, string>;                                   // kind-specific: mode, cmd, against, to, focus, knowl, max
  cond?: Cond; cards: Card[]; links: Link[];
  kids?: Step[]; else?: Step[]; pos?: Pos;
}

export type Cond =
  | { t: 'approve' } | { t: 'tests' } | { t: 'cmd'; cmd: string } | { t: 'llm'; q: string }
  | { t: 'review'; q?: string } | { t: 'done' } | { t: 'diff'; n: number } | { t: 'touches'; glob: string }
  | { t: 'attempts'; n: number } | { t: 'same' } | { t: 'drift' }
  | { t: 'and' | 'or'; a: Cond; b: Cond } | { t: 'not'; a: Cond };

export interface AutoCard { id: string; cond: Cond; card: Card }
export interface Workflow {
  version: 1; name: string; task?: string; engine?: 'claude'|'codex'; model?: string; test?: string;
  budget: { turns: number; minutes: number; usd?: number };
  always: string[]; drift?: { repeat?: number; stagnation?: number };
  steps: Step[]; autos: AutoCard[];
}
export interface Diagnostic { severity: 'error'|'warning'; message: string; pos: Pos }
```

**Check:** it typechecks. No tests yet; it's types only.

### 1.3 The condition language

**Files:** `src/cond.ts` (`parseCond(src, basePos) → {cond}|{diag}`, `printCond(c)`), `test/cond.test.ts`.

**Tests:**
- Every atom in §5.4 parses.
- `and` binds tighter than `or`.
- `not` and brackets work.
- `print(parse(s)) === s` for the canonical form.
- Errors point to the right column, e.g. `diff > x lines` gives column 8.
- `judgeOf(cond)` returns the right judge for each atom.

**Mutation:** swap `and` and `or` precedence. The test must fail.

### 1.4 Parser and printer

**Files:** `src/format/parse.ts` (`parseWorkflow(text) → {workflow, diagnostics}`), `src/format/print.ts` (`printWorkflow(w) → string`), `test/format.test.ts`, `examples/{upload-retry,bug-fix,tdd-loop,safe-refactor}.reins.md` (ported from the mockup's four workflows), `examples/blocks/review-pass.reins.md`.

**How it parses:** a line scanner, no markdown library. It reads the frontmatter, then the headings (the heading depth decides nesting), then the attribute and `>` lines.

**Tests:**
- Each example parses with 0 diagnostics.
- `printWorkflow(parse(x)) === x` byte-for-byte for each example.
- Nesting three levels deep works.
- `else` splits branches.
- An unknown key gives an error at its line.
- `\r\n` input is accepted and printed with `\n`. This is a Windows check.
- A property test: 200 random trees give `parse(print(t)) == t`.

### 1.5 The validator

**Files:** `src/validate.ts` (`validate(w, resolveBlock) → Diagnostic[]`), `test/validate.test.ts`.

**Tests:** one test per rule in §5.5 (10 error rules, 3 warnings). Each asserts the message and the position. Plus: **a backward link without `max` is an error, and a forward one without `max` is fine.**

### 1.6 The compiler

**Files:** `src/compile.ts`, with `compileProgram(w, blocks) → Instr[]` (§6.1) and `compileTurn(step, ctx) → string` (§6.3). `test/compile.test.ts`, and golden files in `test/golden/*.txt`.

**Tests:**
- The instruction list for upload-retry matches §6.1's listing.
- `use` inlines the block with prefixed ids.
- The golden text for each step of upload-retry.
- The user's prompt appears **unchanged** inside the output.
- An enforced guard says "(Enforced…)".
- The status-line instruction is always the last line.

### 1.7 The run engine

**Files:** `src/run.ts` (`class Run` with `step()`, `approve()`, `allowMore()`, `queueCard()`, `edit(newWorkflow)`, `snapshot()` / `Run.restore()`), `src/fake-engine.ts`, `test/run.test.ts`.

`FakeEngine` takes a script: per turn, the events to emit and the final text. It records every text it was sent and every policy check it was asked.

**Tests:** one test each.
- Read-only step: a scripted write gets denied, and a refusal is logged.
- Gate: the run pauses, `approve()` resumes it, and the next turn gets the implement text.
- Loop: fails 5 times, pauses with `budget-used`, `allowMore(2)` goes on, passes on attempt 6.
- `on-fail` link jumps back and counts towards its link budget. Once the budget is used up it pauses.
- Verify quotes the plan step's final output, not its prompt.
- A card queued mid-turn gets delivered at the next tool event. One queued after the last tool event gets delivered in the next turn's text.
- An auto card `same error twice` fires once, re-arms after a pass, and fires again.
- Live edit: a step added after the current one runs; deleting the current step pauses the run.
- `snapshot` then `restore` in the middle of a loop continues with the same counters.
- Run budget: the turn limit pauses the run.
- Stop: interrupts the engine, and the receipt is written.

### 1.8 Drift rules and the receipt

**Files:** `src/drift.ts` (one pure function per rule in §7.5), `src/receipt.ts` (`receipt(events) → Receipt`), and tests.

**Tests:** each rule fires on a scripted bad trace and stays quiet on a clean trace. The receipt counts match a hand-counted event log for the full upload-retry run.

### 1.9 Phase 1 exit

**Check:** `npm test` is green on three OSes. All four example workflows run end to end on `FakeEngine` and give the expected receipts. Commit. Write the Phase 2 task list (like this section) for review.

---

## 16. Risks, in order of danger

| # | Risk | What we do |
|---|---|---|
| 1 | **Claude CLI flags or hook behaviour change.** They move fast: this doc cites features from v2.1.199–2.1.275. | Recorded fixtures with the version in the file name. `reins doctor` knows the tested version range and warns outside it. The live E2E suite runs before each release. We use each `system/init` capability flag where one exists. |
| 2 | **Anthropic changes the terms for hosting the CLI.** | We only use what the terms allow today (unmodified binary, user's own login). Codex is a second engine, and an Agent SDK (API key) adapter is a documented fallback. |
| 3 | **The UI takes longer than planned** (Phases 3–4). | The terminal runner (Phase 2) is useful on its own and gets dogfooded first. K3 can shrink the editor. |
| 4 | **Judging is unreliable.** An LLM judge says yes too easily. | Command and deterministic judges come first and are free. LLM and reviewer judges are opt-in, show their evidence in the receipt, and default to "no" on anything unclear. |
| 5 | **Turn-per-step loses context or costs more.** | Same session, so the context carries over. Measure turns and cost in K2. Merge steps that don't need a boundary (`say` right after `phase`) if it costs too much. |
| 6 | **Someone ships the same thing first** (LivePlan-style monitors, `/goal`). | Our edge is the whole set: workflow + enforcement + live cards + receipt + memory. Ship the terminal runner early (Phase 2) and talk about it. |
| 7 | **A workflow file from a cloned repo runs commands.** | The trust prompt (§5.6). Nothing runs until you trust it. |
| 8 | **Windows.** Paths, signals, and `.cmd` shims for `claude`, `codex` and `knowl`. | CI on Windows from day 1. The spike runs on Windows. Spawn with `shell: false` and resolve `.cmd` shims explicitly (Knowl already does this: `knowl.cmd`). |

---

## 17. What changes in CONTEXT.md

CONTEXT.md is local and gitignored. After you approve this plan, update it:
- **§11 build order:** replace it with §13 of this plan.
- **§12b stack:** replace it with D1. The only Rust left is an optional future desktop wrapper.
- **§14 kill switches:** replace them with §13.1 (control and rework, not pass rate).
- **§15 "graph is never the runtime truth":** it becomes *"the graph compiles to text for each step; the engine is a live controller."*
- Add the §2 D4 login rule and the reason (Anthropic's terms).

---

## 18. Self-review notes (fixed before handing over)

- **Placeholders:** none left.
  - Phase 0 file names use `<ver>` and `xx` on purpose, because they are filled in when the tests run.
  - Q1–Q7 each have a default, so none of them blocks work.
- **Contradictions:**
  - D6 (turn per step) and §6.5 (mid-turn cards) agree. Cards use mid-turn channels, and steps use turn boundaries.
  - §8.2 enforcement goes through hooks, and approvals go through the prompt tool. P0.3 decides whether guards also need deny rules.
- **Scope:** too big for one implementation plan, so Phases 2–7 each get their own task list after the phase before them. This document fixes their design and exit tests only.
- **Things only a run can settle:** every **[assumed]** tag, all of them in §8 and all covered by Phase 0.
