# Changelog

All notable changes to sandcastle-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

Each release's **Upgrading** notes say what an existing project may act on. `/sandcastle update`
reads them; by hand, pull the kit and follow [Updating](docs/INSTALL.md#-updating).

## [Unreleased]

### Changed

- A run that will not start on a dirty tree or the wrong branch now says so without a stack
  trace, and lists the uncommitted files (the first ten) that are in its way.

### Fixed

- Inside Herdr, a run's tab opens in the workspace the run was started from, not in whichever
  workspace had focus when the tab was created. Both the skill's run tab and the kit's own view
  tab name their workspace now.

## [0.2.0] - 2026-09-30

### Upgrading

- Most projects need no change. Pull the kit; a run already going keeps its old code, so
  restart only between runs. `sandcastle report` needs a run made with this version: an older
  run's summary is in its run pane.
- A watcher that parsed the end of a run's output: the old tail lines (`merged & closed: ...`,
  `held for a human merge: ...`, `waiting, not started: ...`) are replaced by the closing summary's
  sections. `sandcastle run ended (exit N)` is still the last line.
- **A red gate can now get up to two repair passes beyond `repair.attempts`**, each only while
  the previous pass turned up a different failure (the same failure twice stops it). That can
  spend more allowance on a branch close to green. `repair: { attempts: 0 }` still turns repair
  off.
- **A hook test with `expect: "allow"` now fails when a matching hook errors** (a missing module,
  a crash), not only when one blocks. A hook that errors fails open and errors on every tool call,
  so the base check now stops the run and says which hook. Run `sandcastle gates` after pulling;
  fix a hook it names, or drop it with `lean.dropHooks`.
- `sandcastle init` on a repo with no known stack now writes a placeholder gate that fails, and no
  setup, instead of pnpm commands. Existing configs are untouched.
- Anything that reads `.sandcastle/logs/timings.jsonl` for pass/fail: a gate run with a red gate
  now has `ok: false` and names the red gates in `red`. Before, `ok` only meant the step did not
  throw.
- **A branch a repair pass turned green is reviewed again before it lands**: the review model, on
  the repair commits, looking for weakened tests and removed guards; if that review commits, the
  gates run once more, and a red there leaves the branch red. A repaired branch costs one more
  review pass (often 10-30 minutes) and sometimes one more gate run.
- **A GitHub issue whose queue label comes off during a run is no longer landed** - the same rule
  ticket files already had for a changed status. An `ISSUES=` ticket that never had the label is
  unaffected. To stop a run landing one ticket, take its label off. Such a ticket, and one closed
  during the run, ends in the new state `withdrawn` (the status view's grey "left over" group, the
  summary's "Done"), not "not landed": nothing about it needs fixing. Its branch stays. A ticket
  closed, unqueued or marked `needs-human` before its sandbox starts is not started at all, and a
  GitHub issue carrying both the queue label and `needs-human` is no longer queued.
- **A ticket re-run on a branch from an earlier run gets the base merged in first**, by the
  orchestrator: a clean merge needs no agent, and a conflicted one is left for the implementer to
  resolve (the prompt names the files). Before, such a branch hit the same landing conflict every
  run. Expect `merged <base> into its branch` lines and a merge commit on those branches. The
  merge runs inside the sandbox, never on the host. Such carried-over branches also land first, so
  a new branch of the same run conflicts instead, and it lands on its next run.
- **A run started while a killed run's sandboxes still work stops them**, and so does `sandcastle
  clean`: a killed run's containers went on spending the allowance on work nobody would land.

### Changed

- The status view shows a live run's tickets from the run's own record (`run.json` `tickets`),
  kept by the orchestrator as each ticket moves, instead of inferring a state from branches, logs
  and label times. A finished, green branch waiting for landing reads `ready`, not `queued`; the
  header counts add up to the run (working, ready to land, need you, queued, blocked, merged); the
  `gates` row names the gate running or says it waits for a gates slot; the run line counts
  landing down (`landing 6/25`) and, before it, estimates when it starts from the project's
  earlier runs. A step at twice its usual time shows its AGE in red.
- One vocabulary everywhere: the table, the header, the Herdr pane titles and the report use the
  same words, and "shipped" is gone - the panes said it while nothing had landed.
- Gate output is written to `.sandcastle/logs/agent-issue-<id>-gates-<id>.log` as it runs, and
  the Herdr pane follows it, so a pane shows the test run rather than the review's last words.
- Once nothing is left to start, each Herdr sandbox pane closes as its sandbox finishes, rather
  than sitting on a finished agent's summary; a crashed one stays open.
- Tickets that other queued tickets wait for start first.
- The repair prompt tells the agent to run the red gate without its stop-at-first-failure option
  (`pytest -x`), fix every failure, and quote the full gate's result.
- Between runs the status view's `models` line shows what the next run would use (the project's
  config), not the last run's models.
- A merge conflict at landing names the conflicting files and the branch merged before it that
  changed them, in the report and the status row.
- The lock files behind the run lock and the machine-wide slots now hold `<pid> <token> <label>`
  (the pid still first).
- A run stopped by the shared-`.git` check says which it was. A moved base branch lists the new
  commits and says to run again if they are yours; a changed `.git/config` or `.git/info/` is
  still called tampering. The stop prints the closing summary, headed "Run STOPPED", with no stack
  trace, and the tickets that had finished read `stopped` rather than `crashed`.
- A repaired branch whose second review fails (timeout, agent exit) is held for a human, not
  reported as crashed; unreviewed repair commits are never merged.
- New states in the status view and the summary: `withdrawn`, `stopped`, `orphaned`, and `held`
  for a ticket an agent handed back (reported as "Nothing to change" on GitHub before).

### Fixed

- An error while recording a finished ticket's state (a git call, a full disk) could reject the
  whole sandbox pool, so no green branch landed. It is now logged and the outcome stands.
- A gate that ignores TERM is killed 30 seconds after its timeout (`timeout -k`), and still counts
  as timed out; the base check stops at a timed-out gate rather than running the rest beside it.
- The closing summary of a killed run (Ctrl-C, no clean exit) said "finished" with the time the
  report was asked for; it now says the run ended without a clean exit and gives no end time.
- The status view's "+N not shown" line made ranges of ticket-file ids (`#helpers-01-#...`); it
  names them instead, and fits the pane.
- The status view lost CPU and memory for every sandbox of a project whose path has a space in it.
- `sandcastle lean` and the hook check no longer pass temp paths through a shell.
- A branch that merged but whose ticket failed to close (a GitHub API error) was reported as not
  landed, sending a human to merge work already on the base branch. It now counts as merged, and
  the summary lists it under "Needs you" as merged but still open; the next run closes it.
- A failed tracker call at landing reported the whole `gh` command line, comment and all; it now
  reports the command's own error (`HTTP 502 ...`).
- The Herdr sandbox view turned itself off when a ticket that had waited for a machine-wide slot
  started after the other panes had closed.
- A ticket handed back with no commits was listed with "0 file(s)" and merge commands; it now asks
  for an answer and a requeue.
- The summary said a merged base was "not re-gated (no result recorded)" when the run had merged
  only one branch (a ticket closed as merged earlier counted as a second).
- After a run, the status view showed a handed-back ticket's empty branch as merged.
- A repair that fixed one failure and uncovered another got no further pass when the gate's
  message had no "fail" or "error" in it: both read as the same failure.
- A failed label removal after a successful GitHub close was reported as a failed close.
- Two runs taking over the same stale slot or run lock could both get it (the second deleted the
  first's fresh lock), and a run's exit removed a lock someone else had taken since. A takeover
  now happens under a guard file and only if the lock is unchanged; a release removes only its own
  lock. A lock released between two reads no longer crashes the pipeline asking for it.

- A live run's green branches read `queued ... in this run - on its earlier branch` in the status
  view until landing, because a rule meant for re-queued tickets from earlier runs claimed them.
  That rule now never applies to a ticket the live run holds, even under an older orchestrator.
- The status view could read a half-written `run.json`; it is now written whole and renamed into
  place.

### Added

- **A closing summary** at the end of every run, and `sandcastle report` to print it again: run
  finished (with whether the merged base re-gated green), done, needs you (held branches, each with
  its size and review and merge commands), needs fixing (with conflict files and failing test ids,
  a `Same failing test` line when one test fails on several branches, and a weaker `Same file`
  line when they only fail or conflict in one file), runnable now and still
  blocked (blockers re-read after landing, so issues this run unblocked are named), local state
  (commits ahead of the upstream, branches left standing - "nothing is pushed" beside the fact
  that the issues are already closed) and an ordered next step. Every section prints, "none" when
  empty. The per-issue lines above it now show each ticket's final state.
- The skill's `run` action ends with a required seven-section closing message built on that
  summary: one recommended next action, one question where a decision is needed, and the
  follow-ups offered, not taken.
- `pnpm test`: the status view rendered against a fixture repo and run records (a mixed run,
  an older orchestrator's record, a finished run), checked row by row and for width at 80
  columns. A CI workflow runs it with the type check on every push.

## [0.1.0] - 2026-09-30

Initial public release: an opinionated issue-burndown kit on
[Sandcastle](https://github.com/mattpocock/sandcastle). The v0.1.0 tag was first cut earlier the
same day and moved, five times, to include everything below - the fourth adding trackers (GitHub
Issues or ticket files, including the layout Matt Pocock's setup skill writes) and blockers beyond
GitHub, after a third dry-run audit had found the token accounting empty and the status view
clipping in narrow panes; the fifth keeping the machine awake during a run.

### Upgrading

If you cloned the first v0.1.0 cut, pull and run `/sandcastle update` in each project.

- Nothing in a project has to change: every new config field is optional and prompts come from
  the kit. Run `sandcastle build` and `sandcastle lean` once.
- **A red gate now gets one repair pass** by the implementer's model, which spends allowance.
  Set `repair: { attempts: 0 }` in `.sandcastle/config.ts` to keep the old behaviour.
- **Blocked issues are read from the issue body.** Issues triaged earlier as unlabelled with a
  "blocked by #N" comment can move the line into the body and take the queue label.
- Run `sandcastle lean` once: it now lists hidden items that tests or scripts name. Keep any a
  gate reads, or that gate fails on every branch.
- The status view's header is now five rows (run state, models and machine limits each get
  their own), so it fits a narrower pane.
- **Run `sandcastle gates` in each project** (no model calls; `/sandcastle update` does). The new
  image changes git, jq, curl and Python, which can turn a gate green or red on base, and every
  run now stops while a gate is red there. A project `Dockerfile` that installs apt packages by a
  Debian 12 name may need the Debian 13 one.
- A run now starts by running every gate once on base - minutes, not model allowance - unless the
  same base, image and config were green before.
- A project whose runs are always started with `IMPL_MODEL`, `IMPL_EFFORT`, `REVIEW_MODEL` or
  `REVIEW_EFFORT` can move those values into `implement` / `review` in its `.sandcastle/config.ts`.
- If `sandcastle lean` now lists a dropped hook as named by a test, keep the hook (remove its
  `lean.dropHooks` entry) unless the test is host-only.
- **If `sandcastle lean` warns that PreToolUse guards are kept with no `hookTests`, add tests**
  (README: Hook tests), then run `sandcastle gates`. Until then nothing proves a guard blocks
  anything in a sandbox, and one whose module is missing fails open. A failing hook test stops
  every run at the base check.
- **Start runs in a tab of their own.** Alone in its tab, a run adopts it for the status view and
  sandboxes; the skill's `run` action now creates and names that tab and confirms the view.
  Inside Herdr a run that cannot open a status view no longer starts.
- Branches and worktrees earlier runs left behind show as `left over` in the status view; clear
  them with `sandcastle clean` (`--all` for unmerged ones).
- `sandcastle status` now fits its pane by default; `sandcastle status 10 all` is the old
  behaviour, and the `collapse` argument is no longer needed.

- Nothing has to change for a GitHub project. Run `sandcastle queue` once: it shows the tracker
  and queue label the kit chose. **Two things can now be picked up from `docs/agents/`** (Matt
  Pocock's setup skill): the queue label, if `triage-labels.md` maps `ready-for-agent` to another
  name and `label` is unset in `config.ts`; and the tracker, below. Pin `label` and `tracker` in
  `config.ts` to keep exactly what you had. A repo with `docs/agents/issue-tracker.md` naming "Local Markdown" is now run
  against its `.scratch/` tickets, not GitHub - set `tracker: "github"` if you want the old behaviour.
- To use ticket files: `tracker: "files"` (or Matt's setup skill), tickets committed on the base
  branch, and a clean base branch when you run. Queue with `Status: ready-for-agent`.
- Run `sandcastle blockers` once per project; it replaces the manual comment search in the
  skill's `update` action.
- **Runs now keep the machine awake by default.** Nothing in a project changes. If you would
  rather your energy settings applied, add `"keepAwake": false` to
  `~/.config/sandcastle-kit/config.json`.

### Added

- Repair pass on a red gate, fed the gate's output (`repair` in the config).
- `Blocked by #N` / `Depends on #N` in an issue body holds the issue back while #N is open.
- Opt-in plan usage guard: `USAGE_CHECK=1` starts no new issue past `USAGE_STOP` percent.
- Phase timings in `.sandcastle/logs/timings.jsonl`, per-issue wall time in the report, a
  heartbeat line every five minutes, and a `quiet Nm` hint in the status view. An issue held
  back by a dependency shows as `◌ blocked` there, not queued.
- `sandcastle init` detects the stack (Node, Python with uv, Go, Rust) and writes gates, setup
  and, where needed, a project Dockerfile.
- `/sandcastle update` skill action.
- `sandcastle lean` and every run warn when a hidden skill, agent or MCP file is named by a
  tracked non-Markdown file, such as a test that reads it and would fail on every branch.
- Herdr sandbox view: inside Herdr, a run opens a tab with a pane per concurrent sandbox, each
  following its agent's log, and reports every sandbox to Herdr's agent sidebar as working,
  blocked or done, landing outcome included. `SANDCASTLE_HERDR_VIEW=0` turns it off.
- `SANDCASTLE_TEST_RED_GATE=1` counts each issue's first gate run as red, so the repair pass can be
  tested live - agents that can read a gate make it pass themselves, so a real run seldom reaches one.
- Every `sandcastle run` ends with the line `sandcastle run ended (exit N)`, and the skill's `run`
  action has the agent that started the run in another pane wait for it in the background, so it
  hears when the run ends instead of never being told.
- **A green base first.** A run gates the base commit in the image - every gate, in a sandbox set
  up as an agent's is - before any agent starts, and stops if one is red: that gate would be red
  on every branch, and the run would spend allowance on every issue and merge nothing. A green
  result is remembered until the base commit, image or sandbox config changes.
  `SKIP_BASE_GATES=1` starts anyway.
- `sandcastle gates` runs that check on demand, with no model calls. The red gates' full output
  goes to `.sandcastle/logs/base-gates.log`.
- `model` and `effort` under `implement` and `review` in `.sandcastle/config.ts`, so a project
  keeps its own models or effort in its committed config. The `IMPL_*` / `REVIEW_*` env vars still
  win for a single run.
- **Hook tests** (`hookTests` in the config): made-up tool calls handed to the kept PreToolUse
  guards in the base-gate sandbox, after setup, each expected to be blocked or allowed. They prove
  a guard fires without a model call, and a guard that errors (and so fails open) fails its test.
  `sandcastle lean` warns when guards are kept with no test.
- `sandcastle clean [--all]` removes leftover sandbox worktrees (unlocking them first) and
  finished agent branches, and lists unmerged ones, which `--all` deletes too.
- Token totals per agent pass in `timings.jsonl`, and per issue and per run in the report, read
  from the captured Claude Code sessions.
- A dry run snapshots each issue's state, labels and comment count before the agents start and
  reports `dry run held` or `DRY RUN BREACHED` at the end.
- `timings.jsonl` rows (issue 0) for the image check, preflight, hook check and base gates.

- **Trackers.** Tickets can now be GitHub Issues (the default, unchanged) or Markdown files in the
  repo, in the layout Matt Pocock's `/setup-matt-pocock-skills` calls "Local Markdown"
  (`.scratch/<feature>/issues/<NN>-<slug>.md`, a `Status:` line, `Blocked by: NN`, `## Comments`).
  Choose with the new `tracker` config field; unset, the kit reads `docs/agents/issue-tracker.md`
  and `docs/agents/triage-labels.md` if that setup skill wrote them, and otherwise uses GitHub.
  Those skills are recommended but optional: nothing requires them. With `files`, agents write nothing to tickets: the orchestrator
  posts their `<report>` / `<blocked>` and commits the change, and `GH_TOKEN` is not required.
- **Ticket ids are strings**, so branches, logs, the run record and the status view take
  `checkout-03` as well as `12`. GitHub ids are unchanged.
- **`sandcastle queue [--json]`** lists the queue and what holds each ticket back; the status
  view now reads its queue from it instead of calling `gh`.
- **Blockers beyond GitHub issues.** A ticket body can say `Blocked by ENG-42` (Linear, set up
  with `blockers.linear`; `LINEAR_API_KEY` stays on the host) or name a ticket file. A list on one
  line (`Blocked by #1, #2`) counts every entry.
- **`sandcastle blockers`** scans every open ticket (queued or not) and a run warns for tickets whose *comments* say "blocked by"
  about queued ones: a comment saying "blocked by" while the body does not is not read by a run,
  which would start the ticket. Comments whose blockers are all closed are reported as stale.
- **Keep awake.** A run keeps the machine awake until it ends (`caffeinate -i` on macOS,
  `systemd-inhibit` on Linux), so an idle sleep no longer pauses every sandbox mid-task.
  `KEEP_AWAKE=0` turns it off for one run, `"keepAwake": false` in
  `~/.config/sandcastle-kit/config.json` for good.

### Changed

- Landing re-reads each issue first and skips one closed or labelled `needs-human` during the
  run, and merges the exact commit the gates passed on.
- The base image is Node 24 on Debian 13 (trixie), not Debian 12. Its apt tools were years behind:
  git 2.39 lacked `git merge-tree --merge-base`, and jq, curl and Python 3.11 lagged too. Now git
  2.47, jq 1.7, curl 8.14, Python 3.13. Codex CLI 0.159.2.
- `sandcastle init` scaffolds Go from `golang:1-trixie`, matching the base.
- Inside Herdr, the status view is the first pane of the run's `sandcastle <project>` tab, with the
  sandbox panes beside it, instead of a split in the tab the run was started from. A status pane an
  earlier version left in that tab is closed while it still shows the status view.
- The Herdr sidebar reports a finished pipeline as done, a red one included, with the outcome in
  its message. Blocked is kept for what needs a human: a crash, a merge conflict, a failed
  landing, a branch held for a human merge.
- In a dry run the agents are told to write nothing to GitHub - no comments, issues or labels -
  and to put what they would have posted in their final message.
- The status view marks queued issues outside the live run as "not in this run", and all of them
  as "for the next run" once no run is live, instead of "waiting for a sandbox".
- The lean check also names files that mention a hook `lean.dropHooks` removes (a test comparing
  `.claude/settings.json` with the hooks it expects is red in every sandbox).
- The run and the status view list up to 500 queued issues (was 100).
- The status view opens first thing in a run, before the image check, preflight and base gates -
  a cold start used to leave over three minutes with nothing to watch - and the run record names
  the stage, which the status view's run line shows. The run's issues read "in this run" from the
  start and sort ahead of the rest of the queue.
- Inside Herdr, a run started alone in its tab adopts that tab (renamed `sandcastle <project>`,
  with its own pane named) instead of opening another; it prints `Status view: pane <id>`, and
  does not start if no status view opens. When a run ends its sandbox panes close, so no stale
  "blocked" entry stays in the sidebar; the next run clears what the last one recorded.
- The live status view fits its pane: line wrap is off, and rows that do not fit are summarised
  on one line by state (`+33 queued (#1234-#1376)`). `sandcastle status 0` still prints every row.
- A finished branch's row shows its run's outcome (`gate red: pytest=FAIL`, `dry run: gated
  green, would merge`, `needs a human merge`) instead of the sandbox's last log line, from the new
  `.sandcastle/logs/outcomes.json`. A branch an earlier run left is `◇ left over`, counted apart
  from this run's `waiting`; a re-queued issue says it builds on its earlier branch.
- A forced red gate is reported as `test red gate (SANDCASTLE_TEST_RED_GATE; <gate> passed)`,
  not as that gate being red.
- The skill's `run` action creates a dedicated, named tab for the run, confirms the status view
  exists and says so plainly if not, and reads the dry-run check and token lines in the report.
- The reviewer no longer runs the full gates when it commits nothing: the orchestrator runs every
  gate right after the review, so a clean review's own run repeated minutes of tests for nothing.
- Each gate's run time is recorded (`gates` in the gates row of `timings.jsonl`), and the base
  check prints the gates slowest first - where to look when sandboxes take long.
- `SANDCASTLE_TEST_RED_GATE=1` says at the start what it costs per issue.

- The files tracker takes a ticket's text from the host as a prompt argument rather than running
  `cat` in the sandbox, so a stale agent branch or an odd file name cannot show the agent an old
  ticket or break the run. It reads `Status:` and `Blocked by:` only from the block of plain
  `Key: value` lines under the title, writes the first of the `done` values when it closes a ticket,
  refuses two tickets that map to one id, and posts every agent's `<report>` (implementer,
  reviewer, repair) on tickets that did not land as well as on those that did.
- A ticket moved to another `Status:` during a run is no longer merged and closed.
- The status view widens its ISSUE column to the longest ticket id shown (up to 16), so ids like
  `helpers-01` no longer push the other columns out of line.
- `LINEAR_API_KEY` is read from the user-level credentials file only. A project's
  `.sandcastle/.env` is forwarded into every container by Sandcastle itself, so `credentials()`
  and `sandcastle doctor` now refuse the key there.
- `sandcastle doctor` no longer requires `gh` or `GH_TOKEN` for a project that keeps tickets in files.
- Log files are matched by their repeated ticket id, so ids containing `review` or `repair`
  (`code-review-01`) are not mistaken for a phase.

- The agent prompts say "ticket" and take their tracker wording from the kit; GitHub projects get
  the same instructions as before (bar "for ticket" in two headings).
- `sandcastle doctor` reports which tracker a project uses and why.

### Fixed

- A run that died between merging and closing left the issue open for good; the next run now
  closes it.
- A closed Herdr status pane printed a `pane_not_found` error into the run's output.
- A project's first run crashed with ENOENT on `.sandcastle/logs/run.lock`.
- A worktree Sandcastle kept for its uncommitted files showed as working forever in the status
  view; it now shows its branch's state, and the run report names it.
- The status view shows an issue whose body names an open dependency (`Blocked by #N`) as
  `◌ blocked` before, between and outside runs, not only while the run that held it back is live.
- A just-merged issue no longer shows as `○ queued` in the status view while its run lands it or
  while GitHub's issue listing still trails the close; the queue is re-read as soon as a run ends.
- Inside Herdr, the status pane splits right of a wide pane even when the run's output is piped, and
  it runs the status view of the kit checkout doing the run rather than whichever `sandcastle` is on
  `PATH`.
- Herdr 0.9.2+ no longer drops a sandbox from the agent sidebar at each phase change. Herdr now
  clears a reported agent when its pane returns to an idle shell, which restarting the log tail
  did; each sandbox pane now runs one `tail -F` on a symlink that the phases repoint.
- The lean inventory lists only what a harness loads: a stray file among the skills
  (`pyrightconfig.json`) is no longer a "skill", and `work.md` plus `work/` are one command.
- The lean sandbox no longer hides stray files under `.claude/skills`, `.claude/agents` or
  `.claude/commands`. The harness never loads them, and hiding one such as `pyrightconfig.json`
  turned `pyright -p .claude/skills` red on the base commit.
- `base-gates.log` from an earlier red run stayed in place after the gates went green, reading as
  the current result. It is now removed on green, and a red one opens with the commit, time and
  gate line.
- A run stopped with Ctrl-C left its worktrees locked, so the `git worktree remove --force` it
  printed failed. Every lock is released on exit.
- **Token accounting was empty**: no `timings.jsonl` row carried `tokens` and the report had no
  token figures. With session capture off, Sandcastle reports no usage for Claude; the kit now reads
  what each `claude -p` process spent from its stream's closing `result` line (per model, so
  subagents count).
- The status view in a narrow or short pane: every line is cut to the pane's width with an
  ellipsis, and the header's counts move to a line of their own (zeros dropped) rather than being
  clipped mid-word. A resize redraws at once, even when it lands mid-render, instead of showing the
  old frame's tail for up to one refresh. Blocked issues are counted and summarised as blocked, not
  queued.
- A working row's STATE is the orchestrator's phase, so a branch being gated reads `gates`, not the
  last agent's name, and its AGE is the time in that phase, not the seconds since the log's last
  line.
- `herdr-pane-N.log` links are removed when their pane closes and when a run starts, instead of
  dangling at archived logs.
- A branch gated green and waiting for landing showed in the status view as `◇ left over` from
  an earlier run, because its outcome was only written at the end. Each pipeline's result is now
  recorded as it finishes (`green - lands when the run ends`, `gate red: ...`).
- The status view's legend wraps to the pane's width instead of losing its last clause.
- A sandbox pane in Herdr read `shipped` as soon as its gates passed, before anything had landed,
  and `gate-failed` for a red one; they now read `gated green` and `gate red`.

[Unreleased]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/henkisdabro/sandcastle-kit/releases/tag/v0.1.0
