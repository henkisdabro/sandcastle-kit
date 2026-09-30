# Changelog

All notable changes to sandcastle-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

Each release's **Upgrading** notes say what an existing project may act on. `/sandcastle update`
reads them; by hand, pull the kit and follow [Updating](docs/INSTALL.md#-updating).

## [Unreleased]

## [0.1.0] - 2026-09-30

Initial public release: an opinionated issue-burndown kit on
[Sandcastle](https://github.com/mattpocock/sandcastle). The v0.1.0 tag was first cut earlier the
same day and moved, three times, to include everything below - last after a second dry-run
audit, which found the token accounting empty and the status view clipping in narrow panes.

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

[Unreleased]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/henkisdabro/sandcastle-kit/releases/tag/v0.1.0
