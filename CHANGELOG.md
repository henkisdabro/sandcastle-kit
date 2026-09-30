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
same day and moved to include everything below.

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

[Unreleased]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/henkisdabro/sandcastle-kit/releases/tag/v0.1.0
