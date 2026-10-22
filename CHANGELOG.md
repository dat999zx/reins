# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions: [SemVer](https://semver.org).

## Unreleased

- Mods can add blocks, conditions and cards (Milestone M2). A mod lists everything it adds in its `mod.json`, and Reins refuses anything it does not list. Its code runs only after you trust it, and a changed file asks again. `packages/server/src/mods/README.md` is the guide.
- A block mod can have no code. Its prompt is a template in `mod.json`, filled from the step's attributes. The step's mode still applies. The toy-ask example is in the guide.
- A block, condition or card that is already in use keeps its old version until a restart. Settings says so when a changed mod waits for one. A mod that is not registered yet registers at once.
- Import and export show what a kind mod adds before any of its code runs.
- The block list comes from the server (`GET /api/kinds`). A mod's block shows up in the app without a change to the app. A block of an unknown kind is drawn as "unknown block".
- Parallel tracks in the engine: a run can hold several tracks at once. No shipped block uses them yet.
- Each track has its own pauses and its own money. Allow answers for the track that paused.
- The run view shows each track on its own, with its title, its pause, and its own row in the receipt.
- Cost chips on the canvas no longer cover blocks or arrows.

- Providers are mods (Milestone P). A provider is one folder in `~/.reins/mods/<id>/` with a `mod.json`: any endpoint and any API key works through the two built-in chat protocols, and a new API is a code mod (a protocol) that you write and trust. Settings > Providers lists them with their status, and has Test connection, Set key, Edit, Disable, Export and Remove. `packages/server/src/mods/README.md` is the guide.
- Money and the wire, final fixes: a reply with no usage, or a call that failed after the provider began to answer, is an unknown cost (never $0), so a USD budget stops honestly; a stream cut before its end is tried again and not kept; the cost of an automatic compression counts against the run at once, even when the reply after it fails; a changed price, path, header or body on the same address is used from the next reply; the extras of one provider are not sent to another; a reply is cut at 4 MiB or 30 minutes; a provider's `body` cannot change the model, messages, tools or stream settings.
- Reins has its own agent loop for API providers: Read, Write, Edit, Glob, Grep and a shell tool (Bash, or PowerShell on Windows), with the same approval cards, budget and receipt as a Claude Code session. The conversation is a file in `~/.reins/conversations/` and is kept when you switch between two API providers. These sessions read `AGENTS.md`, not `CLAUDE.md`. The file tools stay in the project folder (outside it they ask); the shell is not confined to it, so the approval is the guard.
- A first-run chooser offers the catalog of 11 providers. Every one is marked untested until someone has run it, and a price is shown only where a source is known. Programs on your own machine are pre-ticked and are looked for only on local addresses, only on the first run.
- Export and import: a mod exports as one JSON file with no key in it, and an import shows a preview first. A mod with code is imported but does not run until you trust it. Trust is by hash and asks again when any file changes.
- Consent and keys: before Reins sends your prompts and a key to an address, it asks once for that provider and address. Keys are stored in plain text in `~/.reins/secrets.json` (an environment variable always works instead). They are kept out of the shell tool and workflow commands, and hidden in the log, the events, the conversation file and exports.
- The built-in `claude` provider is renamed `claude-code`. Sessions made before are moved to the new name when Reins starts, and keep their conversation. Everything is local: Reins itself sends nothing anywhere except to a provider address you said yes to.
- Each block now lives in its own files (a node and a view); adding a block takes two files and one line. Files, runs, the receipt and the terminal output are unchanged.
- The Chat renders the agent's markdown (headings, lists, tables, code, links), in its replies, its reasoning and a subagent's result.
- A verify (and a knowl store) now gets the subagent results like a plain step, and a verify against a step that never ran says so.
- A subagent starts with the results of the subagents before it (a thinker's answer reaches the writer). The parent still gets every result on its next turn.
- The Chat shows the agent's reasoning (summarized) in a collapsible block, open while it thinks and collapsed after. A subagent's reasoning, tool calls and text are kept in the feed under its step.
- The engine now asks the CLI for thinking summaries (`--thinking-display summarized`).
- Reasoning: the session header has a Reasoning picker (Low, Medium, High, Extra high, Max; a new session starts on Medium) that applies from the next reply, and a subagent block and a switch model block take a `reasoning:` line with the same Reasoning picker on their face and panel (empty is the session's). Claude ignores a level it does not know with a warning.
- The hand-off block (`## handoff`) is removed: it only asked the same session for a summary, and its `to:` delivered nothing. A file that still has one gets an "Unknown step kind" error.
- A block's cards are guards only. The cards nudge, role, checkpoint, budget, undo and note are removed (a note is just the prompt); a file with one of those lines gets an "Unknown attribute" error. A `whenever` block holds a `now:` or `stop:` card, so it can only interrupt with `now` or `stop`. Blocks' panel says Guards and has an Add guard button, and a block face shows `guard: <glob>`.
- The Links section of a block's panel no longer adds links (draw them on the canvas); it keeps the list with each link's max and its remove button, and is not shown when a block has no links.
- Link kinds `on-pass`, `retry`, `verify-against` and `hand-off` are removed; a file that uses one gets an "Unknown attribute" error. `next` and `on-fail` remain.
- The `model:` and `engine:` lines of a workflow's front matter are removed (a session ignored them). A file that still has them opens; they are dropped the next time it is saved from Blocks. `reins run` takes the model from `--model` only. The model of a `## model` or `## subagent` block is unchanged.
- The model block is shown as "switch model" in Blocks (its face reads "switch model to <model> USD <amount>"); the file keyword `## model <id>` is the same.
- A subagent block (`## subagent <title>`, a prompt, optional `model:`, `usd:` and `mode:`) runs its task in a Claude session of its own, on its own model, and hands its result to the next phase or say step as a note, quoted as the subagent's output (a later verify that compares `against:` the subagent receives its result quoted as data). The parent's conversation gets only the result. Blocks has a subagent card, a face with its title, model and USD, and a panel with its prompt, mode, a Model picker that defaults to the session's model, and Budget (USD).
- A subagent's cost counts after each of its replies against its USD budget and the workflow's. Claude's own spending cap ends it after the reply that crosses what is left (so a subagent's reply can run past its slice by up to one reply, and Reins counts it), and the run then pauses on the Allow $ / Stop card. Allow continues the same subagent session. Stop, closing the session or a server stop never leaves a subagent process running. A reply cut off by a crash is not counted: the provider drops it.
- A subagent's tool request is a card on the run, titled with the subagent. The same holds for a tool request from a task the model starts with Claude's own Agent tool (titled `Task <description>`). The setting `subagentApprovals` (`"ask"` or `"deny"`, in the `settings` table of Reins' database; there is no Settings form yet) refuses such requests instead, with a note in the log. The receipt shows the dollars and turns per subagent, and the feed shows when a subagent starts and what it handed back.
- Format: a `model:` line on a step that does not use it is now a warning (it was an unknown-attribute error), and `## model` with a `model: <id>` line is read as `## model <id>`.
- A model block (`## model <id>`, with an optional `usd: 0.50` line) switches the session's model from that step on, through the same limits and Switch / Keep the current model card as the header. The run waits on the card, Stop stops the run, a server stop leaves it resumable (Resume asks the switch again), and an unknown model id refuses the run before it starts. In Blocks it is a palette card with the model and its USD on its face, a Model picker fed by the session's catalog, and a Budget (USD) field that refuses a wrong value in words.
- Block USD budgets are carved out of the workflow's USD budget: slices that add up to more than it are refused when the file is validated. A workflow with no USD budget has no USD limit, and a block's budget is then a limit of its own. USD is now enforced after each reply: a block's slice or the workflow's budget pauses the run on an Allow $ / Stop card, and a block's allowance is capped at what the workflow has left. A step's replies can go past the limit, because the check runs between steps. The meter shows the open slice, and the dock names the model each block ran on.
- The receipt and `reins run` show dollars and turns per model, and the parts add up to the total (a reply with no per-model figures is shown as "not split by model"). Reins keeps each Claude session's per-model totals, so a switch, a restart or a resume counts each model once.
- Budget form: Turns, Minutes and USD are editable in the Workflow panel (Blocks) and in the Text view. Turns are enforced, and so is USD (below); minutes are shown, not enforced. Leave USD empty for no dollar limit.
- A model switch over a limit (a context of 200,000 tokens or more, or an estimate of $0.50 or more) now asks with a Switch / Keep the current model card instead of refusing. The card shows the tokens and the estimate with its price source, and has no timeout. Auto-approve never answers it; any new work, Stop while idle, or closing the session leaves the model as it was.
- Compress: a button in the session header and `/compress` in the Composer summarise the conversation to free context (it costs one model call). The feed says how many tokens of conversation remain, and the meter shows that figure as a lower bound (`Context ≥5k / 1M`) until the next reply measures the full context.
- Auto-compress: before a reply, a session compresses by itself when its known context is at or over 90% of the window. The setting is `autoCompressAt` (0 to 1; 1 turns it off). If the context is still over after compressing, it does not compress again before that reply.- The session header shows the model in use and the context used of its window (`Context 31k / 1M`), and switches the model while the session is idle. A switch asks with a Switch / Keep card when the context is 200,000 tokens or more or the estimated cost of the first reply on the new model is $0.50 or more (both are settings).
- The model list, context windows and prices follow Hermes: a models.dev catalog, cached on disk for 4 hours, adds models after the provider's own list, a catalog-only model can be chosen, and its price is the catalog's input price times the provider's cache-write multiple. The estimate says where its price came from.
- Each turn's cost is counted once across model switches, restarts and resumed sessions; a session from before this change shows its first reply's cost as unknown.
- The run panel floats in Blocks and Chat: its handle sits in the editor bar or the Composer bar, its body floats over the canvas or the log instead of moving them, a waiting question shows on the handle, Escape closes it, and only one Stop shows while a card offers its own.
- Watch a run live in all three tabs. Chat is now a feed: a rein runs down the left with a knot for each step (running, waiting for you, done, failed), the agent's tools and text hang under its knot, finished steps fold to one line, and "Jump to live" brings you back to the end. Knots and blocks link both ways ("Blocks ↗", "Show in Chat").
- Blocks shows the run: each block carries its state in words and colour, a stopped, failed or paused run is marked where it ended, the arrows the run took are drawn heavier, and Follow keeps the running block in view until you move the canvas.
- A run dock on Blocks: status, turns, minutes and dollars, the open question or gate card, Run without leaving the tab, a steer box with Now and Stop, queued cards, and a note when you save a file during a run (it applies to the next run).
- The agent's thinking shows as a live token count ("thinking… ~1,509 tokens"), not as text.
- The page title reads "(N) waiting · Reins" when a session needs you. Two sessions at once keep their runs, docks and feeds apart.
- Runs log `step_started` for every step and `command_result` for run steps, and `run_started` lists the steps, so the app can show which block is running and which one failed. Old logs without the list still open.
- New step kind `end` (`## end`): stops the workflow; steps after it run only when a link jumps to them.
- Blocks is now one pan and zoom workspace: drag the background to pan, wheel to zoom, Shift+drag to box-select. Scratch-style blocks snap into a stack; steps after an `end` are free blocks joined by drawn links. Loose blocks park ideas outside the file. Undo and redo, copy and paste, right-click menus and keyboard routes for every action.
- The Map tab is gone; tabs are Chat, Blocks and Text.
- `reins --version` (and `-v`) prints the version.

## 0.1.2

- Fix `npm i -g reins-ai`: `yaml` and `picomatch` were installed empty, so `reins` crashed on start. They are now bundled.

## 0.1.1

- Published as `reins-ai` (npm refused `reins`); the command is still `reins`.
- Releases are published from a version tag by CI.

## 0.1.0

First release.

### Workflows
- `.reins.md` format: frontmatter (name, task, budget, `always` rules) and steps `phase`, `say`, `turn`, `run`, `gate`, `verify`, `if` / `else`, `repeat`, `recall`, `store`, `handoff`, `use`.
- Conditions: `tests`, `cmd`, `diff`, `touches`, `same`, `attempts`, `drift`, `done`, `approve`, `llm`, `review`.
- Wires: `next` is a real jump; `on-fail` retries with a budget; a paused link resumes with `allowMore`.
- `whenever <condition>` auto cards and nine live cards (`nudge`, `role`, `guard`, `checkpoint`, `budget`, `stop`, `undo`, `note`, `now`).
- Validator: unknown steps, bad globs, dead wires, unreachable steps. A printer that round-trips the parser.
- Mandatory loop and run budgets; a receipt for every run.

### CLI
- `reins`, `run`, `check`, `print`, `doctor`, `serve`. Claude Code engine, with enforced guards, a trust prompt for commands, and run resume.

### App
- Chat, Canvas, Blocks and Text views of one file, with a Block panel, saved layout, live step state, and the open file and tab restored per folder.
- Native folder picker; two sessions side by side.

### Not yet
- Codex and other engines (Claude Code only).
- Desktop installer.
