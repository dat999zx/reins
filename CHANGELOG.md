# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions: [SemVer](https://semver.org).

## Unreleased

- A parallel run can be started from the rail: name a tasks file, read what it will run, press Start. The group shows its phase; Merge runs the merge and the gate on the server, and Clean closes the sessions and removes the worktrees and branches.
- A tasks file names its own commands: `install`, `gate`, `gateRetry` and `reports`. Absent means skip.
- After a server restart, a run caught in setup, merging or gating reads `interrupted`, and Merge or Clean go on from there.
- `parallel.mjs` is now a client of the server: `start` prints a run id, `status`, `merge`, `clean` and `run` take it, and there is no `state.json`. A task needs a playbook. `clean` needs a running server. `start` shows the commands and asks first, unless `--yes`.
- A parallel run may be started with `"approve": "fence"`: reads and edits whose real path is inside the task's folder, and a short list of whole commands (tests, eslint, tsc, `npm run typecheck|lint|selfcheck`, read-only git) naming nothing outside it, are answered yes and marked `auto: fence`; everything else stays a card, and MCP calls are refused. It is not a sandbox: an approved test or lint run executes code the agent wrote.
- `parallel.mjs run <tasks.json>`: start, wait, merge, gate and clean in one command, with a report. Exit 3: a card waits a minute; 4: the gate failed; 5: `--max-minutes` reached; 6: a task was not merged (nothing is cleaned then).
- `parallel.mjs run` retries a failed gate once on the files that failed (a load flake passes alone), and a second `run` on the same state counts tasks that are already merged as merged, so it can finish after a failed gate.
- A task in a `parallel.mjs` tasks file may name `model` and `effort`; an unknown name refuses the whole run before any session starts.
- `parallel.mjs clean` closes each task's session first, so on Windows it no longer needs a server restart to remove the worktrees; a folder still in use is named, and clean can run again.
- `parallel.mjs clean` keeps a worktree that still has uncommitted changes and says so, instead of deleting the work.
- Resume all now continues a task that Stop all paused, or whose step failed: it answers the task's resume question. A task waiting on any other question is left for you.
- CI runs the script selfchecks (`npm run selfcheck`).
- Parallel runs (M5): the tasks of one `scripts/parallel.mjs` run are one group at the top of the rail, with the total cost, a USD cap, Stop all and Resume all.
- The cap is a backstop, not a budget: once the total reaches it no new model call starts, and calls already running finish. A refused task shows the cap words, and Resume carries on after you raise the cap.
- A parallel task cannot write outside its own worktree. For a shell command, Reins checks the paths the command names.
- After a restart the group is back, and Resume all names any worktree that is gone. `parallel.mjs clean` forgets the group.
- The rename (M4): what Reins called a workflow is now called a **playbook**, in the app, in messages and errors, in `reins` output and help, in the import and export summaries and in the docs. The block that runs one playbook inside another keeps its name, `playbook`. Nothing else changed: the `.reins.md` file extension, the `.reins/workflows/` folder, the API routes, the file format and the share file keep their names, so every file you have still opens. In older notes, "workflow" means playbook.
- Mods can add blocks, conditions and cards (Milestone M2). A mod lists everything it adds in its `mod.json`, and Reins refuses anything it does not list. Its code runs only after you trust it, and a changed file asks again. `packages/server/src/mods/README.md` is the guide.
- A block mod can have no code. Its prompt is a template in `mod.json`, filled from the step's attributes. The step's mode still applies. The toy-ask example is in the guide.
- A block, condition or card that is already in use keeps its old version until a restart. Settings says so when a changed mod waits for one. A mod that is not registered yet registers at once.
- Import and export show what a kind mod adds before any of its code runs.
- The block list comes from the server (`GET /api/kinds`). A mod's block shows up in the app without a change to the app. A block of an unknown kind is drawn as "unknown block".
- Parallel tracks in the engine: a run can hold several tracks at once. The fork block and a playbook with `session: own` use them.
- Each track has its own pauses and its own money. Allow answers for the track that paused.
- The run view shows each track on its own, with its title, its pause, and its own row in the receipt.
- Cost chips on the canvas no longer cover blocks or arrows.
- Playbook: a new block that runs another playbook file from the blocks folder, with inputs and outputs, in the same conversation or, with `session: own`, in a conversation of its own with an optional USD budget (without one it is capped at what is left of the budget of the playbook that uses it, and inside a fork branch at what is left of the branch's share). Inputs are filled into the playbook's prompts, commands and conditions before the run, so the commands you trust are the ones it runs. An `end` inside a playbook ends only the playbook.
- The use block (`## use`) is removed: a playbook does what it did. A file that still has one gets an "Unknown step kind" error; change the line `## use X` to `## playbook X`.
- Fork: a new block that runs several branches at the same time. Draw a `next` wire from the fork to the first block of each branch (in the file, one `next:` line each). Each branch is a track with its own conversation (it starts with the last reply quoted), its own approvals and its own share of the USD budget (an equal part, rounded up to a millionth of a dollar). A track a branch starts, such as an own playbook, spends from that branch's share, so the branches together stay inside the budget. The block under the fork gets every branch's last reply, quoted, in the order of the wires. Stop reaches every branch, and a branch that fails pauses alone: the others finish, and Resume tries it again. Branches share the project folder, so two branches that can both write get a warning.
- The built-in blocks are now the default pack. `phase`, `say`, `run`, `gate`, `repeat`, `if`, `verify`, `recall`, `store`, `model`, `subagent`, `end`, `fork` and `playbook` are 14 mods that ship with Reins, and so are the 11 conditions and the 3 cards (one folder each, 28 in all). Core registers no block, condition or card. Settings > Providers lists them, and you can switch one off. `phase` and `end` are required and have no off switch. A playbook that uses a block you switched off fails its check.
- Customize: a button on the row of a pack mod. It copies the mod's files into `~/.reins/mods/<id>/` (without the `pack` and `required` words), asks for trust as any import does, and the copy takes the built-in's place after a restart. Change the copy's files by hand. Remove the copy and the built-in is back. When a later Reins ships a newer built-in than your copy, the row says "the built-in is newer".
- Canvas chains: free blocks that run on into each other are drawn as one connected chain, joined like the stack, with no `then` arrow between them. Detaching a block from a chain puts an `end` in front of it when the block above would run on into it.
- **Visible change:** the grey `next` handle is now only on the fork. Plain blocks no longer have it, so the canvas can no longer draw a wire from a plain block to a block above it. To go back and try again, use `repeat` with `until`. A file with a `next:` line on a plain block still loads, draws a grey arrow, can be deleted and runs as before.
- Share and import of one file: **Share** in the playbook menu of Text exports the saved playbook together with the mods it uses (your own mods and your Customize copies, never the built-in blocks) as one `<name>.reins-mods.json` file, and **Export my mods** in Settings > Providers does the same for your mods. Import shows one preview for the whole file and asks one trust question for each mod with code. The install is all or nothing: a refused file leaves nothing behind. Playbook files (the `blocks/` folder) are not carried; the importer needs them.
- New guides: `packages/server/src/mods/PACK.md` covers the default pack, Customize, how to write a block, a condition, a card and a playbook (each with an example that is run by a test), the `fork` block and the Share file. `packages/core/src/nodes/README.md` is rewritten for blocks as mods, and the `api.core` list in `packages/server/src/mods/README.md` now names all nine functions.
- A share of the USD room (fork branches) is rounded up to a millionth of a dollar, not to a cent: `$1.00` over 3 branches is `0.333334` each.

- Providers are mods (Milestone P). A provider is one folder in `~/.reins/mods/<id>/` with a `mod.json`: any endpoint and any API key works through the two built-in chat protocols, and a new API is a code mod (a protocol) that you write and trust. Settings > Providers lists them with their status, and has Test connection, Set key, Edit, Disable, Export and Remove. `packages/server/src/mods/README.md` is the guide.
- Money and the wire, final fixes: a reply with no usage, or a call that failed after the provider began to answer, is an unknown cost (never $0), so a USD budget stops honestly; a stream cut before its end is tried again and not kept; the cost of an automatic compression counts against the run at once, even when the reply after it fails; a changed price, path, header or body on the same address is used from the next reply; the extras of one provider are not sent to another; a reply is cut at 4 MiB or 30 minutes; a provider's `body` cannot change the model, messages, tools or stream settings.
- Reins has its own agent loop for API providers: Read, Write, Edit, Glob, Grep and a shell tool (Bash, or PowerShell on Windows), with the same approval cards, budget and receipt as a Claude Code session. The conversation is a file in `~/.reins/conversations/` and is kept when you switch between two API providers. These sessions read `AGENTS.md`, not `CLAUDE.md`. The file tools stay in the project folder (outside it they ask); the shell is not confined to it, so the approval is the guard.
- A first-run chooser offers the catalog of 11 providers. Every one is marked untested until someone has run it, and a price is shown only where a source is known. Programs on your own machine are pre-ticked and are looked for only on local addresses, only on the first run.
- Export and import: a mod exports as one JSON file with no key in it, and an import shows a preview first. A mod with code is imported but does not run until you trust it. Trust is by hash and asks again when any file changes.
- Consent and keys: before Reins sends your prompts and a key to an address, it asks once for that provider and address. Keys are stored in plain text in `~/.reins/secrets.json` (an environment variable always works instead). They are kept out of the shell tool and playbook commands, and hidden in the log, the events, the conversation file and exports.
- The built-in `claude` provider is renamed `claude-code`. Sessions made before are moved to the new name when Reins starts, and keep their conversation. Everything is local: Reins itself sends nothing anywhere except to a provider address you said yes to.
- Each block is now a mod: a folder with a `mod.json` (which holds the block's face as data) and an `index.js`. Adding a block takes no edit in core, the server or the app. Files, runs, the receipt and the terminal output are unchanged.
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
- The `model:` and `engine:` lines of a playbook's front matter are removed (a session ignored them). A file that still has them opens; they are dropped the next time it is saved from Blocks. `reins run` takes the model from `--model` only. The model of a `## model` or `## subagent` block is unchanged.
- The model block is shown as "switch model" in Blocks (its face reads "switch model to <model> USD <amount>"); the file keyword `## model <id>` is the same.
- A subagent block (`## subagent <title>`, a prompt, optional `model:`, `usd:` and `mode:`) runs its task in a Claude session of its own, on its own model, and hands its result to the next phase or say step as a note, quoted as the subagent's output (a later verify that compares `against:` the subagent receives its result quoted as data). The parent's conversation gets only the result. Blocks has a subagent card, a face with its title, model and USD, and a panel with its prompt, mode, a Model picker that defaults to the session's model, and Budget (USD).
- A subagent's cost counts after each of its replies against its USD budget and the playbook's. Claude's own spending cap ends it after the reply that crosses what is left (so a subagent's reply can run past its slice by up to one reply, and Reins counts it), and the run then pauses on the Allow $ / Stop card. Allow continues the same subagent session. Stop, closing the session or a server stop never leaves a subagent process running. A reply cut off by a crash is not counted: the provider drops it.
- A subagent's tool request is a card on the run, titled with the subagent. The same holds for a tool request from a task the model starts with Claude's own Agent tool (titled `Task <description>`). The setting `subagentApprovals` (`"ask"` or `"deny"`, in the `settings` table of Reins' database; there is no Settings form yet) refuses such requests instead, with a note in the log. The receipt shows the dollars and turns per subagent, and the feed shows when a subagent starts and what it handed back.
- Format: a `model:` line on a step that does not use it is now a warning (it was an unknown-attribute error), and `## model` with a `model: <id>` line is read as `## model <id>`.
- A model block (`## model <id>`, with an optional `usd: 0.50` line) switches the session's model from that step on, through the same limits and Switch / Keep the current model card as the header. The run waits on the card, Stop stops the run, a server stop leaves it resumable (Resume asks the switch again), and an unknown model id refuses the run before it starts. In Blocks it is a palette card with the model and its USD on its face, a Model picker fed by the session's catalog, and a Budget (USD) field that refuses a wrong value in words.
- Block USD budgets are carved out of the playbook's USD budget: slices that add up to more than it are refused when the file is validated. A playbook with no USD budget has no USD limit, and a block's budget is then a limit of its own. USD is now enforced after each reply: a block's slice or the playbook's budget pauses the run on an Allow $ / Stop card, and a block's allowance is capped at what the playbook has left. A step's replies can go past the limit, because the check runs between steps. The meter shows the open slice, and the dock names the model each block ran on.
- The receipt and `reins run` show dollars and turns per model, and the parts add up to the total (a reply with no per-model figures is shown as "not split by model"). Reins keeps each Claude session's per-model totals, so a switch, a restart or a resume counts each model once.
- Budget form: Turns, Minutes and USD are editable in the Playbook panel (Blocks) and in the Text view. Turns are enforced, and so is USD (below); minutes are shown, not enforced. Leave USD empty for no dollar limit.
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
- New step kind `end` (`## end`): stops the playbook; steps after it run only when a link jumps to them.
- Blocks is now one pan and zoom workspace: drag the background to pan, wheel to zoom, Shift+drag to box-select. Scratch-style blocks snap into a stack; steps after an `end` are free blocks joined by drawn links. Loose blocks park ideas outside the file. Undo and redo, copy and paste, right-click menus and keyboard routes for every action.
- The Map tab is gone; tabs are Chat, Blocks and Text.
- `reins --version` (and `-v`) prints the version.
- A command a playbook runs is still stopped after 10 minutes, but you can raise that: start Reins with `REINS_COMMAND_TIMEOUT_MIN=<minutes>` in its environment. A missing, zero, negative or non-numeric value keeps 10 minutes. A long test gate can now pass through a `run` block or a `tests pass` condition.
- For contributors: `npm run test:affected` runs only the test files whose inputs changed since they last passed (committed or not), re-runs only the files that failed, and takes `--jobs N` to run N vitest processes at once (the full suite took 393 s with 4 jobs against 1262 s with 1 on a 12-CPU machine). `node scripts/parallel.mjs` runs several tasks at the same time, each in its own git worktree and its own Reins session, then merges them in order and stops on the first conflict. Neither is part of the shipped package.

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
