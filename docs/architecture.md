# Architecture notes

What each of the kit's larger modules owns, in more detail than `AGENTS.md`'s Layout table. Read
the section for a file before changing it; update it in the same commit when a rule here changes.
The terms (run record, attempt, ending, requeued) are defined in `CONTEXT.md`.

## `bin/sandcastle`

Shell entry; resolves symlinks, checks the temp directory can be written, runs `src/cli.ts` in one node process with the kit's own tsx loader (not the tsx binary, whose child is SIGKILLed on a slow answer to SIGTERM); `sandcastle herdr ...` runs `src/herdr-plugin.ts` alone, as Herdr's tab bar calls it every 10 seconds

## `src/cli.ts`

Commands: help, `--version`, setup, doctor, init, updated, build, gates, land, preview, lean, lean-apply (internal hook), preflight, queue, requeue, blockers, run (`--detach`), wait, stop, report, status, clean, herdr; also the autonomy loop around `burndown()`

## `src/burndown.ts`

The orchestrator: base gates, then every attempt and landing through `createSchedule(plan).run(work)` (the attempt port: implement, review, gate with repair; the land port: merge or squash, on the landing worker as each ticket goes green), then verify and report; it records what the scheduler tells and builds the Landings lists and outcome lines from the endings; dependencies, the files the scheduler's hold compares (`ticketFiles`, `refreshFiles`: one ticket at a time per file git cannot merge) and the record of what it tells (`createHoldRecord`), re-runs of carried branches (land-only, narrow review), timings

## `src/landing.ts`

`landOne(ctx, outcome)`: landing one green branch (tracker check, moved head, held paths, then a merge as it is when the branch holds the base's tip, otherwise a merge gated in a sandbox, close) and what it returns; `landingWork(ctx)`: the scheduler's land and host ports over one `LandContext`; `accountLanding`, `landingLines` and the record helpers the burndown turns endings into; `createRequeueRecord`: the run record's side of the scheduler's requeue-once rule - a requeue written as it is told, a second collision's note, a requeued ticket whose second attempt never began put back - which the burndown hands what the scheduler tells; `createHostGit`: the mutex through which every host git write goes and which moves the run's expected base; also the landing merge, its abort, the close comment and the conflict line

## `src/resolution.ts`

`strayChanges`: compares a conflict resolution with git's own automatic merge (`git merge-tree --write-tree`, git 2.38 or newer) and names the changed paths that merged cleanly, so the land-only path holds the ticket instead of reviewing a resolution that dropped another ticket's lines

## `src/schedule.ts`

`createSchedule(plan)` is the run's one path for attempts and landings: `start` (the candidates in
start order) and `run(work)`, which resolves to each ticket's typed **ending** and the run's stop
state.

- **Ports.** `attempt` (with `last()`, true once nothing more will start), `land`, `host` and `tell`.
- **Requeue once.** A first conflict or red at landing gets a second attempt carrying what it
  collided with, unless the run starts nothing. The ticket is told before it is pushed back; a
  second collision is final.
- **Release of dependants.** The tickets held for a blocker that starts in this run: when one lands
  and closes, the blockers of the ones that waited for it are read again through the plan's
  `blockers.open` port, and each with none open starts through the file hold. Any other ending, a
  run that starts nothing or a dry run releases none, and each held ticket is told what it waits
  for now.
- **Endings.** The queues stay open until every ticket has its ending; on each ending its files are
  freed and its dependants released before the open count drops.
- **The file hold** (the scheduler's own too). A ticket sharing a file git cannot merge with one in
  flight is parked until that one lands or leaves the run. It is decided for the start as the
  schedule is made (`start`: the candidates in start order, each with its wait, before the run
  record exists) and told as the run goes (`started`, `waits`, `next run`). Mergeable shares are
  only named. A ticket in flight has its branch's files read again before each comparison; a run
  that starts nothing tells each parked ticket it waits for the next run; a dry run (no `files`)
  holds nothing.
- `createStopState`: the stop state, whose `add` only the scheduler holds.
- `createLanding`: the one worker that lands each green ticket, a carried branch first.
- `createQueue<T>(rank?)`: the work queue of the pipeline fan-out and of the landing worker (`push`,
  `close`, `run(workers, fn)`). Workers wait while it is open and empty, so an item can be pushed
  mid-run; a higher `rank` goes first, equals in arrival order.

## `src/upgrading.ts`

Whether a pulled kit has **Upgrading** notes a project has not had: the project's update record (`.sandcastle/.run/kit-updated`, written by `sandcastle updated` and `init`: the release and the notes acted on; an older record's kit commit is read through git) against the kit's own notes, and the lines doctor and a run print. Also `kitVersion`, the version doctor and `--version` print: `package.json`'s release, and in a clone past its tag, the distance and commit

## `src/herdr.ts`

Herdr helpers and the run's view: the tab (adopted only from a terminal), per-sandbox panes only with `herdr.panes: "all"` (otherwise the run is one agent on the status pane), agent-state reports, sidebar tokens, the workspace's run summary

## `src/live-runs.ts`

The machine-wide live-runs directory (`RUNS_DIR`, `XDG_CACHE_HOME` or `~/.cache`, on Linux and macOS alike): `registerRun` writes a run's file (named by the resolved root) from `burndown()`, Herdr or not, and removes it at exit. The Herdr tab bar (`liveRuns` in `src/herdr-plugin.ts`) and the Claude Code mod (`REGISTRY_SCRIPT` in `mod/hooks/run-state.ts`) read it; the mod follows a run whose recorded `session` (`CLAUDE_CODE_SESSION_ID`) is its own

## `src/blockers.ts`

What holds a ticket back: `Blocked by` refs (GitHub, Linear, ticket files), and comments a run would ignore; `openBlockersNow`: the scheduler's blockers port, the open blockers of the tickets held for one that has just landed; `blockedNote`: the wording of what a held ticket waits for

## `src/touches.ts`

The `Touches:` line of a ticket body: `parseTouches`, `expandTouches` against a ref's tree, and `unmergeableFiles` (lockfiles, `generated` paths, minified blobs; sizes from one cached `ls-tree` per commit), and `isTestPath` (conventional test names; a test file a branch adds is not a `Touches:` overrun). A scheduling hint and warning source, never a guard

## `src/lint.ts`

`lintQueue()`: the queue's shape for `sandcastle queue --lint` - longest `Blocked by` chain, edges that only order overlapping `Touches:`, wide tickets, hot and shared unmergeable files, `blockerProblems`, a rough turn count. Read-only advice

## `src/detach.ts`

`sandcastle run --detach`, `wait` and `stop`: `startDetached` (the run as a process of its own - `spawn` with `detached: true`, output to `.sandcastle/logs/run-output.log` - and the line printed once it is going), `livePid` (the run lock's pid, if alive), `waitForRun` (also waits for that pid to die: the lock goes before the record's `exitCode` is written), `recordedExitCode`

## `src/guard.ts`

Host safety: git hooks and auto-gc off, command-running config pinned, `.git` fingerprint (config, HEAD, info, hooks; its base is the one the run expects, which the landing worker moves only by its own writes; and the tips of `agent/issue-*`, which `HostGit.begin`, `settle` and `forget` in `src/landing.ts` keep: a ticket in flight may move its branch, any other tip that moves stops the run, and a branch that vanished is restored from the bare repo `.sandcastle/backup.git`, where a pipeline's end copies it and a landing drops it), a deleted or moved base stops with the `update-ref` that restores it, a worktree record rewritten to a container path is named, protected paths and files over 50 MB held for a person, run lock

## `src/run.ts`

Preconditions, run arguments, keep-awake, preflight, prompt rendering, agent logs (with the raw `.jsonl` sidecar), run record and history, typical times and the estimate, recorded heads, log archive, status pane

## `src/versions.ts`

Which Claude Code and Codex the image gets: Claude Code's `stable` channel by default (`claudeCode` or `CLAUDE_CODE_VERSION` picks `latest` or an exact version), Codex's npm `latest` tag (or `CODEX_VERSION`), resolved on the host, cached six hours, with the Dockerfile's defaults as the offline fallback; the versions are part of the image tag

## `prompts/`

Implement, review, repair and resolve (a re-run's conflicted base merge) templates. The kit fills `{{KIT_*}}`; Sandcastle fills `{{ISSUE_NUMBER}}`, `{{TICKET}}`, `{{SOURCE_BRANCH}}`, `{{TARGET_BRANCH}}` and `` !`cmd` ``

## `container/`

Mounted read-only at `/etc/claude-code` in every sandbox (`sandboxMounts` in `src/sandbox.ts`): `managed-settings.json` registers `git-guard.sh`, a `PreToolUse` hook on the Bash, Write and Edit tools that refuses commands and writes that damage the shared `.git` (`test/git-guard.test.ts`). Managed settings sit above project settings, so a branch cannot disable it. Needs bash and `jq` in the image

## `test/*.test.ts`

One file per behaviour, named after it (`land-command`, `autonomy`, `report`, `guard`, `skill-split` ...), against temp repos, made-up records and fake sandboxes. Some read the docs: the `skill*` tests check SKILL.md's frontmatter and sections, run.md's seven headings against `src/report.ts`, update.md's step references and this table's `skill/` row

## `mod/`

The optional Claude Code mod, a plugin linked as `~/.claude/skills/sandcastle-mod`: `hooks/register.tsx` (the hooks: watch `run.json`, the band above the prompt, the needs-you line and notice, the prompt when the run's process is gone, `/sandcastle-status`), `hooks/run-record.ts` (pure, imports nothing: the run record and ticket record types, the closed list of ticket states, the derived states, and the tables from ticket state to group and word; the kit's own `src/` imports it too, so every write is typed by it, and `readTickets` passes each state read from disk through the guard), and `hooks/run-state.ts` (pure: the record read as groups, glyphs and colours, the palette and castle, and the band cut to its width - `test/mod.test.ts` holds both to `src/run.ts` and `status.sh`). It runs inside Claude Code, not under `tsx`, and imports nothing from `src/`. Its own tests are `mod/tests/`, run by `claude plugin test mod`

## `site/`

The project website on GitHub Pages: static HTML, CSS and plain scripts (not modules, so it also opens from disk), no build step. `js/status.js` ports the status view's grid to play a made-up run; `js/sand.js` draws the castle, dunes and grains. `.github/workflows/pages.yml` deploys it
