# sandcastle status - what a run is doing

This continues SKILL.md: run its "Before every action" first.

`sandcastle status 0` prints a snapshot; `sandcastle status` refreshes every 10 s (run it in a
separate pane or terminal). For a run that has ended, `sandcastle report` prints its closing
summary: hand it back as run.md's "Close the run" step says. Done when the user has the snapshot
and, for every row that needs them, its cause read from the log.

While a run is live, every ticket it holds is shown from the run's own record
(`.sandcastle/logs/run.json`, `tickets`), and the header counts add up to the run: working, ready
to land, need you, queued, blocked, merged. The states:

- **Working** - `setup`, `impl`, `resolve`, `review`, `codex`, `gates` (with the gate running,
  `2/7 pytest`, or `waiting for a gates slot`), `repair`, `landing`. AGE in red and `usually 5m`
  mean the step has taken twice its usual time, and `3x over, usually 5m` (the note in red too)
  three times; `quiet Nm` means an agent's log has been silent
  that long. Read the log before calling either hung.
- **`ready`** - gates green, waiting for the landing worker, which lands each ticket as it goes
  green while the others still run. Once every sandbox has finished, the `run` line counts what is
  left down (`landing 6/25`). `human merge: <paths>` means it will be held for a person instead.
- **Needs you** - `gate red`, `conflict`, `held`, `uncommitted` (the work is in its kept worktree,
  not committed), `crashed`, `stalled` (no container, log quiet 30 minutes), `not landed`,
  `stopped` (finished, but the run stopped before landing), `orphaned` (its run was killed and its
  container still works: `sandcastle clean` stops it); the activity says why. `withdrawn` (closed
  or unqueued during the run, or marked `ready-for-human` before it started) is greyed with the
  leftovers.
- **`queued`** (next to start, how many are ahead, or `waits for the run's share` while other
  runs hold their part of the machine's sandbox slots), **`blocked`** (what it waits for, and
  `(lands this run)` when the blocker is in this run - then this run starts it once the blocker
  lands - or `(not in this run)`), **`merged`**, **`no change`**, **`skipped`** (not started
  because the run stopped early).

A live run that spends a subscription on a Claude model also has a `usage` row in the header: the
plan's 5-hour and weekly windows, each with its percentage and reset time, and how long ago an agent
last reported them (`usage  claude  5h ... 14% · resets 18:10   week ... 93% · resets Wed 06:00   (2m ago)`).
Amber from 75% and red from 90%; grey with its age when no agent has reported for 15 minutes; `waiting
for the first agent's reading` before the first. A run on an API key has no row (its settings row
says `API credits`: there is no plan to spend).

After a run, or for a ticket outside it, the state is inferred from branches and logs: `left
over` is a branch from an earlier run, for `sandcastle clean`. The live view fits its pane and
summarises the rows that do not fit on one line (`sandcastle status 10 all` shows them all).

**Logs.** Each ticket's agent and gate logs are `.sandcastle/logs/agent-issue-<n>-*.log` (a
merged ticket's move to `.sandcastle/logs/archive/` at the next run or `sandcastle clean`); the
`-gates-` one is the orchestrator's gate output. Each pass's raw stream - every tool call and
result - is the `.jsonl` beside its `.log`: read that to check a reviewer's claim. The `.log`
marks a failed tool result as `! error: ...` or `! exit N: ...`, and the last lines of a failed
run's log hold the real cause (a usage limit usually reads as a "trust dialog" error). How long
each step took, and each agent pass's tokens, is in `.sandcastle/logs/timings.jsonl`.

In Herdr, Ctrl-clicking a ticket in the status view opens its card in a popup: its state and time in it, one line per pass of its last run with outcome and duration, and why it is held, in conflict or red. A digit opens that pass's log (while it follows a live log, `Ctrl-C` closes it, as less takes no other key then; on a finished or short log, `q` or `Ctrl-C` does; the bottom line says so in both), and closing the log puts the card back. `t` prints the ticket's tracker link; `q`, Esc or `Ctrl-C` closes the card.
