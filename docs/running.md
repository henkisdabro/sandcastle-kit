# 🚀 Run

Starting a run, detached runs, pausing, the closing summary, re-runs and what a run leaves behind.


```bash
sandcastle run                        # every queued ticket
TICKETS=12,15 sandcastle run           # just these
sandcastle run 12 15                  # the same, as arguments
DRY_RUN=1 sandcastle run              # implement, review, gate - never merge or close
sandcastle run --dry                  # the same, as an argument
CONCURRENCY=2 sandcastle run          # parallel sandboxes for this run
sandcastle run --concurrency 2        # the same, as an argument
sandcastle run --detach               # start it as a process of its own and return (see Detached runs)
sandcastle run --api-key              # the yes to billing API credits, where there is no terminal to ask on (below)
CROSS_REVIEW=1 sandcastle run         # add the Codex review
AUTONOMY_LEVEL=1 sandcastle run       # offer to re-run conflicted, unblocked and partly-done tickets (see autonomy)
AUTONOMY_LEVEL=drain sandcastle run   # keep taking turns until the queue is drained or a stop condition holds
```

**After labelling, wait a few seconds.** On GitHub, `gh issue list --label` can miss a ticket
labelled moments earlier (the search index lags), so a run started straight after `--add-label` or a
`sandcastle requeue` can leave that ticket out without saying so.
Give GitHub a few seconds before `sandcastle run`.

**Before anything is spent.** A run refuses to start on a dirty tree, off the base branch, while
another run of the same project is live, or while any check fails.
It prints the tickets it will start (with any `model:` override), the models, the kit, Claude Code
and Codex versions, the machine-wide pool, `Keep awake: on`, a line saying the base branch is the
run's until it ends (see [Safety model](safety.md#-safety-model)), and - once the project has run before - a
rough estimate of tokens and time, as a range from the median to the 80th percentile of the tickets
in the last three runs that the same implement model built (a ticket's `model:` label, else the
default; a model with fewer than five tickets there is topped up to five from its tickets in older
runs, newest first, and the line says `priced from older runs` and counts them as `and N older`; a
model with no history at all is estimated from all of them and the line says the estimate is low; a
model still under five tickets is blended with all of them, its own figures weighted by its share of
five, and the line says so: `claude-opus-5-5 from 2 tickets, blended`).
A carried branch (one ahead of the base, which a base merge may conflict with) that a recorded head
lets skip the implementer and the full review (a land-only or narrowly reviewed one) is priced from
earlier carried tickets - those that ran as carried, or had a conflict resolved and no implement in
their run - and from the resolve, narrow review and gates of a ticket implemented and requeued after
a conflict in its own run, and a fresh ticket from the rest (that requeued ticket's whole first
attempt among them); a carried branch that gets a full review all the same (no such head: stopped
before its review; or a person's comment on the ticket since its review) is priced as a fresh
ticket, its timings lines say `unreviewed` in place of `carried` so the carried history stays
land-only, and the line counts it apart as `N to review`; a remainder (a ticket re-run for what an
earlier "part of" merge left, with no branch ahead of the base) is priced from earlier remainders,
which the fresh tickets no longer count, and with none it is priced as a fresh ticket and the line
says it may be high; the line gives the split `(N carried, L to review, M remainder, K fresh)`, and
says the estimate is low for a carried ticket with no carried history.
A ticket is also priced by its size, from the number of paths on its `Touches:` line and its body's
length: small is a body under 1,000 characters and at most 2 paths, large a body of 2,500 characters
or more or 6 or more paths, medium the rest, and a ticket with no `Touches:` line is sized by its
body alone.
It is priced from the window's tickets of the same size when the window holds at least three of
them, and the line names the size and the signal and says how many tickets were priced that way;
with fewer it prices the ticket as above, and says it may be high (a ticket smaller than most of the
window's) or low (a larger one).
Each timings line records the count as `touches` and the body's length as `bodyChars`; a line
without `bodyChars` (written before) is sized by its path count alone (1-2 small, 3-5 medium, 6 or
more large), and one without `touches`, or with neither a line nor `bodyChars`, is of unknown size.
The tickets are priced as their summed figures divided by the slots, not in whole rounds (a sixth
ticket on five slots starts when the first slot frees), and never below the slowest single ticket's
figure, at the median and at the high end alike.
The last ticket's landing (its landing gates) comes after that.
When a `Blocked by` chain in the run takes longer, the chain sets the time, as the sum of its own
tickets' times and their landings (a dependant starts only once its blocker has landed):
`(N tickets in sequence)`.
The machine-wide gates pool is counted too: every ticket's gate passes and landing gates (from
earlier runs' gate lines, without the wait for a slot) share the `maxGates` slots, and when that
takes longer than the rest it sets the time: `(gate runs on N slot(s) set the time)`.
Landings go one at a time, so the landing gates added up are a floor on the end of their own:
`(landing gates, one after another, set the time)`.
A full queue's gates run slower than a small run's, so the gate and landing-gate times come from the
earlier runs that ran at about this run's concurrency (within one sandbox at a time of it, from each
run's `load` in `logs/history.jsonl`, except that a run at one at a time matches only a run at one:
its landings were all gate-free fast-forwards) when the last three runs hold at least two of them;
with fewer they come from every run, and the line ends
`No history at N at a time ..., so it may be low.` A run at two or more at a time never takes its
landing-gate time from a run that ran at one at a time; with no other landing in the history it
prices every landing after the first as its ticket's own gate time (tickets - 1 of them), and the
status view's projected end follows the same rule.
The base gates and verify of the same runs are added on top, as they run before every ticket and
after the last; a run that skipped its verify counts 0.
`from N ticket(s)` counts the history tickets that priced the run (those of its models, carried,
remainder or fresh), not every ticket of the last three runs.
A ticket's wait for another ticket's fix, like a wait for a gates slot, is left out of its usual
time.
Tickets that others wait for start first; a ticket whose blocker is in the run starts when that
blocker has landed, one whose blocker is open and not in the run waits for a later run, and so does
one whose existing branch changes a file another ready ticket's branch also changes.
Then come the image check, preflight, the hook check and the base gates; a red one stops the run
before any agent starts.
Later turns of an autonomy run print only the start lines that changed since an earlier turn
(the versions, the CPU and memory limits, `Keep awake`, the base-branch line, the status view, the
preflight, the load and usage pauses and the `Lean:` line), then
`(N start line(s) unchanged from an earlier turn)`; the API-credits line, the ticket list, the
estimate and the turn's own lines print every turn.

**Spending an API key is never silent.** Claude Code spends `ANTHROPIC_API_KEY` before
`CLAUDE_CODE_OAUTH_TOKEN`, and the personal and the project `.env` merge key by key, so an API key
in either file reaches the sandboxes and bills API credits, even beside an OAuth token.
Whenever one would, the run stops before any image, sandbox or model call and asks, in red:
`This run bills API credits (ANTHROPIC_API_KEY from <file>). Go ahead? [y/N]`.
Without a terminal (`--detach`, a script) it refuses unless given `--api-key` (or
`SANDCASTLE_API_KEY=1`), which is the yes; the refusal names the flag and the other way out:
removing the key.
A run that goes ahead says so in red on its start line
(`API credits: this run bills API credits - the sandboxes spend ANTHROPIC_API_KEY from <file>`,
naming an OAuth token beside it as ignored), in the status view's RUN lane (`● API credits`) and on
the closing summary's `Settings:` line.
`sandcastle preflight` and `sandcastle lean --measure`, which call the model too, ask the same, and
take `--api-key` as well.
Red only on a terminal and without `NO_COLOR`; the words say it either way.

When the machine-wide sandbox cap holds the run below `CONCURRENCY`, the first line says so before
the models, and where the cap comes from:
``10 ticket(s), up to 2 at a time (CONCURRENCY=4, but maxSandboxes is 3 (machine settings) and one slot is kept for landing - `sandcastle size` suggests a figure; gate passes run beside them on 2 gate slots) - implement ...:``.
The cap is `SANDCASTLE_MAX_SANDBOXES`, else `maxSandboxes` in the machine settings, else the
default pool of 6.
"Up to 2 at a time" counts tickets in an agent pass; a ticket in its gates pass leaves that count
and runs on a gate slot.

When another run is live and holds or wants sandbox slots, the start also says how the machine is
split, before the estimate:
`webshop is live (6 slots, demand 5): this run's share is 2 (one of the pool's slots is kept for any run's landing); it starts as webshop's tickets finish, the first likely in ~12m`.
The wait comes from that project's usual time for an issue and the ages of its working tickets, so
it is left out where that project has no history.
A run from an older kit is named as one that ignores shares
(`webshop's run predates shares: it keeps taking free slots until it ends`); the run still starts.
Nothing is asked: the split applies by itself ([Concurrency](concurrency.md#-concurrency)), and the estimate
divides by the run's share (the one slot kept for landing is outside it), not the machine limit, and
its line says so: `at this run's share now, 1 at a time; shorter as webshop finishes` (a run alone
prints neither).
In a detached run the line is in `.sandcastle/logs/run-output.log`.
A run that shares its project's name with another (a second checkout, say) is named with its folder
(`site (site-review)`), or its pid (`site (pid 4242)`) where the folder is unknown or alike.

**While it runs.** The status view opens first, before the slow checks, and its RUN lane names the
stage the run is in.
A start that took 10 s or more prints where its time went in one line after the `Status view:` line
(`Start took 64.2 s: blocker reads 31.0 s, queue read 12.3 s, versions 9.8 s, docker info 4.1 s, others 7.0 s`).
Inside Herdr the run lays it out itself (below), and does not start if it cannot; elsewhere run
`sandcastle status` in a second terminal.
The run prints a heartbeat line every five minutes while anything is in flight - tickets working (a
gates step says when it waits for a gates slot, and counts its time from the first gate), landings
(a landing says when it waits for a sandbox slot, and counts its time from the slot), sent-back
tickets waiting to resolve a conflict (each with what it waits for: `#10 12m (for #20, #30)`), and
green tickets queued to land (from their gates going
green until the landing worker takes them); it also says when the run has waited for a sandbox slot
longer than a typical issue takes (the wait is the run's, not a ticket's: a pipeline takes its slot
first, then the ticket first in line) - and the status view flags a sandbox whose log has been quiet
for ten.
Each agent pass writes a readable log and its raw stream - every tool call and result - in
`.sandcastle/logs/` (see [What a run leaves behind](#-what-a-run-leaves-behind)).
With `USAGE_CHECK=1` the run also reads the plan's usage after preflight and before each ticket,
with the host's Claude Code login, read-only, when the sandboxes spend a subscription token (with an
API key it says it does not apply; the details are under [Configuration](configuration.md#-configuration)).
With `USAGE_PAUSE=90` the run instead waits out a plan window that reaches that percent, and resumes
after its reset ([Pausing a run](#-pausing-a-run)).
To hold a live run without losing work - the machine, the allowance or a quiet moment is needed -
`sandcastle pause` stops new tickets and agent passes at the next safe juncture and
`sandcastle resume` carries on ([Pausing a run](#-pausing-a-run)); `sandcastle stop` still ends the
run.

The status view reads each ticket of a live run from the run's own record, so it always agrees with
the run.
Its header is the logo - the project, its base, the clock and, in the muted colour after the clock, the
version of the kit that is drawing (`v0.24.0`; none if the kit's `package.json` cannot be read) -
and the **lanes** beside it: RUN (the stage, `turn 2/3` - the turn out of the
level's cap, none for level 1, which asks after every turn: `turn 2` - and the tokens spent),
MACHINE (the pool's sandboxes and gates), MODELS (each pass's model, and the repair attempts a
ticket gets after a red gate: `repair 1`, or a greyed `○ repair` with `repair.attempts: 0`),
SETTINGS and, for a subscription, PLAN.
The lanes sit beside the logo while it and three of them fit, else in a row under it, and the ones
that do not fit go onto one summary line, cut with `…` where the pane ends.

SETTINGS shows the autonomy level bracketed (`autonomy [3]`), the run's concurrency after the
machine-wide sandbox cap (`concurrency 4`, or `concurrency 6 (asked 8)` when the cap clamped what
`--concurrency`, `CONCURRENCY` or the config asked for), and cross-review:
`● cross-review gpt-6-astra high` when it runs, a greyed `○ cross-review` when it is off; the MODELS
lane then holds only models.
With Codex signed in to a ChatGPT plan, cross-review also adds a `codex` line to the **plan** lane
(below).
A live run's lanes come from its record; between runs `sandcastle status` shows what the next run
would use, prefixed `next run:` (so it is not read as the ended run's recorded settings), and with
nothing passed falls back to the last run's record, marked `(last run)`.
The view shows only what the record holds: a record from an older kit has no settings, and draws
none.
A value that came from the clone's untracked `.sandcastle/config.local.json` is followed by a grey
`local` (`autonomy [2] local`, `concurrency 3 (asked 8) local`, `● usage-pause 90% local`), so a run
that behaves differently from CI or from another clone is explained where it is watched.
Only a value the file set and the environment did not override is marked, and the model keys, which
the lane does not draw, are not.

SETTINGS also shows the usage guard: `● usage-guard 90%` with `USAGE_CHECK=1` (its stop threshold,
`USAGE_STOP`), or `○ usage-guard` greyed when it is off.
When the guard cannot get a reading (a 403 turns it off for the run, a rate limit, an expired Claude
Code login or no token at all leaves it without one for now, and with an API key it does not apply)
the view says so in the warning colour: `● usage-guard 90% (no reading - not guarding)`.
A run with `USAGE_PAUSE` set shows `● usage-pause 90%`, the percent at which it pauses itself.
A run whose sandboxes spend `ANTHROPIC_API_KEY` adds a red `● API credits` to the RUN lane, at any
width.

The ticket table's columns are TICKET, STATE, TIME (a working ticket's time in its state, red at
twice the usual, with `~4m` beside it - roughly what the step usually has left; a finished ticket's
whole length, start to end, kept from its first start if the run put it back and ran it again, and
after the run from its record; `-` while queued or blocked), **DIFF**, **CPU/MEM** and **TOKENS**,
then ACTIVITY.
DIFF is the lines the ticket's branch adds and removes against the base - `+96 −1159` - and a `-`
when it has no branch.
CPU/MEM is the ticket's sandbox now - `1.0c/2.1G`, CPU in cores and memory, the CPU half red when
the sandbox takes most of the machine's cores, a greyed `-` when the ticket has no container.
TOKENS is what the ticket has cost so far - `3.1M 94% 27k`, **in**, the share of it served from the
prompt cache (amber under 70%) and **out** - summed over its finished passes and the one running
now.
In counts what the closing summary's `in` does, cache reads and writes included, so the column adds
up to the RUN lane's `tokens`; out is the output.
The legend under the table says so (`tokens = in, % of it from cache (amber under 70%), out`).
The run adds the running pass's usage to the ticket's `tokens` in `logs/run.json` as it reads that
pass's agent log, on the usage row's 15-second tick, so a pass shows its cost while it works and the
view only reads the record; a Codex cross-review pass has no figure until it ends.
A ticket that has not run a pass yet shows a greyed `-`.
The fixed columns have set widths and give way, in the order CPU/MEM, DIFF, TOKENS, as the pane
narrows, so ACTIVITY keeps room for its notes: from 120 columns all show, from 92 to 105 only
TOKENS, the figure a person watching the plan's allowance needs, and below 92 none.

**The plan's usage.** A run does not have to guess how close it is to the plan's allowance.
While the sandboxes spend a subscription (`CLAUDE_CODE_OAUTH_TOKEN`, no `ANTHROPIC_API_KEY`) and at
least one of implement, review and repair runs on a Claude model, a **plan** lane in the header
shows the windows the reading carries - the 5-hour one, the week, or both - with each one's bar,
percentage and reset time, and how long ago the reading was:
`claude 5h ▓░░░░ 14% · resets 18:10 · week ▓▓▓▓▓ 93% · resets Wed 06:00 · (2m ago)`.
A window the agents' events do not carry (Claude Code 2.1.322 writes the week alone) is kept from the
last event that had it until it resets, or, with none, not shown and not judged: its cell is blank,
as wide as it would be, so the others do not move.
A window is in the normal colour below 75%, amber from 75% and red from 90%; a reading older than 15
minutes (no agent has reported since) is greyed, its age beside it.
Until the first agent reports the lane is left out.
The numbers cost no request: Claude Code's output in every sandbox carries `rate_limit_event` lines
(about three a pass) with the windows' utilisation and reset times, and the run reads what each
agent's raw stream (`.sandcastle/logs/agent-issue-<id>-<phase>-<id>.jsonl`) gained every 15 seconds,
keeps the newest reading in the run record (`usage` in `logs/run.json`, rewritten at most every 15
seconds, only when a newer one has come) and shows it in the status view, as a `sc_usage` token in
Herdr's sidebar and on the closing summary.
It is the plan's own account of itself, so it needs no setting and no credential and is independent
of the usage guard (`USAGE_CHECK`), which asks the plan's endpoint before each ticket and can stop
the queue - though once an agent has reported, the guard reads the same numbers while the newest is
under 10 minutes old, and makes no request.
`USAGE_PAUSE` ([Pausing a run](#-pausing-a-run)) acts on them too.
With an API key there is no plan to show: no lane, and the RUN lane says `API credits`.
A record from an older kit, or a run with no Claude model, has no `usage` and draws no lane.
Between runs, `sandcastle usage` prints the same reading from the record, or asks the endpoint once
when none is fresh.

**Codex's usage, with cross-review.** With `CROSS_REVIEW=1` and Codex signed in with a ChatGPT plan
(`~/.codex/auth.json`'s ChatGPT sign-in, not an API key, and no `CODEX_API_KEY` in the sandboxes'
environment), the plan lane draws Codex's plan on a line of its own beside Claude's, in the same
form: `codex 5h ▓▓▓▓▓ 100% · resets 18:10 · week ▓░░░░ 16% · resets Wed 06:00 · (2m ago)`, and
leaves it out until the first cross-review pass has ended.
A run that spends no Claude plan (an `ANTHROPIC_API_KEY`) still shows the `codex` line; a run
without cross-review, or with Codex on an API key, has none.
The 5-hour and the weekly window are told apart by their length (300 and 10080 minutes), not by
Codex's `primary` and `secondary`.
`codex exec --json` prints no rate limits, so each cross-review pass's command prints the last
`rate_limits` its Codex session recorded as its closing line once Codex has ended (the session lives
in the sandbox's `~/.codex/sessions` and goes with it: it is never copied to the host's `~/.codex`),
and the run reads that line from the pass's `.jsonl` like Claude's: the line updates when a
cross-review pass ends, not during it.
The Herdr token joins the providers' weekly windows (the 5-hour window for a reading with no week),
`claude wk 93% · codex wk 16%`; the closing summary's `Plan usage` line is Claude's, and a run with a
Codex reading adds a `Codex plan usage` line beside it.

| State | Means |
|---|---|
| `setup` `impl` `resolve` `review` `codex` `gates` `repair` | Working. `resolve` is a re-run's conflicted base merge being resolved, with its own log (`agent-issue-<id>-resolve-<id>.log`) and its own line in `timings.jsonl`. `gates` names the gate running (`2/7 pytest`) or says it waits for a machine-wide gates slot; its output is in `.sandcastle/logs/agent-issue-<id>-gates-<id>.log`. TIME turns red at twice the step's usual time in this project (the 75th percentile of that step in the recent runs, so a step with a fast and a slow kind of run, gates on a warm and on a cold build cache, is judged by the slow kind), and the note starts `3x over, usually 5m` (in red) at three times it |
| `ready` | Implemented, reviewed, gates green: waits for the landing worker, which lands each ticket as it goes green. `human merge: .github/` means it will be held for a person instead |
| `landing` | Being merged; the run line counts landing down (`landing 6/25`) |
| `gate red` `conflict` `held` `uncommitted` `crashed` `not landed` | Needs you. A conflict names the files and the branch merged before it that changed them; `held` with no commits is a ticket handed back to a person (a held branch you then merged by hand reads `merged`, "closes on push" until the merge is on `origin`'s base branch; merged with a "part of" merge it reads `merged by hand, partly done: stays open`, pushed or not); `uncommitted`: the agent's work is in its kept worktree, not committed |
| `not landed` `conflict` (read `later`) | A `not landed` or `conflict` ticket that a later turn of the run takes by itself (autonomy level 2, 3 or `drain`, before the cap, with no stop, dry run or red base) keeps its word but reads `later`, in grey, with the note `retried next turn - <why>`, and is counted `later`, not `needs you`. It reads `needs you` again in the run's last turn or once the run has ended, and always at level 1, which asks you first. A forecast: a `drain` that stops itself at the end of a turn (the same ticket failing twice running, or no progress) ends the run, and the ticket then needs you |
| `stopped` `orphaned` `stalled` | Needs you. `stopped`: finished, but the run stopped before landing (it says why, and lands on the next run). `orphaned`: its run was killed and its container still works - `sandcastle clean` or the next run stops it. `stalled`: no container, and its log quiet for 30 minutes |
| `withdrawn` | Closed, taken out of the queue or marked `ready-for-human` during the run - someone's decision. Not landed, and not started if it came before its sandbox |
| `queued` `blocked` | Not started, in this run: next to start, how many ahead, that it waits for the run's share of the machine's sandbox slots (or that the pool's last free slot is kept for a landing), or what it waits for and whether this run holds that blocker. With no run live, every labelled ticket reads `queued` (`for the next run`). A `requeued` line marks a second attempt this run, after a conflict or a red at landing, or a conflict its pipeline found before its review or gates |
| `later` | A labelled ticket outside the live run (a run that names its tickets, or one queued after the start), queued or blocked: `next run`, or `waits for #N to close`. Grey, after `merged` and before `left over` in the list, and counted apart in the legend: `queued` and `blocked` count this run's tickets only. The collapsing view (`sandcastle status`, the Herdr status pane) draws no row for it and counts them in one line at the table's foot, `43 for a later run (#382-#609), 2 blocked`, so a long queue never pushes the run's rows off the pane; `sandcastle status all` and `status 0` list each as a row |
| `paused` | Parked between two phases of a [paused](#-pausing-a-run) run: its sandbox is closed and its branch kept, and the note names the phase it resumes at and the commit (`before review at a1b2c3d`) |
| `merged` `no change` `skipped` | Done, found nothing to do, or not started because the run stopped early - or because GitHub could not be read for an outsider's edit to the ticket (`not started: could not read its edits from GitHub`): it stays queued and the summary lists it under **Runnable now**. This run's landings are listed above earlier runs' merged rows |
| `left over` | A branch from an earlier run, not in this one; `sandcastle clean` removes it once it is merged |

**Landing.** Each green branch lands as soon as its gates pass, while the others still run, on one
landing worker: landing moves the base branch, which the run guards against sandboxes changing, and
the kit's own writes are the only moves it accepts.
So a dependant of a ticket in this run starts once that ticket has landed with its work done, closed
or not: a close the tracker refuses holds nothing back.
Branches from earlier runs land first.
Each lands as a merge commit, or as one squashed commit with `land: "squash"`; a branch that changes
hooks, CI or install scripts is held for you instead (see [Safety model](safety.md#-safety-model)).
The ticket is closed with a comment saying the work is merged locally and not yet pushed, and the
merged base branch is gated once more - unless the last landing's own gates already ran on that very
commit, which the closing summary then says.
A dry run lands nothing and ends by checking that its tickets and the tracker are unchanged.

> [!TIP]
> Start with `DRY_RUN=1` on a couple of tickets to see the whole loop - implement, review, gates -
> without anything being merged or closed.

## 🛰️ Detached runs

An agent that starts a run should not hold it: a harness's background command has a time cap
(Claude Code: 2 hours) and ends with the session, and a run killed mid-landing leaves work half
merged. `sandcastle run --detach` (or `SANDCASTLE_DETACH=1`) starts the same run as a process of its
own, in its own session, and returns:

```bash
sandcastle run --detach               # checks what a run checks, starts it, returns
sandcastle wait                       # blocks until it ends, then prints the closing summary
sandcastle wait 6600                  # ... or gives up after 6600 s (exit 124), leaving the run alone
sandcastle stop                       # SIGINT, as Ctrl-C in its terminal would
```

- **`--detach`** checks what a run checks before it starts - a clean tree on the base branch, no
  other run live, the autonomy level - and refuses with the same message if one fails.
  The run's output goes to `.sandcastle/logs/run-output.log` (emptied at each start), and the
  command waits up to a minute for the run's status view, then prints
  `Run started detached (pid <pid>). Status view: pane <id> (tab <id>). Output: ...` (in a
  herdr-core terminal, `Status view: terminal <id>`).
  Outside Herdr the status view is `sandcastle status` in a terminal of yours.
  A run that ends before it is going is reported with the end of its output.
  A detached run ignores SIGHUP.
  Started in a herdr-core terminal, it outlives that terminal closing from hc 0.1.19 on; a
  terminal opened before the update to 0.1.19 keeps the old behaviour (closing it ends the run)
  until it is recreated.
- **Not with autonomy level 1**, which asks whether to run again at the end of each turn and has
  no terminal to ask in: `Autonomy level 1 asks a question ... Use level 2 or 3, or run attached.`
  Levels 2, 3 and `drain` work as usual.
- **Not with an API key, unless told.** A run that would spend `ANTHROPIC_API_KEY` has no terminal
  to ask on, so `--detach` refuses it before a process starts unless it is given `--api-key` (or
  `SANDCASTLE_API_KEY=1`) as well ([Run](#-run)).
- **`sandcastle wait [seconds]`** blocks while the run holds the project's run lock, then prints
  what `sandcastle report` prints and exits with the run's own exit code (recorded in `run.json` as
  `exitCode`).
  With a timeout it exits 124 and leaves the run alone, so a harness's time cap is met by starting
  it again.
  With no run live it prints the last summary at once and exits with the recorded code (0 when there
  is none).
  A run whose last turn left the merged base red (`RED TOGETHER` in the summary, red on a tree a
  ticket's own gates or a landing sandbox passed, or red twice through likely load) exits **1**, at
  every autonomy level, so a harness does not read success on a base the summary says not to push.
  The last turn's verify decides it: a drain that went on past a likely-load red verify exits with
  the code of the turn that followed.
  A later turn the checkout refused to start (a dirty working tree, a branch that is not the base,
  git's half-done leftovers - another session's edit mid-run, say) ends the run as the turn before it
  did: **0** on a green merged base, 1 on a red one.
  Its cause is in the closing summary's Run section, so `sandcastle report` shows it after the run.
  At `drain` the line gives the whole run:
  `Drain: <N> turns, <HH:MM> to <HH:MM> (<span>), <landed> landed (<#refs>), tokens <in> / <out>, stopped because <cause>`.
  At the other levels it reads `Turn 2 could not start: ...`.
  Otherwise 1 is a red merged base or a refusal before any turn ran: a refused first turn, and every
  safety stop (the `.git` guard's `NOT STARTED: the shared .git differs ...`, a bad label) at any turn.
- **`sandcastle stop`** sends the live run a SIGINT - the same as Ctrl-C attached: it stops its
  sandboxes and records how it ended - and prints `Stopping the run (pid <pid>)`. With no run
  live: `No run is live.`
  A stop (this, or Ctrl-C) while the base gates or a verify run also removes that run's own
  throwaway worktree and its `sandcastle/*` branch as the run exits.
  It keeps them, naming `sandcastle clean`, when the run stopped on the guard or its `.git` check
  fails at that moment; a leftover of an earlier run is not touched.
- While a detached run is live, the **status view** closes with the last three lines of
  `run-output.log` under a light rule, so the run's own messages are on screen without a pane of
  their own.

A run in a terminal of your own (`sandcastle run`) works as before.

## ⏸️ Pausing a run

`sandcastle stop` ends every sandbox mid-pass, and the summary splits across two runs.
To hold a live run for a while - you need the machine, the plan allowance or a quiet moment -
without losing anything, pause it:

```bash
sandcastle pause                      # hold the live run at the next safe juncture
sandcastle resume                     # continue it, in the same run
```

Your agent does both on request ("pause the run", "carry on"; the skill's `pause` and `resume`
actions).

A **soft pause**, from any terminal (the run may be attached or detached):

- **No new work starts.** No new ticket, and no new agent pass for a ticket in flight (implement,
  review, cross-review, repair or resolve). A pass already running finishes.
- **At that juncture the ticket's sandbox closes.** Its branch keeps every commit (a worktree
  holding uncommitted files is kept too, locked against a prune of worktree records), and the
  ticket waits, holding no sandbox slot. Gate runs are not agent passes: a ticket whose pass has
  ended goes on to its gates, and a green branch **still lands** - landing spends gates but no
  model allowance.
- **The run lets go of the machine.** It stays alive, but its [demand](concurrency.md#-concurrency) is 0 once
  nothing is in flight, so the other runs can use its sandbox slots, and the
  [keep-awake](#-sleep) helper ends so the machine may sleep. Both come back on resume.
- **`sandcastle resume`** opens a fresh sandbox on the same branch for each paused ticket and goes
  on with its next phase - a branch that was implemented is reviewed on the commit its implement
  pass left, and is not implemented again - with one closing summary at the end of the run.

Both commands print what they did, or `No run is live.`; pausing a paused run, or resuming a run
that is not paused, says so and changes nothing. They write and remove a control file,
`.sandcastle/.run/paused`, which names the run it was asked of (a file a dead run left behind pauses
no later one) and which the run reads at each juncture and every second.

While paused, the status view's RUN lane reads `PAUSED since 15:40`, with
`finishing #12 review, #14 landing` on the next row while anything is in flight; a ticket parked
between two phases shows as `paused`, with the phase it resumes at in its note.
The Herdr sidebar and tab bar say `paused` in place of the working count, and the Claude Code mod
treats a paused run as live: no "the run ended" prompt.
`sandcastle wait` keeps waiting through a pause, and `sandcastle stop` works while paused.
A run that ends while paused (stopped, crashed, or stopped by its safety guard or the plan's limit,
which do not wait for the resume) lists the paused tickets under **Runnable now** in its summary:
each branch holds its work, and the next `sandcastle run` picks it up.
A pause does not count as no progress for the `drain` autonomy level, which judges a turn by what it
landed, and a turn cannot end while it is paused.

**Working while paused.** A pause frees the machine, not the repository: the base branch and the
`agent/*` branches are still the run's. A commit, merge or pull on them in the run's checkout trips
its `.git` check, and the run stops at the next landing or as the next sandbox opens (the resume's,
at the latest), landing nothing more. Work in another clone
or a worktree, or `sandcastle stop` the run first.

**Pausing for the plan's usage.** An unattended run that spends a subscription can run the plan out
mid-pass, and the week's allowance is the person's own too.
With `USAGE_PAUSE=90` (or `usagePause: 90` in `.sandcastle/config.ts`; the environment wins) the run
pauses itself when the 5-hour or the weekly window of Claude's plan reaches that percent, and
**resumes by itself a minute after that window's reset** - a pause of days costs nothing, and the
keep-awake helper ends as for any pause with nothing in flight.
It reads the agents' own readings, the numbers of the status view's plan lane, so it needs no
request and no credential, and it does nothing for a run that shows no plan usage (an API key): the
start line says either way - `Usage pause: at 90%, resumes at the window's reset`.
With both windows over the threshold it waits for the one that resets later.
It judges the windows the readings have: a window the agents' events do not carry is kept from the
last event that had it, or, with none, not judged.
A Codex window (the cross-review's plan) never pauses the run: the cross-review is a second
opinion, not a gate, so while a Codex window is at the percent and not yet reset the ticket's
cross-review is skipped, the run prints `#7: cross-review skipped - Codex 5-hour usage 98%, resets
14:05` (the weekday and time, `Wed 06:01`, when the reset is not today), and the closing summary
lists the tickets that landed with one opinion fewer on a line of its own:
`Landed without a cross-review (Codex plan's limit): #7, #9`.
The same pause covers the limit itself: an agent that hits it anyway (the log ends with the plan's
limit message) pauses the run until the reset in place of stopping the queue, and that ticket runs
the pass again in a fresh sandbox on the resume.
When no reading says when the window resets - none has come yet, or none is near its end, which says
the limit is not the plan's (one model's own cap) - the limit stops the queue as it does without the
setting.

The pause is the one `sandcastle pause` makes, with its cause on record -
`paused: { since, cause: "usage", provider, window, percent, resumesAt }` in `logs/run.json` - so
the status view's RUN lane reads `PAUSED - weekly usage 95%` over `resumes Wed 06:01`, and the run
prints it.
A person stays in charge of it: `sandcastle resume` resumes earlier, and the run then does not pause
again for the windows that are over the threshold at that moment until they reset (a reading is not
an order to stop a person who said go on); and `sandcastle pause` during a usage pause takes it over -
it stays until `sandcastle resume`, however long the window's reset has passed, and the timer
never undoes it.
A reset of the window does end a pause the run took itself, so the pause is a wait for the next
window, not a stop.

## 📊 After a run

Every run ends with a closing summary, in the order you act on it: **Done**; **Needs you** (held
branches, merged tickets the reviewer says no gate proves, merged tickets left open with a criterion
undone, the agents' follow-ups the kit filed for triage and other `needs-triage` issues opened
during the run, under a `### To triage` sub-heading after the rest and counted in the header as "to
triage" - as are a dry run's follow-ups, which a real run would file - and a follow-up the kit
failed to file, which you file by hand and the header counts as "need you"); **Needs fixing** (red,
conflicted, crashed or unlanded branches, with the files or tests and causes several branches
share; in a turn the loop follows, a ticket the next turn runs again by itself is not counted as
needing a fix and is listed last, marked `turn 2 runs it again by itself`); **Runnable now / Still
blocked** (blockers re-read after landing); **Local state** (commits not on the upstream - the
tickets are closed but the code has not left your machine); and the **Next step**.
The `Settings:` line names the concurrency the run ran at (`concurrency 2 of 4 asked` when the
machine's sandbox cap made it fewer than asked, `concurrency 2` otherwise).
Under the header's `Settings:` line, a run that showed the plan's usage says where it ended:
`Plan usage at the end: 5h 21%, week 97%` (`so far` for a run still going; only the windows the
readings carry, `week 30%` say), and a cross-review run
with a Codex reading adds `Codex plan usage at the end:` in the same shape.
A run more than twice off its start estimate (or under half) gets an `Against the estimate:` line,
and a slow one `Largest causes measured:` under it (time paused, time beside another run, slot
waits, re-runs and repairs), which any run also gets when one cause took a fifth of its time or
more, a project's first run with no estimate too (led by the gates wait, it names
`sandcastle size`); a `Likely flaky:` line per test that went red and then green, or that a repair
judged flaky, names the tickets that hit it (a red verify whose failing tests all flaked earlier in
the run says so).
The header's tokens, the `Tokens by model:` line and the run's per-ticket lines split the input in
three: `42.5M in (40.3M read, 2.2M written 1h) / 1.2M out` is all input, then what was read from the
prompt cache and what was written to it, with the cache's lifetime (`1h`, `5m`, or how much of it was
`1h` when both) when Claude Code reported it; the rest of the input was uncached.
`sandcastle report` prints it again at any time, with git and the blockers as they are now.
Then:

- **Push** the base branch yourself when you are happy with it. The kit never pushes.
- **A red or conflicted branch** you have fixed on the branch itself: `sandcastle land <n>` merges
  it the way a run does, gates the merge in a sandbox and closes the ticket (or, with a criterion
  recorded unmet, leaves it open with that criterion commented) - never a hand-written `git merge`.
  Or leave it queued: its next run resumes the branch (see [Re-runs](#-re-runs)).
- **A ticket that needs a new attempt:** `sandcastle requeue <n> --note "..."` puts it back in the
  queue with your note as a comment, takes the hold label (`ready-for-human`) off, and makes the
  next run re-implement it rather than land the old branch.
- **Several unlanded branches:** `sandcastle preview` dry-merges them onto the base in landing order
  and names the ones that would conflict, before anything is merged.
- **Leftovers:** `sandcastle clean` removes leftover worktrees (a guard stop's throwaway ones too),
  finished branches, exited sandbox containers and the kit's dangling images.
  Docker's build cache is not the kit's to prune: `sandcastle doctor` shows its size, and
  `docker builder prune` frees it.

`autonomy` (or `AUTONOMY_LEVEL` for one run) lets one `sandcastle run` take further turns by itself:
after a turn it re-runs only the tickets that ended in a merge conflict, whose blockers have now
landed, or that merged partly done and are still queued - `1` asks first, `2` re-runs once, `3` up
to twice.
A later turn repeats only the start lines that changed, and says how many it left out.
Each turn prints its own closing summary, and the last one also carries what the earlier turns left
for a person (a held branch, a partly done remainder, a check by hand, a follow-up to triage), each
line ending `(turn N)`, so `sandcastle report` and `sandcastle wait` never say "Needs you: none"
while work waits on you.
A dry run, a stopped run, a run that hit a usage limit and a merged base that is red never re-run -
a red verify judged likely load (red twice on test timeouts, or a gate far slower than its usual
time) is the exception: the loop goes on, and the next turn gates the base again before any agent
starts, so a base that is really red stops it there.

At `2`, `3` and `drain`, a ticket queued while the run was live (and not held behind an open
blocker) joins it as a **follow-on turn**: where the run would end because no ticket is left to run
again, or because `2` or `3` reached its own turn cap, it runs those tickets as one more turn, under
the same stops and the 20-turn cap.
A late ticket held only by other late tickets joins the same turn as their dependant, and starts
when its blocker lands; one held by anything else waits for the next run.
At `2` and `3` that is at most one follow-on turn per run, even past the level's own cap; at `drain`
the follow-on turns may repeat, so a ticket queued during one can earn the next.
A ticket queued after the follow-on turn at `2` or `3` waits for the next `sandcastle run`, and the
closing lines name it.
Levels `0` and `1` take no follow-on turn.

`autonomy: "drain"` (or `AUTONOMY_LEVEL=drain`) keeps taking turns until no ticket is left to run
again, for a queue that needs more turns than `3` gives - a ticket that conflicts across turns, and
the tickets waiting on it.
A `Blocked by` chain whose links are all queued needs no extra turn: each ticket starts in the same
run once its last blocker lands.
A red ticket is not run again.
After every turn it checks five stops and prints the one that holds as a line naming the cause: **no
progress** (the turn landed nothing and released nothing), **the same ticket conflicting in two
turns running** (named, read from `.sandcastle/logs/outcomes.json`), **the same ticket left partly
done in two turns running** (named), **a red merged base** (one judged likely load does not stop it:
the next turn gates the base first), and **a usage limit or a stopped run**.
A turn the checkout refuses to start ends it too, with the cause `turn <N> could not start: the
working tree is dirty (<files>)` (or `not on <base> (found <branch>)`, or `git left something
half-done (<file>)`).
A hard cap of 20 turns is the backstop.
After the last turn it prints one line for the whole run, and keeps it in the run record, so the
closing summary `sandcastle report` prints shows it in its Run section:
`Drain: <N> turns, <HH:MM> to <HH:MM> (<span>), <landed> landed (<#refs>), tokens <in> / <out>, stopped because <cause>`.
The times run from turn 1's start to the line's (`sandcastle report` ends at the last turn's finish),
the refs are the tickets merged in any turn (the first 20, then `and N more`), and the tokens are the
turns' summed.
The turns are this run's own, found as the closing summary finds the earlier turns, so an older run in
the same history is not counted.
A record an older kit wrote has none of these figures and shows `Drain: <N> turns, <landed> landed,
stopped because <cause>`.

A drain takes only what its own turns lead to: every turn after the first takes exactly the previous
turn's re-runnable tickets, never the whole queue.
A ticket queued after the run started is taken as a follow-on turn when the drain would otherwise
end (also after the no-progress stop, which is about re-running the same tickets, and a late ticket
is new work; never after another stop).
One a stop or the 20-turn cap leaves unrun waits for the next `sandcastle run`, and the closing
lines name each one (`#151 was queued after this run started: \`sandcastle run\` takes it`); at `2`
and `3` they print too.

A run that names its tickets (`sandcastle run 12 15`) keeps to them in every turn: the start lines,
the run record and the summary hold no queued ticket you left out, and a named ticket that waits on
an unnamed blocker still shows as waiting.

## 🔁 Re-runs

A queued ticket with a branch from an earlier run builds on that branch:

- A branch with no commits ahead of the base (a crashed attempt, or a remainder whose work already
  merged) has nothing to build on: it is cut again from the base's tip before the sandbox opens, so
  the agent works on the current tree, not on the one the earlier run started from.
  A branch a clean worktree under `.sandcastle/worktrees/` still holds (the one a run killed before
  its sandboxes closed leaves) is moved together with that worktree, which keeps its installed
  dependencies; one a worktree with uncommitted or untracked files holds, or a worktree of your own
  outside `.sandcastle/worktrees/`, is left where it is.
- The base is merged into the branch first. A conflict goes to the implementer; a conflict only in
  [`generated`](setup.md#-a-gate-for-generated-files) paths is resolved by regenerating them, with no agent.
- A branch that was reviewed and green, and has gained nothing since but merge commits, skips
  implement and review: a clean base merge goes straight to the gates, a conflicted one gets a short
  resolver prompt first (it runs the typecheck gate and the tests that cover the lines it resolved,
  not the full suite: the kit gates the merge commit once it exits), and a merge an earlier run left
  on it that no review has read (a held resolution, say) gets a review of the merge alone.
  If a person has commented on the ticket since that review, the full review runs instead, after any
  resolver, so the comment is read before the branch lands; the kit's own comments do not count.
  A re-run whose only change since its last review is the base merge gets a review of the merge
  alone too.
  A branch that was reviewed but never got a gate result (a run stopped while its gates ran) is
  treated the same way: its gates run and no implementer does, unless its last gate result was red,
  which sends it back to the implementer.
  The record behind these is `.sandcastle/logs/heads.json`, which also keeps a criterion its agents
  left undone, so a branch that skips them still lands as partly done, and their
  [`changelog`](configuration.md#-configuration) lines and what its reviewers said a person should check by hand, so
  its closing summary still lists them; `sandcastle requeue` clears a ticket's entry.
- When the short resolver prompt resolves a conflicted base merge, the kit checks the result against
  git's own automatic merge: a resolution may change only the files git could not merge itself (and
  [`generated`](setup.md#-a-gate-for-generated-files) paths).
  If it also edits a file git merged cleanly that the base had changed - typically adapting another
  ticket's landed code to this one - the ticket is held for a person, with those files named in the
  note, because such an edit can silently drop another ticket's lines while every gate stays green.
  The resolver can say why such an edit was needed (a test the base just added that pins a sentence
  this ticket replaced, say) with one `<stray path="...">reason</stray>` line per file in its final
  message: a file it named goes on to the review of the resolution, which is shown the reason, and
  to the gates; any file it did not name still holds the ticket, and the note lists those.
  A file only the ticket's own branch touched, or one the merge commit adds, can hold none of them:
  it is not a reason to hold, and the review of the resolution reads it.
  Two tickets that both rework one hot file often end here.
  The hold is deliberate; see [Troubleshooting](troubleshooting.md#-troubleshooting) for what to check.
- A file git cannot merge (a lockfile, a [`generated`](setup.md#-a-gate-for-generated-files) path, a
  minified blob) conflicts at landing whatever the order, so one ticket at a time has it in flight.
  Each ticket's files are its branch's changed files plus its `Touches:` line; a ticket that shares
  such a file with one in flight shows as blocked, "waits for #N: both change <file> (git cannot
  merge it)", and starts when that ticket lands or leaves the run.
  Tickets that share only mergeable files start together, and landing (with one requeue) resolves
  the overlap.
  The start names each such file once with its tickets (README.md and CHANGELOG.md, which nearly
  every ticket touches, are one count), and writes every pair to `logs/file-shares.log`.
- While a ticket sent back after a conflict waits to resolve it, a ticket that has not started and
  shares a file with it shows as blocked, "waits for #N to resolve its conflict first (shares
  <file>)", and starts after that resolve; a ticket that shares nothing starts as before.
  Two resolves that share a file go one at a time, the one sent back first going first.
- A ticket closed, unqueued or sent to a human mid-run is left alone, and a run that died between
  merging and closing is finished by the next one.

## 🗃️ What a run leaves behind

Everything lives under the project's `.sandcastle/`, gitignored by `sandcastle init`:

| Path | What |
|---|---|
| `logs/run.json` | The live run's record: stage, versions (the kit's, Claude Code's and Codex's), each ticket's state, the plan's usage while it is shown. The status view and `sandcastle report` read it |
| `logs/history.jsonl` | One line per finished run, since `run.json` is replaced by the next; a run killed without its exit handler is added by the next run's start. Each carries the run's `load` (the sandboxes it ran at once and its ticket count), by which the estimate picks the runs that price its gate times. `sandcastle report --changelog` reads it |
| `logs/timings.jsonl` | Every step - image, preflight, base gates, each agent pass and gate run - with its time, model, tokens (with `tokensNote`, `incomplete` or `unknown`, for an agent pass that failed before its result counted them) and each gate's own time, a `carried` flag on a ticket whose branch was carried into the run (`unreviewed` in its place for a carried branch that gets a full review, which the estimate prices as a fresh ticket), a `remainder` flag on a ticket re-run for what a "part of" merge left, `touches`, the path count of its `Touches:` line (0 with none), and `bodyChars`, the length of its body, which the estimate sizes it by (`ok` is false for a gate run with a red gate, named in `red`). A red gate run again inside its own gates slot is a line of its own after the red run's, marked `rerun`; the closing summary counts a marked landing gate line as a re-run, and the estimate's typical landing gates leave it out. A gate run's wait for a machine-wide gates slot is `waitMs`, not part of its `ms`, and the base gates' and the verify's `waitMs` also include their wait for a machine-wide sandbox slot; a ticket has no wait for a machine-wide sandbox slot, since a pipeline takes its slot before it takes the ticket first in line, so the slot goes to that ticket's rank. A landing gate has lines of its own (phase `landing gates`), so the landings in a row, which can set a run's length, are on record. So has every landing that came to its merge (phase `landing`, `result` the way it ended: merged, conflict, red): its `waitMs` is the wait for a machine-wide sandbox slot (left out, as no wait, for a fast-forward, which takes none, and for a conflict git found on the host first), and a requeued ticket's second `setup` line adds to its `waitMs` how long it waited from its requeue to its resolve's start (for the tickets ahead of it, and then for a free slot), when its resolve waited for tickets ahead of it at all. The estimate and the status view's "usual time" come from it, all but the `landing` lines, which hold the landing gates' time again. Unless `REPORT_SCHEMA=0`, each agent pass's line also has a `report` field: `came` (`report`, `tags` or `missing`), `missing` (why no valid report came), `tries` (the `StructuredOutput` calls), `turns`, and, once the completion signal was seen, `gapMs` (the signal to the result line), `silenceMs` (the longest stretch without a line after it, which a completion timeout must exceed) and `cutOff` (no result line followed) |
| `logs/agent-issue-<id>-<phase>-<id>.log` and `.jsonl` | Each agent pass's readable log (a failed tool result shows as one `! error: ...` or `! exit N: ...` line; its closing `Context window: Nk`, or `Context window: Nk / Mk` when the model's limit is known, is the last call's input and cache tokens, the context size the pass ended at), and its raw stream beside it; `-gates-` is the orchestrator's gate output, one section per gate run, headed with its kind (`# landing gates on the merged tree - run <id>, <local time>`), a `# waited Ns for a gates slot` line after any wait, and its gate lines in the same local time. Moved to `logs/archive/` by the next run or `sandcastle clean` once the branch is merged, or only by `sandcastle clean` while the ticket's worktree is kept. The archive keeps each file for 14 days, and a raw `.jsonl` stream for only 2 (the readable `.log` stays); the same moves delete older ones, by file modification time |
| `logs/heads.json`, `logs/outcomes.json` | Each ticket's last reviewed and green head, and a red one since its review (for re-runs), with the ticket's comment count (and on GitHub the latest comment's time) as its last full review started, its gate results, any criterion left undone, changelog lines and check-by-hand note, and each branch's last outcome. The same moves that archive logs drop a `heads.json` entry whose branch is gone and whose last write is over 14 days old, so the file stays the size of the tickets in play |
| `logs/base-gates.log` | The full output of red gates on the base commit |
| `logs/file-shares.log` | Every pair of tickets that started together sharing a mergeable file, one line each, appended at each start and each mid-run release under a `--- <time>, run pid <pid> ---` line per turn (turns over 14 days old are dropped when logs are archived); the screen names each file once |
| `logs/verify-gates.log` | The gates on the merged base at the end of a run, streamed as a ticket's gates log is (each gate's full output with colour codes stripped, `# <gate> green/RED in Ns`, the wait for a gates slot), whether green or red (`RED TOGETHER`); a run that skipped its verify removes an earlier one. On a red: the run prints the failing tests' names above its excerpt, and the summary's re-gated line names them, and says so when the red tree is exactly one a ticket's own gates passed (the sandbox differs, not the merge) or one a landing sandbox passed (a flaky or order-dependent test). A red verify is run once more first, and the log holds both runs, the second last; red twice with only test timeouts, or with a gate three times its recorded time (the landing's or base gates' time, else the gate's typical time from earlier runs' green base gates and verifies), is called likely load |
| `logs/run-output.log` | A detached run's output; the run before's is moved to `logs/archive/` when the next one starts (kept 14 days) |
| `backup.git` | A bare copy of each `agent/issue-*` branch whose pipeline ended, from which a branch a sandbox deleted is restored ([Safety model](safety.md#-safety-model)). A landing drops a branch's copy; a run's start and `sandcastle clean` drop the copy of a branch whose commits are on the base (merged by hand), and prune the repository once none is left; a deleted unmerged branch keeps its copy, its only one, until `sandcastle clean --all` |
| `.run/` | The rendered prompts, the lean plan, the green-base record a run skips the base check by (written by that check, by a landing - a merge gated in its sandbox, or a fast-forward of the tree the ticket's own gates passed on - and by the verify, so a drain turn does not gate a commit again, and each names the commit, whose gates proved it and where they ran, so the verify does not run again on a base tip a landing merged in a sandbox, the base check or an earlier verify just proved - never on a fast-forward's, whose gates ran in the ticket's own sandbox; a landing's or the verify's record covers the gates only, so the next base check still runs the hook tests and the git-hook probe, unless the record before it covered both and nothing they read changed in between: a diff touching no hook directory, kept hook script, package manifest, lockfile or protected path), and the update record `kit-updated` |
| `worktrees/` | Live sandbox worktrees; `sandcastle clean` removes leftovers |
| `triage/` | The skill's triage and audit results, so a compacted chat loses nothing |

The resolved Claude Code and Codex versions are cached in `~/.cache/sandcastle-kit/` (with the
machine-wide slot locks), never in the project.

## 😴 Sleep

A machine that goes to sleep pauses every sandbox mid-task, so by default a run keeps it awake
until the run ends - `caffeinate -i` on macOS, `systemd-inhibit` on Linux - and prints
`Keep awake: on` when it starts. The display can still turn off and the screen still locks. The
helper is tied to the run's process, so it stops when the run ends, crashes or is killed. If the
helper is missing, or fails as soon as it starts (`systemd-inhibit` with no system bus, as in a
container, or a polkit refusal), the line says `off` and gives the helper's own error, its first
line of output (`off - systemd-inhibit failed: Failed to inhibit: Access denied`), and the run
goes on without it. A failure is remembered for the rest of the run, so later turns do not start
the helper again.

Under WSL the kit does not try the helper: Windows decides when the PC sleeps, and an inhibitor
inside the Linux VM cannot keep it awake. The line says `off - under WSL, Windows decides when the
PC sleeps`. Keep the PC awake in Windows' power settings (Settings, System, Power: set "Screen and
sleep" to never sleep while plugged in) for the length of an unattended run.

- **One run on your energy settings:** `KEEP_AWAKE=0 sandcastle run`.
- **Always:** `"keepAwake": false` in your [personal settings](configuration.md#personal-settings).
- **A laptop lid is the exception.** Closing it sleeps a MacBook whatever the kit does, unless it is
  on power with an external display attached. Leave the lid open, or run on a desktop machine.
- **A paused run lets go of it.** `sandcastle pause` ends the helper once nothing is in flight, and
  `sandcastle resume` starts it again ([Pausing a run](#-pausing-a-run)).

It is a machine setting, not a project one: `.sandcastle/config.ts` is committed, and would
decide it for every teammate's machine.
