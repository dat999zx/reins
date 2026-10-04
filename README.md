# Reins

**Scratch for agent loops.** Write a coding agent's workflow as a text file: phases, gates, loops with budgets, rules. Reins drives Claude Code through it, and you steer from the browser while it runs.

Prompt files (`CLAUDE.md`, rules, skills) have no control flow. You type "repeat until the tests pass" or "don't start coding until I approve the plan" and hope. In Reins those are a `repeat`, a `gate`, a `guard`, and they are enforced.

```
npm i -g @dat999zx/reins
reins                  # starts the app and opens your browser
```

Needs **Node 22.12+** and [Claude Code](https://claude.com/claude-code) installed and logged in. Run `reins doctor` to check.

## A workflow

A workflow is a `.reins.md` file. It is plain text, so it diffs, merges and lives in git.

```md
---
reins: 1
name: bug-fix
task: "fix: uploads over 5 GB fail"
budget: { turns: 80, minutes: 60, usd: 4.00 }
always:
  - Reproduce the bug before changing code.
---

## phase reproduce
> Write a test that reproduces the bug. It must fail for the right reason.

## gate
until: not tests pass

## repeat
until: tests pass
max: 4

### phase fix
> Make the smallest change that makes the test pass.

### run `npm test`

## if diff > 300 lines or touches src/core/**

### gate
until: you approve
```

Put workflows in `<project>/.reins/workflows/` or `~/.reins/workflows/`. More in [`examples/`](https://github.com/dat999zx/reins/tree/main/examples).

## The pieces

| | |
|---|---|
| **Steps** | `phase`, `say`, `turn`, `run` (a shell command), `gate`, `verify`, `if` / `else`, `repeat`, `recall`, `store`, `handoff`, `use` (reuse a block) |
| **Conditions** | `tests`, `cmd`, `diff`, `touches`, `same`, `attempts`, `drift`, `done`, `approve`, `llm`, `review`, joined with `and` / `or` / `not` |
| **Wires** | `next` jumps to a step, `on-fail` goes back and retries (with a max) |
| **Auto cards** | `## whenever <condition>` fires a card by itself, e.g. `whenever attempts > 3` |
| **Live cards** | Drop onto a running session: `nudge`, `role`, `guard`, `checkpoint`, `budget`, `stop`, `undo`, `note`, `now` |
| **Budgets** | Every loop has a `max`; the run has turns, minutes and dollars. Each run ends with a receipt |

Reins checks a workflow before it runs (unknown steps, bad globs, dead wires, unreachable steps).

## The app

`reins` opens a local web app with four views of the same file:

- **Chat**: the live session, questions (approve a gate, trust a command), cards.
- **Canvas**: boxes and wires. Drag to rewire, click a box to edit it in a side panel.
- **Blocks**: the steps as a nested list. Add from a palette, drag to move.
- **Text**: the file itself. The other views edit this text, nothing else.

Each step shows its state while a run goes. Two sessions can run side by side.

## Command line

```
reins                           start the app
reins run <file>                run a workflow in the terminal
  --engine claude  --model <m>  --effort <e>  --yes
reins run --resume <runId>      pick a run back up
reins check <file>              validate a workflow
reins print <file> [--write]    print it in standard form
reins doctor                    check Node, SQLite and Claude Code
reins serve [--port <n>]        the local server, without opening a browser
```

## Safety

- The server listens on `127.0.0.1` only and needs the token from the link `reins` prints.
- `run` commands need your OK the first time. A change to the project's `.claude/` hooks or MCP config asks again.
- State (runs, sessions) is one SQLite file in `~/.reins/`.

## Status

Early (0.1). Works with Claude Code only; a Codex adapter is planned. See the [CHANGELOG](https://github.com/dat999zx/reins/blob/main/CHANGELOG.md).

## Develop

```
git clone https://github.com/dat999zx/reins && cd reins
npm ci
npx playwright install chromium   # for the browser smoke test
npm run build && npm test
```

Three packages in `packages/`: `core` (format, engine), `server` (CLI, HTTP, Claude adapter; published as `reins`), `app` (the UI).

## License

[MIT](LICENSE)
