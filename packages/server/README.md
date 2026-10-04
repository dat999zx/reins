# reins

Scratch for agent loops. Write a workflow as a `.reins.md` file (phases, gates, loops with budgets, live cards), and Reins drives Claude Code through it while you steer from the browser.

```
npm i -g reins
reins                 # opens the app in your browser
reins run flow.reins.md
reins check flow.reins.md
reins doctor
```

Needs Node 22.12+ and Claude Code installed and logged in.
