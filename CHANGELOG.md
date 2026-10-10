# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions: [SemVer](https://semver.org).

## Unreleased

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
