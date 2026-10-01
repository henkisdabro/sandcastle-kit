# Changelog

All notable changes to sandcastle-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

Each release's **Upgrading** notes say what an existing project may act on. `/sandcastle update`
reads them; by hand, pull the kit and follow [Updating](docs/INSTALL.md#-updating).

## [Unreleased]

### Upgrading

- **`jq` is now a checked requirement.** The status view always needed it; without it the view
  went blank and wrong with no error. `sandcastle doctor` now fails without `jq`, and the status
  view says it is missing. macOS 15 and later ship it; on most Linux, `apt install jq` (or `dnf`).
- A watcher that parsed the closing summary's headline: `N need you` now counts only the
  **Needs you** section, and a new `N need fixing` counts the **Needs fixing** one.
- **`sandcastle run` now refuses arguments it does not know.** It used to ignore them, so
  `sandcastle run 12 14` burned down the whole queue. It now takes ticket numbers, `--dry` and
  `--concurrency N` (the same as `ISSUES`, `DRY_RUN` and `CONCURRENCY`); a script passing anything
  else to `run` now stops with a usage line.
- `sandcastle init` on a repo whose base branch is not `main` now writes `baseBranch` for it.
  Existing projects are unchanged; a run on the wrong branch now says to set `baseBranch`.
- **Triage results now live in `.sandcastle/triage/`**, so a compacted session no longer loses
  them. Add `triage/` to the project's `.sandcastle/.gitignore`; `/sandcastle update` does it.
- **Issues are still closed on the local merge**, but the closing comment now says the work is
  merged locally and not yet pushed, and the status view shows how far the base branch is ahead.
- **A run creates a `needs-triage` label** in a GitHub project if it is missing, and agents add
  it to follow-up issues they file; the closing summary lists them under **Needs you**.
- **Inside Herdr, the status view now gets about half the screen** (run pane 25%, status 50%,
  sandboxes 25% in a column of equal rows). The run never moves your focus to its tab.
- **Tickets whose existing branches change the same file no longer start in the same run.** Before
  the pool starts, a run compares each ready ticket's existing `agent/issue-N` branch against the
  base; of an overlapping group the first in queue order starts and the rest show as blocked,
  "waits for #N (this run) - next run". A run with overlapping carried branches therefore takes
  more runs and fewer conflicts.
- **A new `generated` config key** declares generated files and the command that regenerates them
  (`generated: [{ paths, regen }]`). A carried branch whose base merge conflicts only in those
  files is regenerated in its sandbox instead of handed to the implementer. Nothing changes until
  a project sets it; `/sandcastle update` asks about lockfiles, codegen output and similar.
- **`sandcastle doctor` in a GitHub project now fails when the queue label is missing**, and its
  FIX line names the `gh label create` command that adds it. Every other FIX line now names the
  command that applies it too; there is still no `--fix` flag.
- With `generated` set, a green branch whose landing conflicts only in those paths now lands by
  regenerating them in a throwaway sandbox - one more container at landing for that branch - and
  the merged base is gated again at the end of the run.
- **A re-run of a branch that was reviewed and green, and has not moved since, skips implement and
  review.** A clean base merge goes straight to the gates; a conflicted one gets a short resolver
  prompt first. Such a re-run now costs a sandbox and the gates rather than a full
  re-implementation. Its record lives in `.sandcastle/logs/heads.json`.
- **Sandbox commits and the kit's landing merges now have a distinct git committer**, `Sandcastle
  agent <agent@sandcastle.invalid>`; you stay the author. Anything that filters history by
  committer will see the change.
- **`sandcastle build --force` now pulls the base OS image afresh**, and `sandcastle doctor` in a
  project warns when its base image is more than 30 days old. Image tags follow the Dockerfile
  text, so Debian and Node security updates only arrived with a pin bump before; run `sandcastle
  build --force` now and then.
- **The base image changed** (npm cache cleared, a build-time git version check), so every
  project's image rebuilds once on its next run.
- A watcher that parses the closing summary: merged tickets the reviewer flagged as unproven by
  any gate now count in `N need you`, listed as `merged - check by hand`.
- **Sandboxes now follow Claude Code's stable release channel and Codex's npm release**, resolved
  on the host when the image is ensured (cached for 6 hours), instead of the versions pinned in
  `docker/base.Dockerfile`. A run that crosses a release rebuilds the base image once, and every
  sandbox of a run has the same version; the start line and `run.json` record which. Set
  `claudeCode: "latest"` or an exact version such as `"2.1.285"` in `.sandcastle/config.ts`, or
  `CLAUDE_CODE_VERSION` / `CODEX_VERSION` for one run. Offline, the last resolved versions are
  used, then the Dockerfile's defaults. Every project rebuilds its image once after upgrading.
- `.sandcastle/config.ts` is checked when it loads: an unknown key (a typo such as `concurency`)
  or a wrong type (`concurrency: "two"`, `repair.attempts: -1`) is refused with the key and the
  nearest real one, where before it was ignored and the run used the default. If a command refuses
  your config after the update, fix the key it names; `/sandcastle update` does this step.

### Changed

- The skill loads less for most actions: the run action's closing hand-off and the whole
  `update` action moved into `skill/run.md` and `skill/update.md`, which `SKILL.md` names when
  they are needed.
- Tickets whose existing branches change the same file are kept out of the same run.
- `sandcastle doctor`: every FIX line names the command that applies it, with macOS and Linux
  variants where they differ.
- `sandcastle init` and the skill's init step ask about generated paths, no-touch paths and a
  drift gate when writing `rules.md`; the config template carries a commented `generated` example.
- A landing by regeneration is checked on the host before the base moves: the merge must have
  exactly the base and the gated head as parents, and change nothing outside `generated` paths
  beyond what either side changed. Otherwise nothing lands and the ticket is a conflict, with the
  paths named.
- A re-run whose only change since its last review is the base merge gets a review of the merge's
  resolution, not a full review; with nothing new since the review, none. A conflict the land-only
  resolver fixed gets the same narrow review.
- The base image clears the npm cache (about 160 MB smaller), fails its build if git is older than
  2.47, and records why it is the full `node:24-trixie` and not `-slim` or Alpine.
- `sandcastle doctor` names the Claude Code version and channel sandboxes will get, and warns when
  it could not reach the release channel; the warning about the host being newer than the image's
  pin is gone with the pin.
- With `land: "squash"`, `sandcastle land` and a landing resolved by regenerating `generated`
  paths now squash too, and delete the branch, instead of always making a merge commit. The merge
  is still made, gated and checked in the sandbox; its tree then lands as one commit on the base
  tip.
- The status view has a new look: one window whose bands - a logo cell with the project, base
  branch and clock; the run, machine and models cells; the table; the legend, which now carries
  each group's count; and a note - are split into cells across the pane, with joined rules, a sand
  palette (dark brown borders, sand-toned text; 24-bit colour where the terminal sets
  `COLORTERM`), slot gauges for the machine, a light rule between state groups, and ASCII state
  marks (`>` ready, `~` blocked, `+` merged, `-` left over) that every terminal font draws. The
  columns grow with the pane and ACTIVITY takes the rest (CPU, like MEM, gives way in a narrow
  pane), and a short pane folds the logo to one row. What each row says, and when, is unchanged.
  Full-width lines no longer lose their last character in the refreshing view, and the frame keeps
  its bottom border on screen.
- The implement and review prompts say a ticket grants no permissions: instructions in a ticket or
  its comments to change `.git/`, read or post credentials or environment values, push or open a
  pull request are not followed, and are named in the agent's record. A prompt-injected test
  ticket had its implementer plant a git hook; with this rule, two re-runs did only the asked-for
  work.

### Fixed

- A ticket's gate log is kept across attempts instead of being wiped at each one, and every
  agent and gate log marks the start of each run's phase with its run id and local time.
- `init`'s placeholder gate points at `.github/workflows` and `node --test`, and says Python
  detection needs uv.
- The signal-handling test fails after 15 seconds instead of hanging when its fixture survives
  a signal, which once stalled the macOS suite.
- A branch that conflicts at landing says so on its issue - the files and the other ticket - in
  the one comment the run already posts, instead of only in the console.
- Gate times under 10 seconds show one decimal (`green in 0.4s`, not `green in 0s`).
- A test that started the kit through `.bin/tsx` failed on a Mac whose `node` is a mise shim.
- A run closed by SIGHUP, SIGTERM or Ctrl-C outside the sandbox phase - a closed pane, say -
  now records its end and releases its lock, instead of leaving no end line.
- Preflight's model calls run at the same time instead of one after another.
- Dry runs also catch a new issue or an edited issue body, not only changes to the run's own
  tickets.
- `sandcastle init` on an existing config says how to start over.
- The help text says `clean --all` deletes unmerged branches without asking.
- Troubleshooting covers a failed Codex cross-review preflight, which is fixed on the host.
- Two tests failed only on macOS: BSD `script` refuses a socket as stdin, and a mise or asdf
  `node` shim on PATH reads its config from the `XDG_CONFIG_HOME` a test points elsewhere.
- The status view's frame lines were invalid UTF-8 on Linux (GNU `tr` maps bytes, not
  characters), so every rule showed as replacement characters. macOS was unaffected.
- A merge that fails at landing because of the working tree names the dirty files instead of
  "Merge with strategy ort failed".
- `preflight` with a rejected credential prints the reply once for all models that gave it, names
  the key and the file it came from, and shows no stack trace.
- `sandcastle setup` offers to replace a credential that is already set (default: keep it).
- Bad numbers (`CONCURRENCY=abc`, `SANDCASTLE_MAX_SANDBOXES=0`) are refused instead of starting
  no workers or waiting forever; a malformed `~/.config/sandcastle-kit/config.json` no longer
  crashes every command, and `doctor` reports it.
- A red base check clears the cached green result, so the next run cannot skip a base known to be
  red.
- `needs-human` is no longer re-created with `--force` on every hold, which reset a repo's own
  colour and description for it.
- The closing summary's next step for a conflicted ticket names what exists: the next run resumes
  its branch, or merge it by hand.

- Every command prints a refusal - an unknown command, a missing config, credentials, the run
  lock, a red base gate, preflight, `init` on an existing config - as a message with no stack
  trace. Only a real kit bug keeps one.
- The status view no longer shows an empty queue when reading the queue fails (a signed-out
  `gh`, a rejected token): it says it could not read it, and why.
- An agent handing a ticket back no longer fails on a repo without an `agent-blocked` label,
  which left the ticket with no labels at all. The kit's label was never read; the hand-back now
  creates `needs-human` if missing and adds only that.
- The closing summary's headline no longer contradicts its sections: `- X need you - Y need
  fixing -`.
- A ticket's commit count in the close comment and run summary leaves out the kit's own merges
  of the base into a carried branch.
- `sandcastle setup` checks a saved GitHub token live instead of trusting its prefix, and offers
  to replace one GitHub rejects.
- The summary's "Same failing test" grouping recognises node:test (TAP and spec), Go and cargo
  failures, not only pytest, vitest and jest.
- A warning when `gh` returns its limit of 500 issues, so issues beyond it are not silently
  missed.
- A run adopting its Herdr tab keeps a label the operator gave it, renaming only a default one.
- The lean check warns when `.claude/settings.json` defines hooks but git does not track it, so
  sandboxes would never get them.
- The skill copies the closing summary's headings exactly as `sandcastle report` prints them,
  emoji included, instead of rewriting them.
- Docs: `rules.md` reaches the implement, review and repair prompts but not the kit's own landing
  merge; and what green gates prove - the gate commands, and nothing more.
- Blocker phrases inside fenced or inline code are no longer read as dependencies; write a blocker
  as plain text.
- Tests: the signal test sends SIGINT a second time after 5 s, as an operator would, instead of
  failing a loaded macOS suite on a rare unacted first signal.
- A run that stops on red base gates says so in its closing summary: `Run stopped: red on <base>
  before any agent ran`, `0 attempted`, the failing gates, and a fix-the-base next step. It used
  to read as 'N attempted, 0 merged' with no cause.
- `sandcastle init` no longer glues its first `.gitignore` entry onto a last line with no final
  newline (which could leave `.env` unignored).
- Tests: the guard test's commits keep their test identity inside a sandbox, where the agent
  committer's environment would otherwise override it.
- A failing `gh` call (signed out, no such issue, no network) is a one-line refusal naming the
  call and gh's own message, not a Node stack trace - `sandcastle land 999` and `sandcastle
  requeue 999` used to crash.
- A closed ticket in `ISSUES` (or `sandcastle run <n>`), and an unknown ticket-file id, are
  refused with one line instead of a stack trace.
- `.env.example` no longer says a project's `.sandcastle/.env` can override every key:
  `LINEAR_API_KEY` is refused there.
- `SANDCASTLE_ALLOW_BROAD_TOKEN=1`, which accepts a `GH_TOKEN` that is not fine-grained, is
  documented, as an escape hatch for throwaway repos.
- Preflight for a model the CLI does not know (a mistyped `model:` label, say) prints the CLI's
  reason instead of its whole JSON reply.
- A run creates the `needs-triage` label on a repo that has no label like it, instead of warning
  `Unexpected end of JSON input`, and `sandcastle doctor` reports a missing queue label with its
  FIX line instead of skipping the check: `gh label list --search` prints nothing, not `[]`, when
  nothing matches.
- The status view's AGE column no longer shows a negative age (`-1s`) for a state the run wrote
  while the frame was being drawn.
- The closing summary says a ticket with nothing to change is left open, and its next step says to
  read the agent's comment and close it, since a still-queued ticket is tried again by every run.
- A run stopped by a red base no longer tells you to push the base branch (it says not to until
  its gates are green), and its message counts the base branch's own code among the causes instead
  of ruling it out.
- The closing summary's step for a red or conflicted ticket offers `sandcastle land <ticket>`
  (naming it when there is one) instead of a hand-written `git merge`, which skipped the kit's
  gates and close comment.
- A dry run with several green branches no longer reads as if they would all merge together: the
  summary says each was gated on its own and points at `sandcastle preview`.
- A run cut short (Ctrl-C, a crash, a killed process) no longer reports "Run finished" with its
  unfinished tickets counted as attempted and listed nowhere: the summary says the run ended
  early, names each ticket it cut short (with its phase) or never started, and says the next
  `sandcastle run` picks them up. The run pane says where the summary is when the run ends before
  printing one.
- A resumed branch no longer prints "Could not fetch from origin", which read as a network fault
  (agent branches are never pushed, so there is nothing to fetch); it says the branch is resumed
  in its kept worktree. A worktree kept after an interrupted sandbox points at `sandcastle clean`,
  not a hand-run `git worktree remove --force`.
- A merged ticket whose close failed is no longer reported under Done as "Closed on GitHub" when
  nothing was closed: Done says it is merged but still open, and failure reasons in the summary
  drop the `Error: ` prefix.
- Outside a repository, git's own `fatal: not a git repository` no longer prints above every
  command, help included, and an unknown command or a typo is called that ("Did you mean
  `sandcastle status`?") instead of "Not inside a git repository".
- `sandcastle doctor` gives the fix for what is actually wrong: Docker or `gh` not installed is
  told to install it (not to start it, or to sign in), a git older than 2.31 is a FIX, a missing
  `GH_TOKEN` is reported as missing rather than as "not fine-grained".
- A malformed personal `config.json` is reported in a full sentence, not run into the fix that
  follows it.
- Ctrl-C at a `sandcastle setup` question ends setup quietly, as it already did at a token prompt,
  instead of printing a Node `AbortError` stack trace; at the autonomy level-1 question it counts
  as no.
- A GitHub-tracker project with no git remote is told so: `sandcastle doctor` flags it, and
  `queue` or a run names the fix (add a remote, or `tracker: "files"`) instead of gh's bare "no
  git remotes found". A failing `gh` or `git` call no longer echoes its raw stderr above the kit's
  explanation of it.
- `sandcastle init` on an existing config names the command that moves it aside, instead of saying
  git keeps the old one (it does only once committed).
- A syntax or runtime error in `.sandcastle/config.ts` is one line naming the place, not a Node
  loader stack trace.
- `CROSS_REVIEW=1` on a machine without the Codex CLI is refused before anything is spent, with
  the install command, instead of preflight reporting `spawn codex ENOENT` (or, with preflight
  skipped, every ticket's cross-review failing one by one).
- The status view no longer tells a queued ticket it is "1 ahead of it" when the run has a free
  sandbox for both; a merged row shows the commits it landed rather than 0; a project whose logs
  were all archived shows "(nothing to show)" rather than "(no runs yet)"; and below 80 columns
  the legend no longer explains a CPU column that is not there.
- Offline, `sandcastle doctor` said "GitHub CLI signed in" was the problem and told a signed-in
  user to run `gh auth login` (gh calls a good token invalid when it cannot reach GitHub). It now
  checks whether GitHub answers and, when it does not, says to check the network. A failed `gh`
  call elsewhere (`queue`, `run`, `land`) now ends with what to do: check the network, sign gh in,
  or run `sandcastle doctor`, rather than gh's bare line.
- A project Dockerfile that fails to build ends in one line naming the file to fix, under docker's
  own output, instead of a Node stack trace. A `.sandcastle/Dockerfile` the config does not name
  (`dockerfile:`) is reported as not built rather than skipped in silence.
- A full disk is a message, not a stack trace: the launcher checks that the temp directory can be
  written before tsx starts (tsx died there first), and a write the disk refuses anywhere else
  says the disk is full and what frees space.
- `USAGE_CHECK=1` with a bad `USAGE_STOP` is refused before the run does anything, instead of
  after the image check and preflight. An unknown usage reading says why - the endpoint's HTTP
  status, or no answer - instead of always "rate-limited"; a token the endpoint refuses (HTTP 403)
  is named, as the guard is then off for it.
- "Another sandcastle run of this project is live" (from `run`, `land` or `clean`) now says what
  to do: wait for it to end (`sandcastle status` shows it), or stop it with Ctrl-C in its
  terminal.
- The `.git` tamper stop names the file that changed (`.git/config`, or a file in `.git/info/`)
  instead of "`.git/config` or `.git/info/`", so it can be checked without guessing.
- A gate that hits its 45-minute bound reads as one: `test=TIMEOUT` in the gate line and the
  report, `RED (timed out after 45 min)` in the gate log, and the failure output starts by saying
  so, instead of a bare exit 124.
- A `sandcastle run` stopped with SIGTERM (`timeout`, `kill`, a closing terminal) while busy in a
  git or Docker call now ends through its exit handler - recording its end, notifying, and
  stopping its sandboxes - instead of being SIGKILLed by the tsx wrapper it ran under. The
  launcher now runs one node process with tsx's loader.
- A review or cross-review that fails says why in one line (`claude-code exited with code 1 -
  unrecognized model`) instead of the library's two-line error cut off mid-JSON.
- A ticket an agent hands back is no longer always "answer it, then requeue it": the report says
  to read the agent's comment, then do work only a person can do and close the ticket, or answer a
  question and requeue it.
- Blockers that hold a queued ticket for good, or let it start too soon, are named with the fix in
  `sandcastle queue`, at the start of `sandcastle run` and by `sandcastle blockers`: a blocker
  that does not exist, tickets that wait for each other, a Linear blocker that cannot be read (no
  `LINEAR_API_KEY`), and a `Blocked by ENG-42` whose key `blockers.linear` does not name (ignored,
  so the ticket started at once). Each was silent. `sandcastle blockers` also finds a ticket
  file's `Blocked by: 01` written in a comment, and a tracker named in
  `docs/agents/issue-tracker.md` keeps its own capitals in doctor's note.
- **Security:** a hook a sandbox writes into the shared `.git/hooks/` now stops the run like a
  changed `.git/config` does. The run itself has hooks off, but such a hook ran on the operator's
  next `git checkout` or `git commit` in that repository; a prompt-injected implementer wrote one
  in a test, and only its reviewer happened to remove it.
- A landing or `sandcastle land` that fails because git could not sign the merge commit (commit
  signing on, its agent locked) says so and what to do, instead of git's bare "failed to write
  commit object".

### Added

- Each run's final record is appended to `.sandcastle/logs/history.jsonl`, so earlier runs'
  outcomes are no longer lost when the next run starts.
- `sandcastle init` ends by naming the next steps, and an empty `sandcastle queue` counts the
  open issues not yet queued and says how to queue them.
- CI runs the checks on macOS as well as Linux, and the status view under macOS's bash 3.2.
- `sandcastle doctor --verify` checks the GitHub and Claude subscription tokens live, and prints
  which file each came from with a fingerprint, never the value. Plain `doctor` stays offline.
- `NO_COLOR` is honoured: the status view drops colour (as it now also does when piped), and
  `sandcastle report` uses plain headings without emoji.
- `sandcastle gates` and the run's base check print each gate's command next to its result.
- The closing summary shows tokens with the cached share, per model.
- The skill's `queue` action carries a complete triage brief for its subagents.
- README: a gate recipe that checks generated files are committed in sync with the build.
- Tests for the protected-path check, blocker references and ticket files, and `init`'s stack
  detection.
- `generated: [{ paths, regen }]` in `.sandcastle/config.ts`: a base merge conflict confined to
  those paths takes either side, runs `regen` in the sandbox and commits.
- Each ticket's last reviewed head and last green head are recorded in
  `.sandcastle/logs/heads.json`, for re-runs to build on.
- `sandcastle doctor` warns (without failing) when the host's Claude Code is newer than the
  version the image pins.
- A skill-only `audit` action (`/sandcastle audit`): review lenses run as read-only subagents on
  the host, and their findings are filed as issues by the queue's criteria. The steps live in
  `skill/audit.md`.
- Before its slow steps, a run prints a rough token and time estimate from the medians of the
  project's earlier tickets (`timings.jsonl`), once there are any.
- Landing resolves a conflict confined to `generated` paths by regenerating them in a throwaway
  sandbox, then fast-forwards the base; the ticket's closing comment says so.
- `sandcastle land <n>`: merge one ticket's branch with the kit's message, gate it in the project
  image (regenerating `generated` paths if they conflict), then comment and close on green. A
  conflict outside `generated` stops with the files named.
- `sandcastle requeue <n> [--note "..."]`: put a ticket back in the queue with `needs-human`
  removed and the note as a comment, for GitHub and ticket files. It also forgets the ticket's
  recorded green head, so the next run re-implements rather than landing the old branch.
- `land: "merge" | "squash"` in `.sandcastle/config.ts` (default `merge`). Squash keeps the
  subject `Merge agent/issue-N (closes #N)` and deletes the squashed branch after landing.
- Each agent pass also writes its raw stream to `agent-issue-<id>-<phase>-<id>.jsonl` beside the
  readable log, archived with it - every tool call and result, not only what the readable log
  shows.
- `sandcastle preview`: dry-merges each unlanded agent branch against the base in landing order
  with `git merge-tree`, inside the project image, and names the conflicting paths. Nothing is
  written to the repository.
- `model:<id>` and `effort:<level>` GitHub labels set the implementer's model and effort for one
  ticket, checked (and preflighted) before any sandbox starts.
- `autonomy` (config) and `AUTONOMY_LEVEL` (env): one `sandcastle run` re-runs its conflicted and
  newly unblocked tickets. Level 1 asks first (and only prints the command when stdin is not a
  terminal), level 2 re-runs once, level 3 up to twice. Off by default.
- The reviewer flags a change no gate exercises; the closing summary lists such merged tickets
  under **Needs you** as `merged - check by hand`, with what to check.
- `notify` in `~/.config/sandcastle-kit/config.json`: an argv command run when a run ends (also on
  Ctrl-C or a closed pane), with `SANDCASTLE_NAME`, `SANDCASTLE_SUMMARY` and `SANDCASTLE_EXIT` in
  its environment. It never fails the run.
- `sandcastle doctor` checks git's `user.name` and `user.email`: the kit's merges and ticket
  commits carry the operator as author, and without them git refuses them at landing (after the
  run has spent its tokens) or signs them with a guessed name and hostname address.
- `sandcastle doctor` flags a credentials file (the personal or the project's `.env`) that other
  local users can read, with the `chmod 600` that fixes it.
- `sandcastle lean` and the run's Lean line warn about a `lean.keep` entry that names nothing the
  repo has, and a `lean.dropHooks` string that matches no hook: a typo there kept or dropped
  nothing, without a word.
- `sandcastle doctor --verify` in a GitHub project checks that `GH_TOKEN` cannot push there, with
  a probe that writes nothing, and makes a token with Contents: write a FIX. The sandboxes get
  that token, so a ticket that talks an agent into pushing is stopped by its scope; before, only
  its prefix was checked.

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
- A run that will not start on a dirty tree or the wrong branch now says so without a stack
  trace, and lists the uncommitted files (the first ten) that are in its way.

### Fixed

- Inside Herdr, a run's tab opens in the workspace the run was started from, not in whichever
  workspace had focus when the tab was created. Both the skill's run tab and the kit's own view
  tab name their workspace now.

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
