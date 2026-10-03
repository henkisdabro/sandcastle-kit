# Architecture notes

What each of the kit's larger modules owns, in more detail than `AGENTS.md`'s Layout table. Read
the section for a file before changing it; update it in the same commit when a rule here changes.
The terms (run record, attempt, ending, requeued) are defined in `CONTEXT.md`.

## `bin/sandcastle`

Shell entry; resolves symlinks, checks the temp directory can be written, runs `src/cli.ts` in one node process with the kit's own tsx loader (not the tsx binary, whose child is SIGKILLed on a slow answer to SIGTERM); `sandcastle herdr ...` runs `src/herdr-plugin.ts` alone, as Herdr's tab bar calls it every 10 seconds

## `src/cli.ts`

Commands: help, `--version`, setup, doctor, init, updated, build, gates, land, preview, lean, lean-apply (internal hook), preflight, queue, requeue, blockers, run (`--detach`), wait, stop, report, status, clean, herdr; also the autonomy loop around `burndown()`. The help text and each command's `--help` come from `src/help.ts`

## `src/burndown.ts`

The orchestrator: base gates, then every attempt and landing through `createSchedule(plan).run(work)` (the attempt port: implement, review, gate with repair; the land port: merge or squash, on the landing worker as each ticket goes green), then verify and report; it records what the scheduler tells, handing each ending to the ledger (`src/ledger.ts`), and posts the comments the ledger words after the schedule; dependencies, the files the scheduler's hold compares (`ticketFiles`, `refreshFiles`: one ticket at a time per file git cannot merge) and the record of what it tells (`createHoldRecord`), re-runs of carried branches (land-only, narrow review), timings

## `src/landing.ts`

`landOne(ctx, outcome)`: landing one green branch (tracker check, moved head, held paths, then a merge as it is when the branch holds the base's tip, otherwise a merge gated in a sandbox, close) and what it returns; `landingWork(ctx)`: the scheduler's land and host ports over one `LandContext`; the record helpers of a requeued or withdrawn ticket and of a run stopped while it was green; `createRequeueRecord`: the run record's side of the scheduler's requeue-once rule - a requeue written as it is told, a second collision's note, a requeued ticket whose second attempt never began put back - which the burndown hands what the scheduler tells; `createHostGit`: the mutex through which every host git write goes and which moves the run's expected base; also the landing merge, its abort and the conflict line. What it posts to the tracker as it lands (the close comment, a hold, an earlier merge closed) it asks the ledger's `describe` for

## `src/ledger.ts`

The ticket ledger: one place that turns each ending (`src/schedule.ts`) into everything a run says about its ticket.

- **`describe(ending, context)`** is pure and exhaustive over the `Ending` kinds (the type checker holds it): the ticket state the run ends on, the **outcome** (kind, `with`, text), the view's word and whether it counts as landed, and the tracker's text (a close, a hold, or the one comment on a ticket that did not land). The context is what the ending does not carry yet: the base, the gates' names, the agents' report, a dry run, a kept worktree, a hold note or the tracker's hold label, the run's stop line. `test/ledger.test.ts` holds every ending's four sayings side by side.
- **The writer** (`createLedger`) records what `describe` says as burndown's `ended` is told each ending: the outcome (it is the only writer of an ending's outcome; the attempt writes only a green's "waiting to land"), the view's word, and the states no one else writes yet (withdrawn or refused before it began, stopped or crashed while green). `landOne` and the requeue record still write a landing's state, the attempt a pipeline's, and the burndown a ticket the stop left unstarted. An ending is recorded again when a fact about it is learnt later (the tracker's hold label, read after the schedule). Each ticket's entry is kept.
- **`accountLanding(entries)`**: what the closing notification and the verify read - the merged list and the counts - from the entries.
- Also the words themselves: `closeComment`, `notLandedComment`, `pipelineOutcome`, `refusedRecord`.

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

The machine-wide live-runs directory (`RUNS_DIR`, `XDG_CACHE_HOME` or `~/.cache`, on Linux and macOS alike): `registerRun` writes a run's file (named by the resolved root) from `burndown()`, Herdr or not, and removes it at exit. The Herdr tab bar (`liveRuns` in `src/herdr-plugin.ts`) and the Claude Code mod (`REGISTRY_SCRIPT` in `mod/hooks/run-state.ts`) read it; the mod follows a run whose recorded `session` (`CLAUDE_CODE_SESSION_ID`) is its own. `commandOf` is the real process check that `liveness` is given: a signal of 0, then `ps -p <pid> -o command=`.

## `src/blockers.ts`

What holds a ticket back: `Blocked by` refs (GitHub, Linear, ticket files), and comments a run would ignore; `openBlockersNow`: the scheduler's blockers port, the open blockers of the tickets held for one that has just landed; `blockedNote`: the wording of what a held ticket waits for

## `src/touches.ts`

The `Touches:` line of a ticket body: `parseTouches`, `expandTouches` against a ref's tree, and `unmergeableFiles` (lockfiles, `generated` paths, minified blobs; sizes from one cached `ls-tree` per commit), and `isTestPath` (conventional test names; a test file a branch adds is not a `Touches:` overrun), and `isAgentDoc` (`AGENTS.md` and `CLAUDE.md` at any depth; a change to one is not an overrun when the branch adds a file). A scheduling hint and warning source, never a guard

## `src/lint.ts`

`lintQueue()`: the queue's shape for `sandcastle queue --lint` - longest `Blocked by` chain, edges that only order overlapping `Touches:`, wide tickets, hot and shared unmergeable files, `blockerProblems` and blockers listed under a heading (which the parser does not read), a rough estimate. Read-only advice

## `src/detach.ts`

`sandcastle run --detach`, `wait` and `stop`: `startDetached` (the run as a process of its own - `spawn` with `detached: true`, output to `.sandcastle/logs/run-output.log` - and the line printed once it is going), `livePid` (the run lock's pid, if it is a process of the kit), `waitForRun` (also waits for the pid run.json names while it has no end, and the one it last saw, to die: the lock goes before the record's `exitCode` is written), `recordedExitCode`

## `src/guard.ts`

Host safety: git hooks and auto-gc off, command-running config pinned, `.git` fingerprint (config, HEAD, info, hooks; its base is the one the run expects, which the landing worker moves only by its own writes; and the tips of `agent/issue-*`, which `HostGit.begin`, `settle` and `forget` in `src/landing.ts` keep: a ticket in flight may move its branch, any other tip that moves stops the run, and a branch that vanished is restored from the bare repo `.sandcastle/backup.git`, where a pipeline's end copies it and a landing drops it), a deleted or moved base stops with the `update-ref` that restores it, a worktree record rewritten to a container path is named, protected paths and files over 50 MB held for a person, run lock

## `src/run.ts`

Preconditions, run arguments, keep-awake, preflight, prompt rendering, agent logs (with the raw `.jsonl` sidecar), run record and history, typical times and the estimate, recorded heads, outcomes (`outcomes.json`: each entry's kind from the closed set, the tickets it collided with and its line; a reader decides on the kind, never the line, and `test/outcome-kinds.test.ts` fails on one that matches the line), log archive, status pane

## `src/versions.ts`

Which Claude Code and Codex the image gets: Claude Code's `stable` channel by default (`claudeCode` or `CLAUDE_CODE_VERSION` picks `latest` or an exact version), Codex's npm `latest` tag (or `CODEX_VERSION`), resolved on the host, cached six hours, with the Dockerfile's defaults as the offline fallback; the versions are part of the image tag

## `prompts/`

Implement, review, repair and resolve (a re-run's conflicted base merge) templates. The kit fills `{{KIT_*}}`; Sandcastle fills `{{ISSUE_NUMBER}}`, `{{TICKET}}`, `{{SOURCE_BRANCH}}`, `{{TARGET_BRANCH}}` and `` !`cmd` ``

## `container/`

Mounted read-only at `/etc/claude-code` in every sandbox (`sandboxMounts` in `src/sandbox.ts`): `managed-settings.json` registers `git-guard.sh`, a `PreToolUse` hook on the Bash, Write and Edit tools that refuses commands and writes that damage the shared `.git` (`test/git-guard.test.ts`). Managed settings sit above project settings, so a branch cannot disable it. Needs bash and `jq` in the image

## `test/*.test.ts`

One file per behaviour, named after it (`land-command`, `autonomy`, `report`, `guard`, `skill-split` ...), against temp repos, made-up records and fake sandboxes. Some read the docs: the `skill*` tests check SKILL.md's frontmatter and sections, run.md's seven headings against `src/report.ts`, update.md's step references and AGENTS.md's Layout row for `skill/`

## `skill/`

The skill serves three harnesses. The directory (not the file - `src/setup.ts` links the directory) is symlinked into `~/.claude/skills/sandcastle` (Claude Code, also scanned by OpenCode) and `~/.agents/skills/sandcastle` (Codex). `SKILL.md` works in all three because each ignores frontmatter it does not know. Keep it portable:

- `name` stays `sandcastle`, matching the directory the user links it as.
- `description` stays under 1,024 characters (OpenCode rejects longer) and carries every trigger: Codex and OpenCode never see Claude Code's `when_to_use`.
- `argument-hint` and `arguments: [action]` are Claude Code's; the body handles an unfilled `$action` for the other two.
- Name harness-specific tools by what they do, with the Claude Code name as an example ("the harness's question tool (`AskUserQuestion` in Claude Code)").
- `SKILL.md` loads whole for every action, so a long section that only one action needs lives in a sibling file that `SKILL.md` names in prose ("read run.md in this skill's directory") - Codex and OpenCode do not fill `$action`, so they find the file from the text.

## `mod/`

The optional Claude Code mod, a plugin linked as `~/.claude/skills/sandcastle-mod`: `hooks/register.tsx` (the hooks: watch `run.json`, the band above the prompt, the needs-you line and notice, the prompt when the run's process is gone, `/sandcastle-status`), `hooks/run-live.ts` (pure, imports nothing: the one rule for "is this run live" - a run is live when its record has not finished and its pid is a process whose command line contains `RUN_COMMAND`; `liveness` answers `live`, `finished` (with its exit code), `own` (the asking process itself, which is not "another live run") or `dead` from the record, the run lock's pid and an injected process check, and EPERM is the check's business: a process that exists is read like any other. `src/report.ts`, `src/herdr-plugin.ts` and `src/detach.ts` pass `commandOf` from `src/live-runs.ts`; the mod passes `ps`; `status.sh` keeps a bash `run_alive` of the same rule, which `test/run-live-contract.test.ts` holds to it. The mod alone ignores `finishedAt`, since every turn of one run writes one and the run goes on; the machine-wide slot locks in `src/pool.ts` are not runs and stay a plain "the pid exists"), `hooks/run-record.ts` (pure, imports nothing: the run record and ticket record types, the closed list of ticket states, the derived states, the tables from ticket state to group and word, and the closed list of outcome kinds; the kit's own `src/` imports it too, so every write is typed by it, `readTickets` passes each state read from disk through the guard, and `readOutcomes` (`src/run.ts`) each outcome kind through `isOutcomeKind`), and `hooks/run-state.ts` (pure: the record read as groups, glyphs and colours, the palette and castle, and the band cut to its width - `test/mod.test.ts` holds both to `src/run.ts` and `status.sh`). It runs inside Claude Code, not under `tsx`, and imports nothing from `src/`. Its own tests are `mod/tests/`, run by `claude plugin test mod`

Verifying a change to it needs Claude Code 2.1.287 or newer on PATH: `pnpm test` then runs `claude plugin validate` and the mod's own tests (`test/mod.test.ts`), and skips them without it, as CI and the sandboxes do. That checks the hooks and the tree they return, never the paint: look at a changed drawing in a real session, `claude --plugin-dir mod` from a project with a run record. The mod's API is early access, and its types are the authority, not memory. That session writes them to `mod/.claude-plugin/types/` with a `mod/tsconfig.json` (both gitignored; they are absent until then, and `mod/types/index.d.ts` holds only the band's own types); from then on `pnpm test` type-checks the mod too, which the kit's own `tsc` does not cover. Grep the types for the member you need rather than reading them: they run to thousands of lines. `claude plugin test mod` reporting "hooks modules are turned off" is Claude Code's rollout switch, not the mod.

## `site/`

The project website on GitHub Pages: static HTML, CSS and plain scripts (not modules, so it also opens from disk), no build step. `js/status.js` ports the status view's grid to play a made-up run; `js/sand.js` draws the castle, dunes and grains. `.github/workflows/pages.yml` deploys it
