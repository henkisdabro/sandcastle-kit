# Changelog

All notable changes to sandcastle-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

Each release's **Upgrading** notes say what an existing project may act on. `/sandcastle update`
reads them; by hand, pull the kit and follow [Updating](docs/INSTALL.md#-updating).

## [Unreleased]

### Added

- **`logs/timings.jsonl` has a `landing` line for every landing that reaches its merge**,
  fast-forwards and conflicts included, with its wait for a machine-wide sandbox slot as `waitMs`.
  A requeued ticket's wait to resolve behind the tickets ahead of it is added to the `waitMs` of its
  second `setup` line. The estimate and a ticket's usual time leave the new line out.

### Changed

- **A branch that no longer merges onto the base is found on the host before it takes a landing
  sandbox slot**, so it is requeued or held without starting a sandbox. A conflict only in
  `generated` files still goes to the sandbox, as does every landing on git older than 2.38.
- **A ticket whose branch stops merging onto the base while it runs skips its review and gates**
  and goes straight back to resolve the merge, instead of finding the conflict only at landing. It
  is sent back once, as a conflict at landing is.
- **The end-of-run verify no longer re-gates a merged base tip that a gate-only sandbox already
  passed**: a landing merged in a sandbox, the base check or an earlier verify. The summary says
  whose gates proved it (`Merged main re-gated: green at <sha> already on image <tag> (gated with
  #427 in its landing sandbox) - not run again`). A fast-forward landing's proof is its ticket's own
  sandbox, which can differ from a clean one (its agent's git identity, say), so after one the
  verify still runs - for a run that lands a single ticket too, where it used to run only after two.
- **Beside another run, a run whose share of the machine's sandbox slots is 2 or more keeps one
  slot of that share for landing**, so a green branch no longer waits for a ticket to finish before
  it can land.
- **A wait for a sandbox slot is now the run's, not a ticket's.** The heartbeat says how long the
  run has waited without naming a ticket, the status view shows `waits for the run's share` on the
  tickets next to start, and the closing summary no longer says `waited Xm for a slot` on a
  ticket's line.
- **When a run stops because `.git/config` changed, the stop names each changed key**, with its
  old and new values, except for keys that run a program, load more config or carry a credential;
  a token in a URL is hidden in key names and values alike.
- **The closing summary's Needs you section lists the follow-ups filed for triage, and the issues
  opened during the run, under a `### To triage` sub-heading** after the run's own items, so the
  headline's "need you" and "to triage" counts each match their bullets.

### Security

- **A merge driver a sandbox wrote into the shared `.git` no longer runs on the host.** Every host
  `git merge-tree` (the conflict checks before review and before landing, and the check of a
  conflict resolution) runs in a throwaway git directory that borrows only the project's objects,
  so a driver set in `.git/config` and mapped in `.git/info/attributes` is never read, and nothing
  is written into the project's object store.

### Fixed

- **A branch another worktree gives an upstream in the shared `.git/config` no longer stops a run
  as `.git` tampering** (`git worktree add` from a remote branch, `git push -u`, `git branch -u`,
  `gh pr create`). The guard compares the config by key, and lets through only
  `branch.<name>.remote` and `.merge` of a branch that is neither the base nor an `agent/issue-*`
  branch.
- **A ticket released when its last blocker lands, or sent back after a conflict, really starts at
  the next free sandbox slot.** Before, it waited behind every later ticket already waiting for a
  slot, which happened at every release when a run had more workers than its share of the machine.
- **A drain turn after a landing no longer opens a base sandbox for the hook checks** when the
  landed diff touched no hook directory, kept hook script, package manifest, lockfile or protected
  path. A landing that changes one still gets the full hook check.
- **The heartbeat no longer counts a wait for a gates slot as gate time** (it says `gates: waiting
  for a gates slot` and counts from the first gate), and it names landings in flight and tickets
  waiting to resolve a conflict, so it is no longer silent while only those run.
- **A requeued ticket's wait to resolve its conflict is said once**, after its list of tickets has
  held for a few seconds, instead of one line per change. A ticket still running is worded "lands
  or leaves the run" rather than "has landed".
- **Follow-up filing no longer merges two findings because their evidence cites the same line**,
  now merges findings that name the same file with close titles, and no longer reads a host and
  port such as `api.example.com:443` as a place.
- **A red end-of-run verify on a tree a ticket's own gates passed is no longer called "RED
  TOGETHER"** (every landing a fast-forward, say). The summary says the red is the verify sandbox's,
  not the merge's, and its next step says the same. On a tree a landing sandbox already passed, a
  clean one like the verify's, it says a test is likely flaky or order-dependent.
- **A red end-of-run verify names its failing tests** (up to five, then "and more") above the
  output excerpt and on the summary's re-gated line, not only in `verify-gates.log`.
- **Sandboxes can no longer call the EnterWorktree, ExitWorktree, Workflow, DesignSync or
  PushNotification tools, and the git guard refuses `git worktree add` in the shared repository**
  (a scratch repository's own is still allowed), so an agent cannot leave a worktree record or
  branch in the shared `.git`.
- **A run that ends with a red merged base exits 1**, and records `exitCode: 1` in `run.json`, at
  every autonomy level, so `sandcastle wait` no longer reports success on a base the summary says not
  to push.

- **A ticket the run merged but whose tracker close failed no longer holds its dependants** for the
  rest of the run: a landed ticket counts as closed for them.
- **A landing merge that git's own merge says conflicts is refused again.** The host's tree check
  read every `merge-tree` failure as a git older than 2.38 and stepped aside; it now asks git's
  version instead.
- **The live status view keeps running with no terminal** (an agent's tool, a pipe), instead of
  drawing one frame and ending on `TERM_COLS: unbound variable`.
- **The status view's ETA floor for landings works again.** The typical landing-gates time is taken
  over tickets that landed; held, red and conflicted tickets counted as landings of 0 and made it 0.
- **A ticket requeued after a red landing that then conflicts, or the reverse, is no longer said to
  have done it "again"**: the note says the requeue was for a red merge, or for a conflict.

### Upgrading

- **`sandcastle run` and `sandcastle wait` now exit 1 when the merged base re-gated red.** A script
  or harness that treated exit 0 as "safe to push" needs no change; one that treated any non-zero
  exit as a crash should read the closing summary (or `run.json`'s `verify`) before retrying.

## [0.10.0] - 2026-10-07

### Added

- **The run names a ticket that waits long for a sandbox slot.** The heartbeat line names one
  that has waited longer than a typical ticket takes, the closing summary's line for a ticket names
  a wait of three minutes or more (`8m, waited 2h for a slot`), and the wait is recorded as
  `waitMs` on the ticket's first `setup` line in `timings.jsonl`.
- **A ticket whose `Touches:` line names a path the kit always holds for a person to merge is
  named in the start plan** (`#N will be held for a person to merge (paths)`), and its live "needs
  a human" line carries the reason instead of leaving it to the closing summary.
- **The closing summary lists a merged ticket whose reviewer named a known gap in prose**
  ("left alone", "remains", "not fixed") without a `<followup>` or `<unmet>` line, under Needs you
  with the reviewer's sentence. A sentence that says nothing is left ("the remaining tests pass",
  "covers the gap the ticket describes") is not taken for one.

### Changed

- **The status view's AGE column is now TIME.** A working ticket still shows its time in the
  current state (red at twice the usual); a finished ticket shows its whole length, first start to
  end, during the run and after it.
- **The start plan names each mergeable file that tickets share once, with its tickets**, instead
  of a line for every pair. README.md and CHANGELOG.md are one count, and the full pair list goes
  to `.sandcastle/logs/file-shares.log`, under a line per turn naming its time and the run's pid.
- **The start line says the slot kept for landing is kept only while no other run takes a share
  of the machine's slots.** Beside one, tickets may fill the run's share, and a landing still goes
  first when a slot frees.
- **Agents count an existing test re-fitted to pass as a weakened test.** An implementer names
  each expected text or fixture it changed (a width, a timeout) unless the ticket changes that
  behaviour, and a reviewer undoes the ones it does not. A reviewer also fixes a side effect its
  branch causes outside the ticket, instead of filing it as a follow-up.
- **The start line, the skill and the README say that another worktree shares `.git/config`**,
  so a branch given an upstream there (`git worktree add` from a remote branch, `git push -u`,
  `gh pr create`) stops the run as a commit on the base does; `--no-track` or
  `git push origin HEAD:<branch>` avoid it.
- **A ticket that waits for a blocker in the same run is named once in the start plan**, its own
  line naming the blocker (`- waits for #446 in this run`), instead of again under the list.
- **The start plan says `up to N at a time`.** Beside another project's live run, the plain
  figure sat above `this run's share is 1` and an estimate for one at a time, as though the run
  would start two.

### Fixed

- **A ticket no longer waits hours for a sandbox slot while later tickets of the same run
  start**: a freed slot goes to the run's longest-waiting ticket, not whichever worker asked at that
  moment.
- **A ticket waiting for a machine-wide slot says why once, then every 15 minutes**, instead of a
  line each time the reason flips between "share" and "in use".
- **A requeued ticket waiting to resolve its conflict no longer holds a pipeline worker**, so the
  tickets queued behind it start while it waits.
- **A landing's or verify's green record no longer lets the next turn's base check skip the hook
  tests and the git-hook probe.** A ticket that changed a commit hook and landed green could have
  had every agent commit of the next turn refused; the base check now skips only the gates.
- **A drain turn after a single fast-forward landing no longer gates the base again**; it still
  runs the hook tests and the git-hook probe.
- **Follow-ups that a ticket's implement and review passes give for the same `path:line` are filed
  once**; the later one becomes a comment on the first issue.
- **A ticket the run put back and ran again keeps its first start time** in the run record, and a
  third send-back after a conflict records three attempts, not two. Each attempt's own start is
  recorded too (`attemptStarted`), which the ETA counts from.
- **A stop that arrives during a pause, before a ticket's first step, ends that ticket as not
  started** instead of parked; a requeued ticket keeps the ending of its first landing.
- **A guard stop during a pause clears "paused" in the Herdr sidebar and tab bar at once**,
  instead of when the tickets still in flight finish.
- **With `herdr.panes: "all"`, closing the status pane no longer turns the whole Herdr view off**
  when the first ticket claims a sandbox pane: the run says once that the status pane closed, and
  the sidebar, tab bar and notifications carry on.
- **A Herdr view that turned itself off no longer reports to Herdr at the run's exit**, where a
  status pane found gone printed "Herdr status pane closed" after the "view off" line.
- **A sandbox pane closed by hand while it waited for the next ticket no longer turns the run's
  Herdr view off** when that ticket claims it: the pane is forgotten and the ticket gets another.
- **A ticket held behind another held ticket no longer reads "(lands this run)" once the run
  stops**; it says the blocker did not land.
- **The status view's legend no longer cuts a note at 80 columns.** The TIME and partly-done notes
  are two short ones each, so they wrap instead of losing their ends, and the website's demo fits
  its TIME column on a phone.

## [0.9.0] - 2026-10-07

### Upgrading

- **The kit needs Node 22.18 or newer.** It now runs its TypeScript on Node's own type stripping
  instead of tsx. `sandcastle` on an older Node says so and stops; install Node 24 LTS (or any
  22.18+), then `pnpm -C <kit> install`, which removes tsx. Update between runs: a detached run
  started before the update starts its next turn with the old loader.
- **A project's `.sandcastle/config.ts` loads on Node's type stripping too.** A config that uses
  only type annotations, `satisfies`, `as` and `import type` (as `sandcastle init` writes it)
  needs nothing. An `enum`, a `namespace` or a constructor parameter property no longer loads:
  `sandcastle` names the file and the place; replace it with a plain object or field.
- **A branch that ended red before this version is gated and repaired on its next run, not
  implemented again**: its red result was not recorded then. Run `sandcastle requeue <ticket>`
  first to have it implemented afresh.

### Added

- **`sandcastle usage`** prints the plan's 5-hour and weekly usage between runs, read-only: the
  newest reading a run recorded (under 10 minutes old), else one request to the usage endpoint.
  With an API key in use it says the sandboxes spend API credits, not a plan.
- **`sandcastle report --changelog [--since <ref>]`** lists every ticket the runs landed since a
  ref (the latest tag by default), across runs, with the agents' suggested changelog lines grouped
  Added, Changed, Fixed and Upgrading, and the tickets with none listed apart.
- **The status view has a TOKENS column**: each ticket's tokens in/out, cache counted in "in",
  the pass running now included. CPU and MEM become one CPU/MEM column. From 100 columns both
  show, from 80 only TOKENS, below 80 neither; an ended run's rows keep their figures.
- **The closing summary shows Codex's plan usage** beside Claude's when cross-review ran on a
  ChatGPT plan.
- **`sandcastle queue --lint` lists `Touches:` paths not on the base branch**, and globs that
  match nothing, so a typo is caught before a run.
- **`sandcastle doctor` names triage labels mapped in `docs/agents/triage-labels.md` but missing
  on GitHub**, with the `gh label create` command; `/sandcastle queue` creates one before applying it.
- **`pnpm test:weights`** measures the suite one file at a time and prints a `WEIGHTS` block for
  `test/shard.ts`.

### Changed

- **The status view draws a frame with about a third fewer processes.** Its helpers set a
  variable instead of printing into a subshell, the run record is read by one `jq` instead of
  a dozen, and lookups by ticket stay in bash instead of piping through `awk`. On macOS, where
  starting a process is slow, the view's test of 61 frames went from 60 s to 43 s. A run record
  caught half-written no longer stops the view with an unset variable.
- **Commands start about twice as fast.** The kit runs on Node's own type stripping, not tsx's
  loader: `sandcastle help` and the Herdr tab bar's `sandcastle herdr line`, which runs every 10
  seconds, took about 0.4 s against 0.8-1.2 s. A project whose `package.json` says
  `"type": "commonjs"` still has its config loaded as an ES module. The kit has one dependency
  fewer, and tsx's cache in the temp directory is gone.
- **The kit's own checks wait less on the status view's test.** `test/full-check.sh` runs it as
  a leg of its own instead of ahead of the test files: 412 s became 246 s on a 15-core Mac. CI's
  macOS status job runs it under both bashes side by side, not one after the other: its four
  minutes made it the slowest job of every pull request.
- **The run estimate prices gate and landing times from runs at a similar concurrency**, and
  says when it has no history at this one. A ticket requeued in the same run is priced from its
  resolve, review and gates, not its whole first attempt.
- **Inside Herdr a run reuses the previous run's status pane** when it is still there, so the
  view stays where you put it instead of opening a new tab each run.
- **A run's start tells you not to commit, pull or merge on the base branch in its checkout
  until it ends**: the guard cannot tell your commit from a sandbox's, and stops the run.
- **The pool warning and `sandcastle size` price each figure at the 90th percentile of recent
  samples**, so one outlier pass no longer sets every later warning, and `size` shows the sample
  count. The pool warning no longer fires from an agent figure that counts page cache.
- **A ticket sent back after a landing conflict resolves once the green branches that share its
  files have landed**, and a conflict caused by a landing that finished mid-resolve sends it back
  once more instead of ending it.
- **The settings row and the closing summary name the usage pause** (`usage pause at 90%`)
  beside the usage guard.
- **Agents limit every test they run by hand** (`timeout 300`) and pick a heredoc delimiter the
  edited file cannot contain, after a single-file run hung a pass for 15 minutes.
- **`test/full-check.sh` names its log directory at the start and prints each leg as it ends.**
- **The skill reads `.sandcastle/logs/run.json`** for a run's state instead of scraping the status
  table, and points at `sandcastle usage`.

### Fixed

- **`test/full-check.sh` no longer reads a repo path as a home directory.** Its outbound scan
  flagged any added line with `/home/` in it, so `site/home/index.html` failed as though it named
  a user's home. `home` now counts only where a path starts; macOS's `Users` still counts
  anywhere, so WSL's `/mnt/c/Users` form stays caught.
- **Website release versions are checked before deployment**, alongside the Herdr manifest,
  site software metadata and README badges. `pnpm version` synchronises current version fields
  from `package.json`; `pnpm version:sync` repeats it after a manual edit, and a regression test
  catches missed updates. Pages deploys `main` even for release events, so an old release cannot
  restore a stale website. The site now describes pause/resume, subscription usage and opt-in
  usage pause, CPU and memory controls, partly-done tickets and filed follow-ups, and corrects
  the cost FAQ, Herdr click hints and Linux requirements against the last three releases.
- **A stop during a pause ends the run at once**, its parked tickets listed under Runnable now,
  instead of leaving it paused until the window resets. A ticket waiting for another's fix parks
  through a pause instead of holding its sandbox slot.
- **A person's `sandcastle pause` is no longer overwritten by the run's own usage pause**: the
  control file's writes take a short lock.
- **A pass re-run after hitting the plan's limit is no longer taken for another limit hit** when
  it fails early for another reason, on the pause path and the crash path alike.
- **A guard stop is announced the moment it holds** (`STOPPED landing: ...`), its ticket notes and
  unfiled follow-ups name what moved (`main moved while sandboxes ran`), and a waiting ticket names
  how its blocker ended.
- **A branch stopped while its gates ran goes straight to the gates on re-run**, not to a whole
  implement session.
- **A drain turn no longer re-gates a base commit the previous turn's verify or last landing
  passed**, and says `green at <sha> already (verified this run)`.
- **A closed, moved or lost Herdr status pane no longer turns the run's whole Herdr view off**:
  the sidebar and the end notification carry on.
- **A run killed without its exit handler keeps its record**: the next run appends it to
  `history.jsonl` first.
- **The test suite gives every file the same environment** (canonical `TMPDIR`, the running node
  on `PATH`, no host `HERDR_*` or kit settings), and fails on a real home-directory path in a
  tracked file, so sandbox gates catch what only the pre-push check did.
- **A released changelog section that differs from its tag fails the tests.**

## [0.8.0] - 2026-10-06

### Upgrading

- **Tickets may carry a `## Seams` section.** `/sandcastle queue` and `audit` add one where a
  behaviour change's test boundary is not obvious, naming the interface a test should drive.
  Existing tickets need nothing: without it, the implementer tests at the highest existing public
  interface.
- **Runs cap each sandbox's CPUs by default**, gate sandboxes included, and so do `sandcastle gates`
  and `sandcastle land`. A project whose gates need more than their share sets `cpus` in
  `.sandcastle/config.ts` (a number, or `false` for no limit).
- **A run files its agents' follow-ups itself**: on GitHub as issues with the `needs-triage` role's
  label, with ticket files as new committed files with that status, next to the source ticket. Map
  the role in `docs/agents/triage-labels.md` to use another label.
- **Run `sandcastle size` again after your first run on this version** and act on its
  recommendation then. Earlier versions priced a gate from memory read at rest (about 0 GiB) and
  recommended a pool larger than the VM fits; older `peaks.jsonl` lines' anonymous figures are now
  ignored, so the first run's readings are what it prices from.
- **Herdr users run `sandcastle herdr configure --yes` once more**, so the sidebar block gains the
  `$sc_usage` row with the plan's usage (`/sandcastle update` has a step for it).
- **A run can pause itself before a plan window runs out** - opt in with `USAGE_PAUSE=90` or
  `usagePause: 90` in `.sandcastle/config.ts`. Off by default; nothing changes until you set it.
- **On Linux, `sandcastle doctor` and `sandcastle run` refuse Podman behind `docker` and rootless
  or userns-remapped Docker, and on any OS a run as root**, where the agent could not write its
  worktree. Linux needs rootful Docker Engine and a normal user in the `docker` group.

### Added

- **`sandcastle doctor` and a run's start line warn when the pool needs more memory than the VM
  has**: `maxSandboxes` and `maxGates` priced together, gates at a gate's recorded anonymous memory
  and the other sandboxes at an agent's, never at `memory.peak` (which counts page cache). It names
  both numbers and the `config.json` key (or `SANDCASTLE_MAX_*`) to set.
- **A ticket red on a test another ticket is already repairing waits for that landing**
  (`#N: waiting for #M's fix to <test>`), merges the new base and gates again, instead of starting a
  repair that conflicts at landing. If the other ticket fails or gives up, it repairs as before.
- **Each sandbox gets a CPU limit** (`docker run --cpus`), so agents' own full-suite runs, which
  `maxGates` does not limit, no longer slow every gate beside them. A ticket's sandbox gets the VM's
  CPUs divided by the run's concurrency, at least 2; the landing, base and verify gate sandboxes get
  the VM's CPUs divided by `maxGates`, so the one-at-a-time landing gate that sets the run's end is
  not starved. The project config's `cpus` overrides both (a number, cut to the VM's CPUs, or
  `false`; below 0.01 is refused as the config loads), the run's start line names both limits
  (`Sandbox CPUs: 2 each, 6 for landing and base gates`), and `sandcastle gates` and `sandcastle
  land` apply the same limits.
- **`sandcastle pause` and `sandcastle resume` hold a live run without losing work**: no new ticket
  or agent pass starts, the passes in flight finish and their sandboxes close (branches kept), green
  branches still land, and the run gives its sandbox slots to other runs and lets the machine sleep
  until `resume` continues each paused ticket from its next phase in the same run. The status view
  reads `PAUSED since 15:40 - finishing #12 review, #14 landing`, Herdr's sidebar and tab bar say
  `paused`, and a run stopped while paused lists its parked tickets under Runnable now. The skill
  gets `pause` and `resume` actions, so "pause the run" or "carry on" works through your agent; a
  hold is never turned into `sandcastle stop`, and a stop is confirmed first.
- **The status view shows the plan's 5-hour and weekly usage** (bar, percentage, reset time and
  the reading's age; amber from 75%, red from 90%) while a run spends a subscription on a Claude
  model, read from the agents' own rate-limit events at no cost in requests. With `CROSS_REVIEW=1`
  and Codex signed in with a ChatGPT plan, Codex's windows get a line of their own beside Claude's.
  Herdr's sidebar gets an `sc_usage` token (`claude wk 93% · codex wk 16%`), and the closing summary
  a `Plan usage at the end:` line.
- **Opt-in usage pause**: with `USAGE_PAUSE=<percent>` (or `usagePause` in the project config) a
  run pauses itself when a 5-hour or weekly window of a provider it uses reaches the threshold, and
  resumes a minute after that window's reset. An agent that hits the limit anyway parks its ticket
  until the reset instead of stopping the queue. The PAUSED cell names the cause (`PAUSED - weekly
  usage 95%, resumes Wed 06:01`), the start line says the setting, and a person's `resume` or
  `pause` overrides it, across a multi-turn run's turns too.
- **The `Merged <base> re-gated` line names the image the verify ran on**, and says when a merged
  ticket changed a Dockerfile, so the verify ran on the run's starting image.
- **The closing summary names the tickets that landed on a second attempt** after being sent back
  at landing.
- **Agents name each problem they find outside their ticket in a `<followup>title - evidence</followup>`
  line, and the kit files it as a ticket for triage**, once per title per run, its body naming the
  source ticket and phase. Each is recorded in the run record as it arrives, so a run that stops
  early still files them as it stops. The closing summary lists them under Needs you as "filed for
  triage", and its header counts one whose filing failed (or that a stop left unfiled) under `need
  you`, to file by hand; a dry run files none and counts what it would have filed under `to
  triage`. Implementers name no follow-up for their own branch's code.
- **A test keeps the kit's host shell scripts free of bash 4 constructs and GNU-only flags**, and
  parses them under bash 3.2 where one is installed, so a script that would break on a Mac's stock
  bash is caught on Linux.

### Changed

- **The git guard refuses `git stash` in the shared repository**, since its list is shared by every
  agent's worktree and a pop could apply another agent's change; `stash list` and `show` pass, and
  the prompts give the diff-and-apply way to run a test without a change.
- **Implementers file what they leave outside the ticket** with a `<followup>` line, instead of
  naming it only in a final message no reviewer reads; the prompts no longer ask for
  `gh issue create` or a "Follow-up:" entry. The Edit-tool rule is dropped: agents did not follow
  it, and the review and the gates catch a bad replace.
- **The sandbox image stops at once** (`STOPSIGNAL SIGKILL`): every sandbox close waited out
  `docker stop`'s 10 s. Every project's image rebuilds once.
- **The review, implement and repair prompts carry three more lessons**: a fix the reviewer commits
  needs a test; a test run with the change removed gets a time limit and a separate restore step;
  never `pgrep -f` or `pkill -f` a pattern from your own command line.
- **The docs say Linux needs rootful Docker Engine and a normal user in the `docker` group**;
  Podman is listed only on macOS, as untested.
- **pnpm 12.8.2, `@types/node` 24.19.1 and Codex 0.160.0 as the image's offline default.**
- **A cached image build prints one line** (`Image <tag> re-tagged from cache`) instead of docker's
  output; a real build or a failure still shows it all.
- **Implementers test at the ticket's seams and run the full gates once.** A bug is first
  reproduced by a failing test; expected values come from outside the code and mocks only from
  real boundaries; single test files run while working, and each gate runs once, in its own
  command, at the end.
- **The review checks that each test would fail if the behaviour broke** and survive a refactor
  that kept it, and tidies duplication or misleading names the branch introduced.
- **Agents no longer run the project's full suite right before the kit gates the same commit.** The
  conflict resolver runs the typecheck gate and the tests covering the conflicted files; a reviewer
  runs the full suite once, and only if its own commits changed code. With `changelog: true` the
  full review's prompt quotes the implementer's changelog lines, so the reviewer keeps the ones that
  hold and corrects the rest, and an implementer's record says which spec it followed when a comment
  amends the ticket's.
- **`sandcastle size` says the measured peak (`memory.peak`) includes page cache** and prints the
  sandboxes' anonymous memory as the lower bound. `peaks.jsonl` records it as `anonMib`, read as
  each gate or agent pass starts and every 10 s while it runs (never after it ends), and a ticket's
  sandbox also records `agentMib` (its peak before the first gate) and `agentAnonMib` (anonymous
  memory while its agents work). Lines from older versions are told apart and their anonymous
  figures ignored.
- **Within a run, a landing's gates (and the base and verify gates) take a freed machine-wide gates
  slot before that run's ticket gates**, so the one landing worker no longer queues behind them;
  across runs the longest wait still goes first.
- **With `USAGE_CHECK=1`, the check before each ticket uses the run's own agents' newest reading**
  when it is under 10 minutes old, and asks the usage endpoint only before the first reading or once
  the newest is older.
- **The README and skill say that committing on a run's branches during a pause stops it**, and
  the skill knows a usage pause resumes by itself.
- **The image's Codex is the newest plain release at least 72 hours old**, not npm's `latest` the
  moment it is published; pre-releases are skipped, and `CODEX_VERSION` still overrides it.

### Fixed

- **Quitting the status view in a run's own Herdr tab leaves the pane as your shell** until the run
  ends or Herdr restarts, instead of getting the view typed back into it every tab-bar tick and the
  closing report typed there at the end. After a Herdr restart the view comes back as before.
- **A run that opens no Herdr view no longer acts on an earlier run's stale view record** (outside
  Herdr, or with `SANDCASTLE_HERDR_VIEW=0`): the tab bar stops typing into that run's old pane ids,
  and the run's live-runs file goes at exit.
- **A finished run waiting for its Herdr report no longer makes every Herdr server start the kit on
  every tab-bar tick.** It waits outside the tab bar's check until Herdr restarts or another run is
  going, and is forgotten 7 days after the run ended.
- **A restarted status view and a dead tab's closing report run the kit the run was started from**,
  so a run from a second checkout no longer comes back with the plugin's checkout.
- **The sandbox git guard allows `git -C <path> update-ref`, `gc` and `prune` in a scratch
  repository** outside the project. The shared `.git` and its worktrees stay refused, even after the
  shell has `cd`'d elsewhere; `git push` stays refused everywhere, and its refusal says to test
  remote handling with a bare origin under the temp dir and `git fetch`.
- **The run estimate no longer prices a model with little history as if it were solid**: a model
  with fewer than five tickets in the window is blended with all tickets' figures, its own weighted by
  its share of five, and the line says so.
- **Two projects building the shared base image at once no longer crash on `docker tag`**: the base
  build, cleanup and tag run under a machine-wide lock, so the second waits and reuses the image, and
  a docker failure there is a one-line error naming the image.
- **The git guard's file-write and `rm`/`mv` rules also refuse the project's shared `.git`** after
  the shell has `cd`'d into a scratch repository or out of every repository.
- **Building a base image no longer deletes the images of other kit checkouts or projects**: a tag is
  pruned only when nothing has built or used it for 14 days and no live run uses it, so each checkout
  stopped rebuilding every run.
- **A project's layer build no longer fails when another project's base build prunes its base tag**:
  the layer build runs under the same machine-wide base-image lock.
- **The Herdr view record is written whole** (temp file and rename), so a Ctrl-C of the status view
  can no longer lose its quit mark to a half-written record.
- **The Herdr tab bar runs a view record's kit path only if it is an absolute path to a kit
  checkout**, and shell-quotes it.
- **A finished run's Herdr report is no longer lost when herdr fails while delivering it** (the
  server not yet restored at Herdr's start, say): it stays waiting and is tried again until its 7 days
  run out. The README's Herdr section says when the report is delivered.
- **A failing test's title is quoted and cut to 40 characters** in the requeue and red lines,
  instead of running into the sentence, and a run's `#N waits for ...` lines print under its header.
- **The git guard's scratch-repository allowance needs an absolute `git -C` path**: a relative one
  after a `cd` in the same line, or a `GIT_DIR` assignment, could reach the shared `.git`. A quoted
  path now works, and a variable assignment before `git` (`FOO=1 git push`) no longer hides a command
  from every rule.
- **A test that goes red on the base mid-run is no longer repaired on every branch it fails on.**
  When every failing test is in a file the branch did not change, the gates run once on the base
  tip; red there too, the run prints `base went red mid-run: <test>` once, starts no repair, and the
  closing summary lists the test once under Needs you.
- **A host `pnpm test` leaves no `sandcastle-*` temp directories behind**: each run keeps its temp
  files in one directory it removes on exit, also when interrupted, and fixtures started through
  `test/cli-spawn.ts` end with the test process instead of lingering with parent pid 1.
  `sandcastle doctor` no longer leaves a `sandcastle-mods-*` directory on every run.
- **A passing test file that prints outside `quietly` fails** (a preload, `test/no-stray.ts`), so a
  green gate log carries only reporter lines.
- **The base-red check works for node:test projects, the kit's own suite included**: it reads
  each failing test's file from node:test's `✖ failing tests:` summary, so a base red there no
  longer gets a repair pass on every branch.
- **A branch that breaks a test in a file where the base already has a different failing test
  gets its repair pass**: a failure named only by file (vitest's or jest's `FAIL <file>`) was taken
  for the base's own red. The check reads the base's whole list of failing tests, not the first
  five, and saves each base gate run under the commit it tested.
- **A ticket red on a test another ticket has just fixed and landed merges that fix and gates
  again**, rather than starting a repair whose changes conflict with the fix at landing. A fixer
  sent back at landing that lands on its second try still counts as that test's fix.
- **When the base goes red mid-run, the closing summary counts it under need you**, no longer calls
  the tickets that failed on it "held", and makes fixing the base (naming the test) the first next
  step.
- **Killing `pnpm test` or `test/run-shards.sh` ends the test shards and their processes too**,
  instead of leaving them running after their temp directory is deleted.
- **The image's Codex is never a release npm marks deprecated, one that was unpublished, or one
  newer than npm's `latest` tag.**
- **The run's start estimate includes each landing in a blocker chain, the base gates and
  verify**, and says how many past tickets it priced from. Time a ticket spends waiting for another
  ticket's fix no longer counts towards the status view's usual ticket time.
- **`sandcastle size` counts the sandboxes where branches are merged and gated**, often a run's
  largest; their peaks were never recorded. It prices gate sandboxes at a gate figure and the rest
  at an agent baseline, so it no longer recommends 1 sandbox for a VM that runs 4, limits gates by
  memory and never above the sandboxes, and names each figure and the runs behind it. A gate is no
  longer priced at about 0 GiB from memory read at rest (which also silenced the pool warning), and
  a VM smaller than one gate sandbox is said to fit none instead of getting a negative capacity.
- **The `base gates` line in `.sandcastle/logs/timings.jsonl` has per-gate times and the slot
  wait**, like verify's.
- **Sandboxes run `tini` as PID 1**, so a killed child process is reaped instead of lingering as a
  zombie that process checks still see as alive. Each project's image rebuilds once.
- **`sandcastle doctor` flags a missing `ps` on Linux** (procps, absent from slim images), which
  made the status view show every live run as ended; the install docs list procps.
- **The start line no longer says "Keep awake: on" when the inhibitor fails at once**
  (`systemd-inhibit` with no system bus, in WSL or a container); it says
  `off - systemd-inhibit failed`, and the same for caffeinate.
- **The base check a run makes mid-run counts in the machine-wide pool**, so other runs see every
  live sandbox. While it runs the status header can read one past the cap (`sandboxes 7/6`), and the
  gauge no longer draws a stray free cell then.
- **`sandcastle doctor` on Linux no longer reports `podman-docker` as a failed "Docker running"**;
  it names the Podman refusal and #359.
- **A ticket released when its last blocker lands, or requeued after a conflict or red at landing,
  starts at the next free slot**, ahead of every ticket not yet started, instead of last; this cuts
  the idle slots at the end of a large run. The release line says so (`#N released: its last
  blocker has landed; it starts at the next free slot`), and the same-file start line says what
  happens if the two conflict at landing.
- **A ticket whose branch already holds another ticket's landed fix repairs at once**, instead of
  merging the base and gating again first.
- **A suite run in a sandbox is no longer moved to the background after 2 minutes**, which ended
  the agent without its completion mark and cost a second implement session: the sandbox's managed
  settings set the Bash default and maximum timeout to 15 minutes.
- **The backup repository `.sandcastle/backup.git` no longer grows for good**: at a run's start and
  in `sandcastle clean`, the copy of a branch whose commits are all on the base is dropped, and the
  repository pruned once none is left. A deleted branch with unmerged commits keeps its copy until
  `sandcastle clean --all`.
- **A hung container runtime no longer stalls a run's start for minutes in silence**: the start
  reads `docker info` once, with a 10 s limit shared by the runtime check, the CPU limit and the pool
  warning, and a detached run's child reuses its parent's reading. On Linux no answer stops the run
  (`docker did not answer within 10 s - is the runtime running?`); elsewhere, where a cold start can
  be slow, the run goes on with no CPU limit.
- **A run stopped by the guard says it lands nothing more**, and the closing summary of a stopped
  run reports the tickets as the tracker said during the run.
- **The per-ticket line says `repair made no change`** for a repair pass that committed nothing,
  instead of `repaired=1`.
- **`sandcastle doctor` names the defaults it uses when there is no personal `config.json`.**
- **A status pane moved out of the previous run's Herdr tab is closed** when the next run replaces
  the view.
- **A pause lets the machine sleep across a multi-turn run's turns**: keep-awake is one inhibitor
  for the whole run.
- **A flaky frame comparison in `test/status.test.sh` under load is fixed**, as are timing-bound
  tests that failed on a loaded machine.

## [0.7.0] - 2026-10-04

### Upgrading

- **Run `/sandcastle update` in each project, then start a new agent session.** Its new step checks
  whether an `ANTHROPIC_API_KEY` reaches the project's sandboxes, and a session keeps the skill it
  loaded at its start.
- **Autonomy levels 2, 3 and `drain` now re-run a ticket that merged partly done and is still
  queued**, unless its agent's note says the rest is a person's decision. Move it to the hold label,
  or close it, if you do not want a turn spent on its remainder; a drain stops after the same ticket
  is left partly done in two turns running.
- **The usage guard reads your Claude Code login only when the sandboxes spend a subscription token.**
  With `ANTHROPIC_API_KEY` it now says it does not apply, where 0.6.0 read the host login's plan,
  which has nothing to do with an API key's spend. The run's start line and `doctor --verify` say
  whose plan is read.
- **A run that would spend `ANTHROPIC_API_KEY` now asks first, and a run with no terminal refuses
  without `--api-key`.** If `sandcastle doctor` prints `warn API credits`, `sandcastle run`, `preflight`
  and `lean --measure` ask before they start, and `--detach` or a script needs `--api-key` (or
  `SANDCASTLE_API_KEY=1`). To spend your subscription instead, remove the key from the file doctor
  names (`/sandcastle update` checks this).
- **With `changelog: true`, agents can now give an `Upgrading:` line.** If your project rules tell
  agents to start each line with `Added:`, `Changed:` or `Fixed:`, add `Upgrading:` there, for what
  an existing project must act on (`/sandcastle update` checks this).

### Added

- **The status view's click hint names the key that works in your terminal.** The terminal is
  sensed once, from the attached Herdr client, when the view starts: `cmd-click` in iTerm2 (where
  Ctrl-click is macOS's right-click), `ctrl-click` in Terminal.app and Ghostty, and both elsewhere.
  `"herdr": {"clickHint": "auto" | "ctrl" | "cmd"}` in the personal config.json, or
  `SANDCASTLE_CLICK_HINT`, overrides it; `sandcastle doctor` and `sandcastle herdr configure` say
  which terminal was sensed and which hint the view shows.
- **Agents can suggest an Upgrading note.** With `changelog: true`, a line starting `Upgrading:` says
  what an existing project must act on; the closing summary lists such lines in a block of their own,
  apart from the changes, where an instruction used to be folded into a `Changed:` line or left in an
  agent's prose.
- **Spending an API key is never silent.** Whenever `ANTHROPIC_API_KEY` would reach the sandboxes
  (from either `.env`, even beside an OAuth token), `sandcastle doctor` warns in red, and the run's
  start line, the status view's settings row and the closing summary say it bills API credits;
  `sandcastle run`, `preflight` and `lean --measure` ask first (see Upgrading).
- **Landing gates are timed and estimated.** Each landing gate writes a `landing gates` line to
  `timings.jsonl`; the estimate counts them in the gates-pool sum and takes the landings in a row,
  one after another on the one worker, as a floor on the run's end ("landing gates, one after
  another, set the time"). The status view's `ends ~HH:MM` follows. They took about half of a
  recent 44-minute run, and nothing modelled them.

### Changed

- **The sandbox image has `less`**, which the Herdr log popup pages with, so an agent can check
  the popup's prompt. Every project's image rebuilds once.
- **Ctrl-clicking a ticket in Herdr's status view opens its card**, not its latest raw log: its state
  and how long it has been in it, each pass with its outcome and time, and why it is held, in
  conflict or red. A digit opens that pass's log, whose bottom line says which key closes it (Ctrl-C
  while it follows new lines, `q` or Ctrl-C otherwise, `F` to follow); `t` prints the tracker link,
  and `q`, Esc or Ctrl-C closes the card.
- **A full review sees the ticket's comments and the implementer's `<unmet>` line**, and is asked to
  finish that criterion or restate it, so scope added in a comment is no longer closed as done.
- **The run estimate prices the tickets as their summed figures over the slots**, never shorter than
  the slowest single ticket, where one ticket more than the slots doubled it.
- **The mod's castle loops, in time.** While a ticket is in work it builds one level per 500 ms
  beat, stands complete for seven beats and builds again: a 6-second loop of twelve beats, where a
  16-second hold read as the run standing still.
- **Sandbox agents can no longer use Monitor, ScheduleWakeup, CronCreate, CronDelete, CronList or
  RemoteTrigger.** The sandbox's managed settings deny them, so a pass cannot sit waiting on a
  backgrounded suite, spending tokens and the machine's shared gate slots.
- **`test/full-check.sh` runs the suite in CI's weighted shards** and starts the macOS,
  agent-committer, Linux and scan legs together instead of one after another. The passes running at
  once share the cores, about two per shard; `FULL_CHECK_SHARDS` sets the shards per pass.
- **The git guard's refusal says how to carry quoted text.** Text that only quotes a refused command
  (a heredoc, a commit message, a comment body) can be written to a file and passed with
  `--body-file`, `-F <file>` or `git commit -F <file>`; what the guard refuses is unchanged.
- **A partly-done ticket whose agent says the rest is a person's decision** gets a suggestion to move
  it to the hold label, in the closing summary and the ticket comment, instead of a promise that the
  next run picks it up.
- **The review prompt says a problem named only in prose is lost**: each one is fixed, filed as a
  ticket, or left as an `<unmet>` line.

### Fixed

- **`sandcastle doctor` no longer waits on a slow Docker** for its build-cache line: `docker system
  df` sizes every container's files and took over a minute beside a busy container; the line now
  gets five seconds and is left out after that.
- **The Herdr report popup says `q` closes it**, on its bottom line and in its title.
- **The status view no longer says "closes on push"** for a hand merge already on the remote's base
  branch.
- **A ticket handed back or held for a human prints a line to the run's output** when it happens,
  instead of dropping silently out of the `working:` line until the closing summary.
- **A run killed while Herdr was up gets its closing report in its own tab** even when Herdr restarts
  some time after the kill, not only when the kill and the restart happen together.
- **With two Herdr servers on one machine, only the one holding a dead run's tab acts on it**: the
  other no longer types the report into a pane of the same id, or removes the run's file first.
- **After a Herdr restart, a live run's tab gets its status view back** on the next tab-bar tick, and
  a run that ends after a restart (or is stopped by a closing Herdr's hangup) shows its closing
  report in its tab instead of finishing silently.
- **A status view opened before `sandcastle herdr configure` linked the plugin** shows ticket links
  and the click hint within one redraw, and drops them when the plugin is unlinked.
- **The usage guard finds the Claude Code login when `CLAUDE_CONFIG_DIR` is set.** Claude Code keeps
  that login in the keychain as `Claude Code-credentials-<h>` (the first 8 hex characters of the
  SHA-256 of the directory's path); the guard looked only for the default name, fell back to a setup
  token the usage endpoint refuses, and was off for the run. `doctor --verify` names where it looks.
- **A landing no longer fails with `spawnSync git ENOBUFS`** when the base moved by, or the branch
  changed, more than about 1 MiB of paths (a vendored directory, a mass rename, a generated tree).
- **A review's commit count is its own**: a reviewer whose only commit merged the base in read as
  `commits=1 (review=14)`, counting the base commits the merge brought in.
- **Agents never run the gates to time them.** A ticket that asks for a wall time or a
  before-and-after figure gets an `<unmet>` line for a person: one implementer timed the full check
  four times under load and waited on it for half an hour, slowing every other sandbox's gates.
- **A run ended by `sandcastle stop` or Ctrl-C reads as stopped by a person**: the closing summary
  says "Run stopped by `sandcastle stop`" for a detached run and "stopped by Ctrl-C or `sandcastle
  stop`" in a terminal, where the two cannot be told apart, and the notify line "run stopped by
  ...", not "ended early (exit 1)". Runnable now no longer says "none" above a ticket the run cut
  short.
- **A partly-done ticket is listed under Runnable now while it is still queued**, and a further turn
  takes it (level 1 asks first), so the summary's "the next run picks up the remainder" is what the
  next run does. The status view names the difference from the summary's needs-you count.
- **A dead run's report is typed into its Herdr pane only when the pane is a bare shell**, never into
  an editor, `claude` or a REPL started there since, and only once when two readers see the dead run
  together.
- **A reviewer's rewording of a changelog line replaces the implementer's** instead of showing as a
  second change: a full review restates the branch's whole set of lines, and the summary keeps that
  set. A narrow pass - the review after a repair, a base merge or a conflict resolution - sees only
  its own diff, so it adds lines for what it changed instead of replacing the set.
- **The beyond-Touches note leaves out files only a repair or a conflict resolution changed**, and is
  not printed when the overrun is only test and docs files (the paths stay in the run record).
- **A red requeue line also names an earlier landing that changed a file the failing test imports or
  names**, not only one that changed a file the branch changed. Only the lines that say a test
  failed count (FAIL lines, failing-test lines, pytest's F and E, stack frames, coloured output and
  tsc's error lines included), so a ticket whose module has only passing tests is not blamed.
- **With both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` set, the kit named the OAuth token**
  while Claude Code spent the API key; it now names the API key.
- **A held ticket merged by hand whose branch `sandcastle clean` deleted counts as merged by hand**
  instead of asking for a review and merge of a branch that is gone, and reads "merged by hand, and
  closed" once the ticket is closed. A held branch that is gone with no merge on the base is listed
  with no merge command.
- **After a run, the status view shows a ticket merged partly done as partly done** (with "needs a
  person's decision" where the agent's note says so) instead of "queued for the next run".

## [0.6.0] - 2026-10-04

### Upgrading

- **Run `/sandcastle update` in each project, then start a new agent session.** The skill is now a
  router with one file per action, and a session keeps the skill it loaded at its start.
- **Run `sandcastle size` once per machine** while the pool's limits are the defaults: it
  recommends `maxSandboxes` and `maxGates` from the container runtime's VM and, after a run, from
  the memory sandboxes really used. It writes nothing.
- **Inside Herdr, run `sandcastle herdr configure` again if the plugin was linked before this
  release.** The status view's ticket links and its Ctrl-click hint now appear only where the
  plugin is linked, and that run leaves the record the view reads. `/sandcastle update` checks it.
- **`USAGE_CHECK=1` now works on a machine logged in to Claude Code**, even when the sandboxes use a
  `claude setup-token` token, which the usage endpoint refuses: the guard reads plan usage with the
  host's login instead, read-only. `sandcastle doctor --verify` says which credential it would use.
  A project that left the guard off because it had no reading can turn it on.
- **A project that mounts the pnpm store by hand** can switch to `pnpmStore: true`;
  `/sandcastle update` proposes it.
- **A run started by an older kit ignores shares until it ends.** Live runs now split the machine's
  sandbox slots between them, but a run already going when the kit is pulled knows nothing of it
  and keeps taking free slots (it is counted as wanting its concurrency). Let it finish, or stop it
  and start it again, before relying on the split.
- **The personal `config.json` now refuses an unknown key.** A typo such as `"keepawake"` was
  ignored, so the setting never applied; now every command that reads the file stops with the
  nearest real key (`maxSandboxes`, `maxGates`, `keepAwake`, `notify`, `idleMark`). Run
  `sandcastle doctor` once per machine: it names the key.
- **A ticket with an acceptance criterion an agent left undone now merges as "partly done" and
  stays open.** Its merge says `part of` the ticket instead of `closes` it, and the next run takes
  up the remainder; a project's own scripts that read merge subjects for `closes #N` should accept
  `part of #N` too.
- **`changelog: true` is a new project config key**, off by default. A project whose rules keep
  agents out of its changelog can turn it on to have the closing summary gather their suggested
  lines.
- **The log archive is now pruned**: archived files go after 14 days and raw `.jsonl` streams after
  2. Copy anything under `.sandcastle/logs/archive/` you want to keep for longer before the next
  run.
- **Landing now deletes a merge-landed `agent/issue-*` branch**, as it always did a squash-landed
  one, so merged agent branches no longer wait for `sandcastle clean`. Nothing to do; a project that
  relied on finding them should read the merge commit instead.
- **`sandcastle clean` removes only dangling images built by this kit or later** (they carry a
  `sandcastle-kit=1` label). Images left by an older kit are not touched: run `sandcastle build`,
  then `docker image prune` by hand once if `sandcastle doctor` shows a large build cache.

### Added

- **The machine pool shares itself fairly between projects.** A freed sandbox or gates slot goes to
  the run that has waited longest, across projects: a run that just freed one no longer takes it
  straight back while another project's run waits for the first to drain. Live runs also split the
  sandbox slots by **share**: equal parts between the runs that want slots, each never more than
  its **demand** (its tickets in a sandbox or ready to start, plus one for a waiting landing), a run
  that needs less releasing the rest to the others. Nothing is taken back: a run over its share
  keeps what it holds and shrinks as tickets finish. The status header's `this run` row shows
  `wants 4 · share 3`, and a ticket held back says `waits for the run's share`. Gate slots have no
  shares.
- **A run that starts beside another says how the machine is split.** Its start line names each
  other live run's project, slots and demand, this run's share and, when no slot is free, a rough
  wait for its first (`webshop is live (6 slots, demand 5): this run's share is 3; ...`); a run from
  an older kit is named as one that ignores shares. The estimate divides by the share while another
  run is live, and the skill quotes the line before confirming the start.
- **`sandcastle cap`** limits a live run's share while it runs: `cap N` caps this project's run at
  N sandbox slots, `cap off` lifts it, a bare `cap` prints demand, share and cap, and
  `--project <name>` acts on another project's run from anywhere. The cap only lowers the share,
  frees its slots to the other runs and ends with the run. The status view shows it
  (`wants 4 · share 3 · cap 3`), and the Herdr tab bar shows each live run's share.
- **The status view has a settings row** under the run band: the autonomy level lit among the
  others and the turn out of the level's cap (`autonomy 0 1 2 [3] drain · turn 2/3`), repair
  attempts (`repair 1`), concurrency after the machine cap (`concurrency 6 (asked 8)` when it
  clamped), cross-review with its model and effort, and the usage guard with its threshold
  (`● usage-guard 90%`, or a warning `(no reading - not guarding)` when it has no reading). Settings
  that are off are greyed and drop below 80 columns. Between runs it shows what the next run would
  use, prefixed `next run:`. Each turn's run record carries the settings, so `sandcastle run` and
  `sandcastle status` resolve them the same way; a record from an older kit draws no row.
- **The closing summary names the run's settings, and the switch that would have helped.** A
  Settings line sits under the headline; a level-0 run that left tickets it could run again
  suggests `AUTONOMY_LEVEL=2` (or `drain`), and a usage guard that had no reading says the run was
  not guarded. Nothing else is suggested, and the skill relays the hint as written.
- **An idle mark between runs in the Claude Code mod.** In a project `sandcastle init` has set up,
  the mod draws `sandcastle` in sand, one row above the prompt led by a castle tower (`♜`), and when
  tickets are ready (queued, no open blocker) it reads `sandcastle · 4 ready - /sandcastle run`. The
  count comes from `sandcastle queue --json`, read in the background and cached per project for
  every session on the machine: at most one tracker read per project every 10 minutes, plus one when
  a run ends and when you use `/sandcastle`. A failed read keeps the last count for an hour and
  never shows an error. The live band replaces the mark during a run.
- **`/sandcastle-mark`** controls the idle mark with no model turn: `dismiss` takes the count off
  until a new ticket becomes ready, `hide` turns the mark off in this project until `show`, and a
  bare `/sandcastle-mark` says which applies and how old the count is. `"idleMark": false` in the
  personal `config.json` turns it off everywhere; doctor reports a value that is not a boolean. The command's
  typeahead shows its choices: `/sandcastle-mark [dismiss|hide|show]`.
- **An acceptance criterion left undone is reported, not merged over.** Every criterion, and any
  regression the branch causes, is now in the agents' scope. An agent that still leaves one undone
  says so in an `<unmet>` line; the branch lands if green, but the ticket stays open with a comment
  naming the criterion, its merge says `part of` rather than `closes`, and the closing summary lists
  it under Needs you as `merged, partly done`. A ticket used to merge as plain "merged" with nothing
  telling you. A branch that lands in a later run keeps its criterion.
- **`changelog: true` gathers the agents' changelog lines into the closing summary.** For a project
  whose rules keep agents out of its changelog, the implement and review prompts ask for each line
  in a `<changelog>` tag (`Added:`, `Changed:` or `Fixed:`), and the summary lists the merged
  tickets' lines under Done, grouped, instead of leaving them scattered across the agents' logs.
- **The readable agent log shows failed tool calls.** Each tool result that errored or exited
  non-zero adds one `! error: ...` or `! exit N: ...` line; the library left them out, so a log read
  to find why a ticket went wrong showed only the agent's next line. These lines never count as a
  usage limit.
- **`sandcastle clean` removes exited sandbox containers and the kit's dangling images**, which
  were never cleaned up and could hold several GB each. The kit's images now carry a
  `sandcastle-kit=1` label so another project's images are left alone, and `sandcastle doctor`
  shows the Docker build cache's size with a prune hint.
- **`sandcastle init` writes `pnpmStore: true`** and the kit runs `pnpm store path` on the host at
  run time, so the committed config holds no host path. A literal macOS store path in the config
  was a mount that did not exist for a teammate on Linux.
- **`queue --lint` flags blockers listed under a heading.** A `## Blocked by` heading over `- #12`
  items is not read, so such a ticket started before its blocker landed with nothing saying so;
  the lint now names it under problems.
- **The review agent checks the docs for old behaviour.** A change to what the project does now has
  the reviewer grep the README, docs, agent instructions and skill files for wording that described
  the old behaviour, and fix what is now false. The audit's docs lens checks the same.
- **`sandcastle size`** recommends the machine pool's `maxSandboxes` and `maxGates` from the
  container runtime's VM, names the figure that set each, shows the current limits and advises on
  the runtime's own CPU and memory settings. It writes nothing. Once a run has been measured, it
  sizes sandboxes from the peak memory they really used (read inside each sandbox), not an assumed
  1.5 GiB. `sandcastle setup` and `doctor` point to it while the pool's limits are untouched defaults.
- **Protected paths are flagged before a run.** `sandcastle queue --lint` and `sandcastle requeue`
  warn when a ticket's `Touches:` line names a protected path (or its kept branch changed one): it
  will always be held for a human merge. Nothing is refused.
- **A runaway agent pass is flagged.** The status view marks a pass that has run three times its
  usual time in this project with `3x over, usually Nm` in red; AGE still turns red at twice.

- **A dead run's Herdr tab shows its closing report after a restart.** When Herdr comes back after
  a run was killed outright (the machine went down, or a `kill -9`), the plugin's next tab-bar tick
  puts `sandcastle report` in that run's status pane, once. A tab adopted from your own terminal is
  left alone. A run that ended or stopped on a signal leaves no trace to tick on, so it is not
  covered yet.
- **The run estimate counts the gates pool.** When the tickets' gate runs, shared over `maxGates`
  slots, take longer than the sandboxes do, they set the estimated time and the line says so; a
  large run was priced as if its gates never waited.
- **`sandcastle doctor --verify` names the usage guard's credential** and the HTTP status the usage
  endpoint answers it with, never the token.

### Changed

- **The run estimate prices each ticket from its implement model's history**, so a run of
  Opus-labelled tickets is no longer estimated at the Sonnet pace of the last runs (one was 10x out
  on tokens). A model with no history here falls back to the overall median and the line says the
  estimate is low; a chain now reads `N tickets in sequence`, not `a chain of N runs`.
- **Issues opened during a run read "opened during this run"** in the closing summary, not "filed by
  an agent", since agents use your own `gh` token; a finished run's window ends at its finish, so a
  later issue is no longer listed every time `sandcastle report` is read, and the header counts them
  as `N to triage`.
- **A re-run's conflict resolution is its own phase, `resolve`**, with a `resolve-<n>` sandbox and
  log and its own `timings.jsonl` line, in the status view, Herdr panes and report. It ran as
  "implement", appending to the implementer's log and pulling the usual implement time down.
- **The requeue line says the ticket is tried again in this run**, not that "its pipeline runs
  again": the second attempt is often land-only, which the next line says.
- **The agent log's closing line reads `Tokens processed (all turns): Nk`**; it said "Context
  window", but it is every turn's input and cache tokens added up.
- **The implement prompt tells the agent to run gates in the foreground to a file and to prefer
  the Edit tool**, after agents polled a background test run with `sleep` and edited with scripted
  replacements that silently did nothing on a missed match.
- **The skill's ticket-writing guidance**: a `Touches:` line names only files an agent may edit
  under the project's rules (a forbidden `CHANGELOG.md` there gave false overlap lines), existing
  paths as they are with new files marked new in the prose, and evidence goes in the final message
  or a ticket comment, since a run opens no pull request.
- **`sandcastle requeue` reminds you to give GitHub a few seconds** before `sandcastle run`, when it
  changed a label: GitHub's label search can miss a ticket labelled moments earlier, and the run
  then leaves it out silently. The README and the skill say the same.
- **Doctor reports another kit checkout on PATH as a note, not a FIX.** Run from a clone or worktree
  of the kit, it advised relinking PATH to that checkout, which would hijack the installed kit; it
  now says `./bin/sandcastle` runs this one.
- **A short status pane shows the wordmark alone**, not a castle cut to a one-row slab that read as
  a broken logo.
- **The README says more about what a run proves and holds.** A run's gates prove Linux only (a
  branch green there can be red on macOS or Windows; it suggests a CI job or a host-side check), a
  held conflict resolution is explained with what to look at and how to go on, and the install
  guide no longer says an open session picks up a pulled skill.
- **The usage guard reads plan usage with the host's Claude Code login**, read-only and never
  refreshed (the macOS keychain, or `.credentials.json` in the Claude config directory), and falls
  back to `CLAUDE_CODE_OAUTH_TOKEN`. The usage endpoint answers a `claude setup-token` token with
  HTTP 403, so the guard had nothing to read with one.
- **Ticket links and a new `ctrl-click a ticket for its log` hint appear in the status view inside
  Herdr only once the plugin is linked** (`sandcastle herdr configure`): without it a click did
  nothing. `SANDCASTLE_LINKS` still overrides.
- **The Touches overrun note folds tests and docs into counts.** Edited test files read "+N test
  files" and docs paths (`*.md`, `docs/`, `skill/`) "+N docs files", other paths in full, so a
  source-file overrun is no longer buried under the tests and docs every change must edit; it used
  to flag almost every ticket. The run record keeps every path, and the closing report separates a
  ticket's title from the note ("<title> - beyond Touches: ...").
- **A red requeue line names the failing gate and tests**, and names a landed ticket only when it
  changed a file the branch also changed; otherwise it says "red on the merged tree".
- **The run estimate is a range**, from the median to the 80th percentile. It prices carried
  branches (ahead of the base, often conflicting) from earlier carried tickets, apart from fresh
  ones, and counts a `Blocked by` chain's own times, so a run of carried branches is no longer
  priced at about half its real cost.
- **Agent tags are read only on lines of their own.** `<changelog>`, `<ungated>` and `<unmet>` named
  in an agent's prose (or inside a code block) no longer count as the tag.
- **The website shows more and says less.** The status window sits beside the headline; the night's
  log is a sky you can wind back and forth, the moon crossing it as a castle is built from the
  run's tickets; how it works, safety, long runs and the skill are each a picture, with the detail
  folded away beneath it. It also shows one of the kit's own runs from its record (18 tickets, their
  minutes and tokens, each a public issue), compares the kit with wiring Claude Code up by hand, and
  answers four more questions: your own work in the repository, a green branch that is wrong, merge
  conflicts, and a ticket that tries to steer an agent.
- **Herdr's sidebar row and tab bar lead with the mod's castle tower (`♜`), in plain text**, not the
  🏰 emoji: the same mark the Claude Code mod draws, in the terminal's own font and colour.
- **The `/sandcastle` skill loads only what the action needs.** `SKILL.md` is now a short router
  and each action's steps live in a file of their own (`init.md`, `queue.md`, `run.md`,
  `status.md` beside `audit.md` and `update.md`), so a `status` check no longer loads the
  init, queue and run instructions. The ticket-body rules (blocker line, `Touches:`, evidence)
  are written once, in `queue.md`, and the audit follows them; long steps such as the run's
  pre-start check are broken into checklists. An open session keeps the skill it loaded, so
  start a new one after updating.
- **The README opens with the kit's logo** - the pixel castle and wordmark, and the castle as a
  terminal draws it - in place of the plain heading.
- **Each outcome in `.sandcastle/logs/outcomes.json` carries a kind** (merged, conflict, red, held
  and so on) beside its line, and the status view, the closing summary and the autonomy loop read
  the kind rather than matching the wording. What a run says about each ticket is now worded in
  one place, so the run record, the status view, the summary and the tracker comment cannot
  disagree. Nothing to do: an older run's entries are shown with their line as before.

### Fixed

- **A project's `setup` steps run in order.** Sandcastle starts every sandbox hook at once, so with
  `pnpmStore` the store-dir step raced the install, which then filled a store of its own, and any
  setup whose steps depend on each other could fail now and then. The steps now share one hook.
- **Agents run the gates in the foreground with the longest timeout.** Claude Code's 2-minute default
  moved the suite to the background in a fifth of the passes, and an agent then waited minutes on a
  poll that never ended; the review, repair and resolve prompts had no rule at all.
- **The run prints each landing's result** (`#270: merged.`): a run that spent its last half hour
  landing printed nothing between the last agent pass and the closing summary.
- **A landing's gates wait as `<project> #N landing gate`**, not under the branch gates' label, which
  read as if a green ticket had gone back to gating.
- **The status view counts a landed ticket's own commits**, without the base merged into its branch,
  as the report does, and marks a ticket landed with a criterion left undone `partly done, ticket
  open` instead of a plain `landed on main`.
- **The shared-file lines print under the run's ticket list**, not before its header.
- **A carried green branch's line no longer says it gets no review**: one that conflicts at its base
  merge still gets the resolver and the narrow review of the resolution.
- **`sandcastle doctor --verify` asks the usage endpoint once per token**; it asked twice for the
  same one, and the endpoint is rate-limited.
- **A red landing reads its base from the merge it made before the gates ran**, so a gate that moves
  `HEAD` cannot change whether a requeue skips its gate run.
- **A killed run's recycled process id no longer holds the run lock or a machine slot.** The next
  `sandcastle run` of the project refused with "Another sandcastle run of this project is live" for
  as long as the unrelated process lasted; the run lock and slot locks now check the process is the
  kit's, and keep a lock when `ps` cannot answer.
- **A requeued ticket that lands on its second attempt counts its first review's commits**;
  `commits=3 (review=0)` contradicted the reviewer's commit still on the branch.
- **The log archive is pruned.** `.sandcastle/logs/archive/` only grew (about 17 MB a day); archived
  files now go after 14 days and raw `.jsonl` streams after 2, the readable `.log` staying.
- **Merged agent branches are deleted at landing in merge mode too**, not left for
  `sandcastle clean`, by a run and by `sandcastle land`; they piled up in `git branch` and the
  status view. A branch a kept worktree holds is told and left.
- **The kit's own tests are faster and cannot hang.** The `--help` checks run in process (they took
  a third of the test gate), every test that starts the kit does it through one helper with the
  launcher's Node flags and a time limit (one stuck exit hung `pnpm test` for good), and passing
  tests no longer print stray lines into green gate logs.
- **The tip backup no longer grows with every run.** Each fetch into `.sandcastle/backup.git` sent
  the whole history as a new pack (about 50 MB after 30 runs, with no refs left); it now keeps the
  base branch for thin fetches, prunes itself once no agent branch is left, and runs its git calls
  with auto maintenance off, so the prune cannot fail on git's own background lock and ends with
  one pack. Nothing to do.
- **`pnpmStore` mounts the host's store-dir**, not its versioned `vN` directory, so sandboxes install
  from the host's own store instead of building a second one nested inside it. `/sandcastle update`
  checks a project that mounts the store by hand.
- **Doctor checks the kit's own checkout as a project** when it has a `.sandcastle/config.ts`,
  instead of skipping every project check as "not inside a project".
- **The idle mark's count follows triage.** It is read again when the turn that used `/sandcastle`
  ends, not only when the skill starts, so tickets labelled during triage show within about 15 s.
- **A held branch merged by hand reads "merged by hand; closes on push"** in `sandcastle report`
  (under Done) and `sandcastle status`, and `sandcastle queue` words its dependants as waiting for a
  blocker merged locally. It used to read as a branch the agent handed back with no commits.
- **A held conflict resolution reports what it is.** Its outcome, history and run record carry the
  real commit count and gate results, not `commits=0` and blank gates, and Needs you gives the real
  reason (the resolution edited files git had merged cleanly), not "changes <files>".
- **A carried branch is not redone in full.** A branch that is only a base merge or a held
  resolution past its last green head lands without being re-implemented and re-reviewed; a merge
  carried from an earlier run gets the narrow review first.
- **The pool tests take about 2 s**, not 10-100 s, and no longer slow the test gate or flake under load.
- **Gate time no longer counts the wait for a gates slot.** The wait is recorded apart as `waitMs`
  in `timings.jsonl`, so usual times, the "twice the usual" age and the estimate stop counting it.
- **The idle mark steps aside for a run this session follows in another directory.** It hid only
  for a run of the session's own project, so a run started from a second clone drew its castle and
  counts under a `sandcastle · 13 ready` that no longer meant anything. Any live run the band draws
  now hides it; when that run ends the mark returns and its count is read again at once.
- **A branch red at landing no longer shows as ready after the run.** The status view read the
  outcome "red when merged" (and "red again ... after a requeue") as nothing it knew, and drew the
  row as ready to land; it now shows gate red, like a red pipeline.
- **A red or no-change ticket is no longer recorded as "lands on a later run".** When the `.git`
  check failed just as a pipeline ended, the check's error replaced the pipeline's result, and the
  ticket was recorded as a finished green waiting to land. It now keeps its own ending.
- **The summary of a run that stops during landing says "red together" and gives no merge commands
  for a ticket a person took back.** Landing outcomes are recorded as each ticket lands, not only
  when the run ends.
- **A run killed with its process id reused no longer reads as live.** The status view, the Herdr
  tab bar, the closing summary and `sandcastle wait` checked only that the pid existed, so a
  recycled pid kept a dead run "live" (and `sandcastle wait` waited on an unrelated process). Every
  view now also checks that the process is the kit's.
- **`sandcastle clean` unlocks each sandbox worktree only as it removes it**, and only those under
  `.sandcastle/worktrees/`, instead of unlocking every live sandbox's worktree before it starts.
- **Suggested changelog lines are not repeated or cut off.** The closing summary showed a change
  several agents each described once per agent, and could show an agent's whole final message as
  one line; a line that is too long, spans list items or holds a commit sha is now left out with a
  note.
- **Every sandbox has a git identity before any gate runs**, so a test that makes a commit gives
  the same result at landing, in the base gates and in a requeue's gates as on its branch, instead
  of failing with "Author identity unknown" where no agent had worked first.
- **A requeue on a base that has not moved goes straight to the repair**, fed the landing gate's
  failing output, instead of running the same red gates again.
- **A ticket repaired in both attempts around a requeue reports `repaired=2`**; the requeue reset
  the count.
- **The git guard no longer refuses a `git branch` command because a later command on the line has
  `--no-ff`.** Deleting or force-moving an agent branch is still refused.
- **The gates wait line names the project** (`<project> #N gates`), as the landing one does.
- **The archive line gives the raw-stream limit its unit**, and an empty `XDG_CACHE_HOME` is read
  as unset, so the machine pool's slots directory is never relative to the current directory.
- **`landing.test.ts` no longer waits on a live run's slots**: it uses a cache directory of its
  own, so it cannot hang, or show up as another run, while a run holds the machine.

## [0.5.0] - 2026-10-02

### Upgrading

- **Run `/sandcastle update` once in each project, then start a new agent session.** It pulls the
  kit, rebuilds the project's image, rewrites the update record in its new form (the release and
  the notes acted on, readable without git) and checks that `.sandcastle/.gitignore` holds `.env`,
  `logs/`, `worktrees/`, `.run/` and `triage/`. The skill is a link into the kit, but a session
  keeps the skill it loaded at its start, so only a new session reads the corrected instructions.
- **The Claude Code mod needs Claude Code 2.1.287 or newer** (`claude --version`). It is linked, not
  copied, so the pull updates it and an open session reloads it; its band is now three rows tall.
  Without the mod, nothing changes. `sandcastle doctor` lists it with its one-line link if it is
  not set up.
- **Node 22 or newer.** `package.json` now says so, and `pnpm install` warns on an older Node.
- **`autonomy: "drain"` is for tickets that conflict across turns, not for `Blocked by` chains.** A
  chain whose links are all queued drains in one run at any level. A project that set `drain` only
  for its chains can drop it; nothing breaks if it stays.

### Added

- **`sandcastle --version`.** Prints the kit version: the release, and in a clone that is past it
  or has local changes, how far and at which commit (`0.4.2 +1 (1c4f46f)`). Doctor's first line
  now names it too, so a report of a problem says which kit it came from.
- **`sandcastle queue` shows a ticket's own implementer.** A ticket whose `model:` or `effort:`
  label sets its implementer reads `[implement <model>/<effort>]` after its title. The README and
  the skill state the order: the ticket's label, then `IMPL_MODEL` / `IMPL_EFFORT`, then the
  config, then the kit's default. To override a label for one run, remove the label.
- **Doctor says when the project is another checkout of the kit** than the one running. It names
  both paths, and says that `./bin/sandcastle` runs this one.
- **A drain names the tickets queued after it started.** Its closing lines list each one, for
  the next `sandcastle run` to take.

### Changed

- **The mod's castle stands taller and builds while a run works.** The band above the prompt draws
  the status view's whole three-row castle, so the battlements stand a row above the run's text.
  While a ticket is in work the castle builds from level sand and holds complete for most of each
  18-second cycle; with nothing in work it stands still. The frames run on a timer of their own,
  apart from the 3-second read of the run record. The band is now three rows tall.
- **The update record keeps the Upgrading notes, not a kit commit.** `sandcastle updated` now
  records the release and every note acted on, so doctor and a run can tell what is new in a
  shallow clone, a kit outside git or another clone of the kit - where a commit could not be read
  and the project was told it had no record, or heard nothing. An older record keeps working while
  git can read its commit, and the next `sandcastle updated` rewrites it.
- **`package.json` names Node 22 or newer** (`engines`), so `pnpm install` warns on an older Node
  before doctor does.
- **The status view draws light rules at every seam.** The rules above the headings and above the
  legend are no longer double lines, and a column bar that lands within 4 columns of a bar in the
  band above snaps onto it, so the two meet in one joint. The website's demo matches.
- **The Herdr plugin's Ctrl-click log popup follows the log live** once the log is longer than
  the popup, and Ctrl-C closes it. A shorter log opens at its top, as before.
- **The run estimate counts the in-run `Blocked by` chain.** When the chain is longer than the
  tickets over the slots, it sets the time, and the line says `(a chain of N runs in order)`.
- **`USAGE_CHECK=1` with a token that cannot read plan usage (HTTP 403)** says at the start that
  the guard is off for this run, and does not ask again. `sandcastle doctor --verify` warns about
  it beforehand. A failed reading for any other reason is no longer cached for ten minutes: the
  next ticket asks again, as the start line says.

### Fixed

- **`queue --lint` no longer counts blocker depth as turns.** Its estimate says one run, with the
  chain's tickets one after another in it, since dependants start as their blockers land.
- **A change to `AGENTS.md` or `CLAUDE.md` beside an added file is not a Touches overrun.** A
  ticket that adds a module adds its row to the layout table, so the report and the close comment
  no longer name it; on a branch that adds nothing it still counts.
- **`sandcastle <command> --help` (or `-h`) prints that command's help and runs nothing.**
  `clean --help` used to run the clean and delete the agent branches. A help flag counts anywhere
  in the arguments, `queue --help` shows the `queue --lint` entry too, `sandcastle herdr ... --help`
  works the same way, and `sandcastle help` no longer ends with four lines of the code's comments.
- **A detached run keeps the run before's output.** `.sandcastle/logs/run-output.log` is moved to
  `logs/archive/` when the next detached run starts, where it used to be overwritten.
- **The run's first line says how many tickets run at a time**: `1 ticket(s), 1 at a time`, where
  it said `5 at a time` for one ticket.
- **The Herdr log and report popups' bottom line is readable on any theme.** `less` drew its prompt
  ("Waiting for data..." while following a log) with the standout colours of the user's own
  `LESS_TERMCAP_so`, which could come out as yellow on light blue; the popups now use the
  terminal's own standout.
- **A test file a ticket adds no longer reads as a change beyond its Touches line**, in the report
  or the close comment. Its name cannot be known when the ticket is written. A modified test file,
  or a file added outside the conventional test paths, still counts.
- **The skill, README and install guide match what the kit does now.** A `Blocked by` chain of
  queued tickets drains in one run, so `drain` is recommended for tickets that conflict across
  turns rather than for chains; a detached run's estimate and drain lines are in
  `.sandcastle/logs/run-output.log`; the held, withdrawn, `uncommitted`, `stalled` and `left over`
  states, the 50 MB hold, `queue --lint`, jq as a requirement and the three-row mod band are
  described as they are; the update action checks every path `.sandcastle/.gitignore` needs.
- **The skill states two rules agents kept getting wrong.** A `Blocked by` ref must sit on the
  same line (a list under a `Blocked by:` heading is not read); a drain's later turns run only what
  the turn before left conflicted or released. The README's `SANDCASTLE_HERDR_VIEW` row now says
  it turns off the whole Herdr view, not a per-sandbox tab.
- **The Claude Code mod follows a run its session started in another directory**, such as a
  second clone or a monorepo package: the band, the needs-you notice and the end prompt work by
  the session id each run records. Every run now registers in the machine-wide live-runs
  directory, with or without Herdr.
- **A ticket that conflicts or goes red at landing after a usage or plan limit stopped the run is
  not requeued.** It ends conflicted or red, and the next run picks it up, where it used to be
  told it would "run again in this run".
- **A refused host git write stops new attempts at once**, not only through the landing worker.
- **A sandbox's Herdr pane closes once the run has stopped**, instead of staying open as if busy.
- **A `.git` change found while a landing waited for its own check no longer lets that ticket
  land.** The landing worker checks for a safety stop again once its check returns.
- **`sandcastle status 0` fills the terminal's width** like the live view, instead of drawing 80
  columns in any pane. Without a terminal it still uses `COLUMNS`, or 80.
- **Ctrl-C, a hangup or `sandcastle stop` can no longer leave a run hanging after it has written
  its end.** On Node 24, `process.exit` could deadlock with one of V8's background compile jobs
  (nodejs/node#66171): the exit handlers ran, then the process never ended, and a second Ctrl-C
  did nothing. A run now ends on a signal by sending that signal to itself once its exit handlers
  have run. The launcher also turns off Node's concurrent Maglev and Sparkplug compilers until
  Node ships the fix. A detached run stopped by a signal before it was going reports 130 or 143,
  as the shell would, not a bare 128.
- **`sandcastle wait` no longer returns at once with exit code 0** when it starts in the moment
  between a run releasing its lock and writing its exit code. It also follows the live pid
  recorded in run.json.
- **A waiting ticket's note stays right once its in-run blocker ends.** For a ticket that also
  waits outside the run, a blocker that landed drops out of the note, and one that ended any
  other way reads `(not in this run)`, where the note used to say `(lands this run)` until the
  run ended.
- **A requeued ticket's second attempt names its first attempt**, not "an earlier run".
- **The reviewer's check-by-hand note is kept up to 2,000 characters**, cut at a word with `…` and
  a pointer to the review log. It used to be cut to 200 characters per note and 300 in all,
  mid-word.

## [0.4.2] - 2026-10-02

### Added

- **Agent branches are checked and backed up.** The run's `.git` check now covers each
  `agent/issue-*` tip: a branch a sandbox deleted is restored from `.sandcastle/backup.git`, a
  moved tip for a ticket that is not running stops the run, a worktree record rewritten by
  `git worktree repair` is named, and a deleted or moved base stops with the `git update-ref`
  that restores it.
- **A managed Claude Code hook guards the shared `.git` inside every sandbox.** The kit's
  `container/` is mounted read-only at `/etc/claude-code`, and its hook refuses commands and
  writes that would damage the shared `.git`: `update-ref`, `gc`, `prune`, `push`,
  `reflog expire`, `worktree prune` and `repair`, deleting `agent/*` branches, and `rm`, `mv` or
  Write inside it. It reduces accidents; the host-side checks remain the protection.

### Fixed

- **A live run's header in the status view says when it ends** (`ends ~HH:MM`), never when it
  lands.
- **The closing report lists tickets requeued during the run** (the `Requeued:` line and the
  run-again next step). It looked for a ticket state the kit never writes.
- **The Herdr sidebar counts a ticket left uncommitted as needing you**, as the status view and
  the Claude Code mod do.

## [0.4.1] - 2026-10-02

### Upgrading

- **Run `/sandcastle update` once in each project.** It ends with the new `sandcastle updated`,
  which records the kit's commit for that project; from then on doctor and runs say when a pull
  brings Upgrading notes the project has not had, so a kit update is never missed. Until a project
  has been updated this way, doctor and runs say it has no record.
- **The hold label is now `ready-for-human`**, Matt Pocock's name for the role, instead of
  `needs-human`. A run that holds a ticket for a person (a risky path, an agent's hand-back) adds
  `ready-for-human`, creating it if missing. A ticket still carrying `needs-human` stays held, and
  `sandcastle requeue` takes either off. To keep `needs-human`, map `ready-for-human` to it in
  `docs/agents/triage-labels.md`; otherwise `/sandcastle update` offers to move open tickets across.

### Added

- **A pulled kit says what a project has not acted on yet.** `sandcastle doctor` in a project lists
  the changelog's **Upgrading** notes that project has not had since its last update, and
  `sandcastle run` warns about them in one line, until `/sandcastle update` records the kit's commit
  with the new `sandcastle updated` (per project and machine, in `.sandcastle/.run/`). A project with
  no record yet is told to update once; `sandcastle init` records a new project as up to date.

### Changed

- **Every triage role is read from `docs/agents/triage-labels.md`**, not only the queue label: the
  hold label (`ready-for-human`), the label agents put on the follow-ups they file
  (`needs-triage`), and, for ticket files, the `wontfix` status as done. A repo that renamed one
  needs no setting; without the file the kit uses Matt Pocock's names.

## [0.4.0] - 2026-10-02

### Upgrading

- **Run `/sandcastle update` in each project, then start a new session.** The update pulls the
  kit, which updates the `/sandcastle` skill too (it is a link into the kit), and rebuilds each
  project's image. A Claude Code, Codex or OpenCode session that was already open keeps the skill
  it loaded at its start, so v0.4's run action (detached runs) needs a new one.
- **The kit now ships an optional mod for Claude Code** (2.1.287 or newer) that shows a run in
  the session that started it and tells that session when the run ends. Nothing changes until
  it is linked: `sandcastle doctor` lists it as `opt` with the command, and `/sandcastle update`
  offers it. It is code that runs inside Claude Code with your permissions; the README's "The
  Claude Code mod" says what it reads.
- **A run now lands each ticket as soon as it goes green**, on one landing worker beside the
  pipelines, instead of landing everything at the end. A branch that does not already hold the
  current base is merged and gated in a sandbox before the base moves. If that merged tree is red,
  the ticket is not landed, and the summary names the tickets it is red with. While landing runs,
  pipelines leave one machine-wide sandbox slot free for it, so a run may start one sandbox fewer
  than `CONCURRENCY`.
- **A ticket whose blockers are all in the same run now starts in that run**, once its last
  blocker has landed and been closed, instead of waiting for the next run. A chain of `Blocked by`
  tickets can drain in one run, so a run may take longer and spend more than before. A ticket
  that also waits on anything outside the run still waits for a later one.
- **Tickets whose files overlap now start together**, and landing resolves the overlap (with
  the requeue above), instead of one waiting for the next run. A ticket is held back only for a
  file git cannot merge (a lockfile, a `generated` path, a minified file) that a ticket in flight
  also changes, read from its branch and its `Touches:` line, and it starts when that ticket
  lands or leaves the run. The start lists each mergeable overlap. Give tickets a `Touches:`
  line (format in the audit action) so the hold sees files a new ticket will change.
- **Autonomy level `drain`** (`autonomy: "drain"` or `AUTONOMY_LEVEL=drain`) keeps taking turns
  until the queue is drained, and stops with the cause named on no progress, the same ticket
  conflicting in two turns running, a red base or verify, a usage limit, a stopped run, or after
  20 turns. It suits a queue of `Blocked by` chains; levels 1-3 are unchanged.
- **Everything people and agents read says "ticket", not "issue"**: the status view's column,
  the summary, the prompts, the skill and the docs. `TICKETS=` names the tickets to run;
  `ISSUES=` still works (with `TICKETS` winning when both are set). Branch and log names
  (`agent/issue-N`, `agent-issue-*.log`), run-record fields and `{{ISSUE_NUMBER}}` are unchanged,
  so scripts that read them keep working.
- **Inside Herdr, sandbox panes are now off by default.** A run is one agent on its status
  view's pane: working, then blocked or idle at the end, beside the workspace's progress and the
  tab bar entry. `herdr: { panes: "all" }` in the config, or `SANDBOX_PANES=all` for one run,
  brings back a pane per sandbox.
- **The agent skill now starts a run detached** (`sandcastle run --detach`) and waits for it with
  `sandcastle wait`, so the run outlives the agent's session and no longer opens beside it. A run
  typed in your own terminal is unchanged. A detached run refuses autonomy level 1, which asks
  its question on the terminal.
- **A ticket that conflicts or goes red at landing is sent back once, in the same run.** Its
  pipeline merges the base in, resolves, gates and gets a narrow review, as a re-run does, so
  the run spends that pass now rather than on the next run. A second conflict or red holds it for
  the next run, naming the tickets of both attempts.
- **The base check now runs the repo's `pre-commit` and `commit-msg` hooks** (with `git hook
  run`, nothing committed) in the base-gate sandbox, and stops like a red gate when one refuses.
  A project whose hook needs a tool the image lacks now stops before any agent starts, instead
  of every agent's commit being refused. Add the tool to `.sandcastle/Dockerfile`, then run
  `sandcastle gates`. Git older than 2.36 skips the probe with a note.
- **A blocker closed as not planned now holds its dependants.** Before, it counted as done and the
  dependant started without the work it waited for. Reopen the blocker, or remove its
  `Blocked by` line.
- **The kit's own commits during a run are no longer signed**, even with `commit.gpgSign` on: a
  signing program is one a sandbox could replace in `.git/config`. This covers landing merges and
  ticket-file commits. Your own commits are unaffected. A repo that requires signed commits on its
  base branch needs them signed before pushing (for example `git rebase --exec 'git commit
  --amend --no-edit -S'`), or landing by hand.
- **Inside Herdr, a sandbox's sidebar entry is now named after its ticket** (`#12 Add CSV
  export`), not `sandbox`. A script that matched the display name `sandbox` should match the agent
  label `sandcastle` instead.
- **The kit has an opt-in Herdr plugin.** `sandcastle herdr configure` links it and adds its
  sidebar rows, tab bar entry and three keys to Herdr's `config.toml`, after showing the block and
  asking; `--remove` takes all of it out. `/sandcastle update` offers it when doctor says it is
  missing. Herdr 0.9.3 or later.

### Changed

- Landing and the pipeline queue moved out of `burndown()` into `src/landing.ts` and
  `src/schedule.ts`.
- The host git of a run now has `gc.auto=0`, so a landing merge never starts maintenance while
  sandboxes add worktrees.
- The start-of-run estimate and the status view's `usually` times come from the last three
  runs (widened until they hold five tickets), not the project's whole history.
- Inside Herdr, a run reports each sandbox's step and time in that step, and its workspace's
  progress (`🏰 4/9 · 1 needs you`), to the sidebar. Herdr keeps none of it across a restart, so it
  is sent again every minute, and it expires a few minutes after a run that was killed.
- Inside Herdr, the status view links each ticket to its latest log (OSC 8), for the plugin's
  Ctrl-click; `SANDCASTLE_LINKS=0` turns the links off.
- Inside Herdr, a run at autonomy level 1 marks its own pane as blocked while it asks whether to
  run tickets again, so Herdr's sidebar and notifications say it is waiting for you.

### Security

- **In-run landing is hardened against live sandboxes.**
  - The landing writer accepts a moved base only when its own write made it: a merge holding
    exactly the gated tree, or a ticket file's commit. A base moved by anything else during a
    write - a `gh` call takes seconds - stops the run instead of being taken as the kit's own.
  - A sandbox landing reads its merge commit before the gates run, refuses a scratch ref moved
    since, and checks the tree against the host's own `git merge-tree` (git 2.38+).
  - `.git/HEAD` is fingerprinted.
  - The abort and `git status` after a failed merge are checked first, like a write.
  - A re-run's conflict resolution is checked against a base tip only if the host finds it on the
    base.
- **Git config keys that run a program are pinned for the run's host git.** `core.fsmonitor`
  and commit signing are off, and drivers, pagers, editors and signing programs keep the value
  configured at the start. So the kit's own landing merges and ticket-file commits are no longer
  signed, even where `commit.gpgSign` is on.

### Fixed

- An unexpected error while landing one ticket (a tracker call that failed, a full disk) no longer
  ends the run with pipelines still working. That ticket is `not landed`, and the others land.
- With a machine-wide sandbox limit of 1, a landing that needs a sandbox no longer waits for every
  pipeline to end: pipelines start no new sandbox while a landing waits for one.
- `.git/info/refs`, which `git repack` (an auto gc in a sandbox) rewrites, no longer reads as
  tampering and stops the run.
- The blocker check now also names a blocker held for a human, one that is open but not queued,
  and a `Blocked by` line written inside code (which a run does not read). The closing summary
  says why each ticket is still blocked.
- In a run with an autonomy level, a turn the loop continues from no longer tells you to do
  what the loop is about to do: its Next step names the next turn, and if `drain` then stops,
  your steps are printed after all. Runnable now says why each ticket can run, and a conflict
  resolution held for a person reads as `held` with the files it changed, never "nothing to
  change".
- A finished ticket whose commit was refused (a hook, a full disk, signing) is now `uncommitted`
  under Needs you, pointing at its kept worktree and `sandcastle requeue`, instead of "nothing
  to change". The implement prompt asks the agent to check its commit landed.
- A requeued ticket withdrawn before its second attempt is recorded as withdrawn, not green; a
  second conflict keeps its files in the summary and names both attempts' tickets.
- The file hold re-reads the files of each ticket in flight, so a lockfile a branch gains during
  the run holds a ticket that declares it. A stopped run leaves held tickets naming their real
  holder, and a broad `Touches:` line reads file sizes in one `git ls-tree`, not one call per file.
- A run started by an agent no longer adopts the agent's tab and splits its panes beside it: a
  run adopts the tab it is alone in only when started from a terminal.
- The live status view no longer echoes typed keys or the mouse wheel's escapes onto its frame,
  or leaves them queued for the shell. Ctrl-C ends it at once.
- Later autonomy turns keep every waiting ticket, so a ticket freed by a landing in that turn is
  listed under Runnable now, and the cap line prints when the turns run out.
- A conflict resolution on a re-run that changes files the merge had joined cleanly is refused,
  and the ticket is held for a person.
- The status view draws a wide pane over ten times faster under macOS's bash 3.2 - one frame of a
  191-column pane took 12 seconds, now about one - and four times faster under bash 5. Measuring a
  cell's width no longer uses extglob patterns, which bash 3.2 matches very slowly.

### Added

- **A Claude Code mod** (`mod/`, optional): the session that started a run shows it in a band
  above the prompt, in the status view's castle, glyphs and colours; pins a line and shows a
  notice when a ticket comes to need a person; and gets a prompt when the run's process is gone,
  so it closes the run without a background watcher or Herdr. `/sandcastle-status` prints the
  run as text with no model turn. `sandcastle setup` offers it and `sandcastle doctor` reports
  it, with the reason when Claude Code has mods turned off. The README's "The Claude Code mod"
  lists everything it reads and calls.
- `sandcastle queue --lint` shows a queue's shape before the first run: chain depth, overlapping
  `Touches:` lines, and blockers that are not queued or missing. It is read-only and always exits 0.
- A ticket body's `Touches:` line (format in the audit action) is parsed, with a check for files
  git cannot merge. Nothing schedules on it yet.
- A landing compares the diff with the ticket's `Touches:` line. Files outside it are named in
  the close comment and under Done in the closing summary - a warning, never a hold.
- The status view and closing summary follow in-run landing: a landing does not count as a
  sandbox slot, the estimate reads `ends ~HH:MM`, a requeued ticket shows as such, and a merged
  tree that is red names the tickets it is red together with.
- The audit action clusters findings that touch the same files before filing, and separates real
  dependencies from order-only ones.
- **A project website** at <https://henkisdabro.github.io/sandcastle-kit/>: who the kit is for, a
  live status view playing an overnight run, how a run works, the safety model and the install
  steps. It lives in `site/` (static, no build step) and deploys from `main` by a GitHub Pages
  workflow.
- The pre-commit hook reads an **allowlist** beside your denylist
  (`~/.config/sandcastle-kit/allowlist`): a staged line matching it passes, so an author credit
  you mean to publish can carry a name the denylist blocks everywhere else.
- `sandcastle run --detach` starts a run as its own process, with its output in
  `.sandcastle/logs/run-output.log` and its last lines under the status view; `sandcastle wait
  [seconds]` ends with the run and prints its summary, and `sandcastle stop` stops it as Ctrl-C
  does.
- A red merged base at the end of a run (`RED TOGETHER`) keeps its gates' output in
  `.sandcastle/logs/verify-gates.log`, as red base gates keep theirs in `base-gates.log`.
- **The Herdr plugin** (`herdr/`, set up by `sandcastle herdr configure`): the status view over
  any tab and the last run's report as a popup (`prefix+shift+s`, `prefix+shift+e`), Ctrl-click a
  ticket in the status view to read its log in a popup, "sandboxes first" in the Agents panel
  (`prefix+shift+a`, restored after a Herdr restart), each sandbox's step and time and the run's
  progress in the sidebar, and every live run on the machine in the tab bar. `sandcastle setup`
  offers it inside Herdr, and `sandcastle doctor` says whether it is in place.

## [0.3.0] - 2026-10-01

### Upgrading

- **`jq` is now a checked requirement.** The status view always needed it; without it the view
  went blank and wrong with no error. `sandcastle doctor` now fails without `jq`, and the status
  view says it is missing. macOS 15 and later ship it; on most Linux, `apt install jq` (or `dnf`).
- A watcher that parses the closing summary's headline: `N need you` now counts only the **Needs
  you** section - merged tickets the reviewer flagged as unproven by any gate included, listed as
  `merged - check by hand` - and a new `N need fixing` counts the **Needs fixing** one.
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
- **Gates run without the kit's tokens.** `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
  `ANTHROPIC_API_KEY` are unset for every gate command, and a value of one that still appears in
  gate output is replaced with `<redacted>`. A gate whose test read one of them now sees nothing:
  give that test its own variable in `.sandcastle/.env`. `/sandcastle update` checks for it.
- **A branch that adds or grows a file over 50 MB is held for a human merge**, as a protected path
  is: GitHub warns at 50 MB and refuses a push with a file over 100 MB, and such a file stays in
  the history. `sandcastle land` refuses it with the same reason.

### Changed

- The skill loads less for most actions: the run action's closing hand-off and the whole
  `update` action moved into `skill/run.md` and `skill/update.md`, which `SKILL.md` names when
  they are needed.
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
  it could not reach the release channel.
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

- For contributors: the test suite no longer hangs or fails only on macOS, under load, inside a
  sandbox or with commit signing on (signal tests, mise or asdf `node` shims, BSD `script`, the
  agent committer's identity, a locked signing agent).
- A ticket's gate log is kept across attempts instead of being wiped at each one, and every
  agent and gate log marks the start of each run's phase with its run id and local time.
- `init`'s placeholder gate points at `.github/workflows` and `node --test`, and says Python
  detection needs uv.
- A branch that conflicts at landing says so on its issue - the files and the other ticket - in
  the one comment the run already posts, instead of only in the console.
- Gate times under 10 seconds show one decimal (`green in 0.4s`, not `green in 0s`).
- A run closed by SIGHUP, SIGTERM or Ctrl-C outside the sandbox phase - a closed pane, say -
  now records its end and releases its lock, instead of leaving no end line.
- Preflight's model calls run at the same time instead of one after another.
- Dry runs also catch a new issue or an edited issue body, not only changes to the run's own
  tickets.
- `sandcastle init` on an existing config says how to start over.
- The help text says `clean --all` deletes unmerged branches without asking.
- Troubleshooting covers a failed Codex cross-review preflight, which is fixed on the host.
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
- A run that stops on red base gates says so in its closing summary: `Run stopped: red on <base>
  before any agent ran`, `0 attempted`, the failing gates, and a fix-the-base next step. It used
  to read as 'N attempted, 0 merged' with no cause.
- `sandcastle init` no longer glues its first `.gitignore` entry onto a last line with no final
  newline (which could leave `.env` unignored).
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
- The `.git` tamper stop names the file that changed (`.git/config`, a hook, or a file in
  `.git/info/`) instead of "`.git/config` or `.git/info/`", so it can be checked without guessing.
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
- **Security:** a gate that printed its environment put `GH_TOKEN` and the Claude OAuth token, in
  full, in the gate log, the terminal and a repair agent's prompt - from where an agent's comment
  could carry them to the tracker. Gates are the project's code, on a branch code an agent wrote;
  they no longer see those tokens.
- `sandcastle doctor` makes a committed `.sandcastle/.env` a FIX - untrack it and rotate its
  tokens, as they stay in the history - and one that is not gitignored a FIX with the ignore line.
  Before, it checked only the file's mode.
- For contributors: the kit's pre-commit hook skips blank lines and `#` comments in the personal
  denylist. A blank line matched every staged line and blocked every commit. Its missing-gitleaks
  message now names a Linux install too.
- `sandcastle preview` showed a branch that landing would hold for a person (a protected path such
  as `.githooks/` or `.gitattributes`, or a file over 50 MB) as `clean`; it now shows `held` and
  why. Its note about conflicting branches appears only when one conflicts. `sandcastle land`'s
  refusal of a protected branch gives the review and merge commands.
- When several unmerged tickets fail or conflict in the same files, the closing summary's first
  step now also says they are still queued and the next `sandcastle run` resumes each branch
  (merging the base in first), or `sandcastle land <n>` - grouped, they had no step of their own.

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
- Each ticket's last reviewed head and last green head are recorded in
  `.sandcastle/logs/heads.json`, for re-runs to build on.
- A skill-only `audit` action (`/sandcastle audit`): review lenses run as read-only subagents on
  the host, and their findings are filed as issues by the queue's criteria. The steps live in
  `skill/audit.md`.
- Before its slow steps, a run prints a rough token and time estimate from the medians of the
  project's earlier tickets (`timings.jsonl`), once there are any.
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

[Unreleased]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/henkisdabro/sandcastle-kit/releases/tag/v0.1.0
