# Architecture notes

What each of the kit's larger modules owns, in more detail than `AGENTS.md`'s Layout table. Read
the section for a file before changing it; update it in the same commit when a rule here changes.
The terms (run record, attempt, ending, requeued) are defined in `CONTEXT.md`.

## `bin/sandcastle`

Shell entry; resolves symlinks, checks the temp directory can be written, runs `src/cli.ts` in one node process with the kit's own tsx loader (not the tsx binary, whose child is SIGKILLed on a slow answer to SIGTERM); `sandcastle herdr ...` runs `src/herdr-plugin.ts` alone, as Herdr's tab bar calls it every 10 seconds

## `src/cli.ts`

Commands: help, `--version`, setup, doctor, init, updated, build, gates, land, preview, lean, lean-apply (internal hook), preflight, queue, requeue, blockers, run (`--detach`), wait, stop, report, status, clean, herdr; also the autonomy loop around `burndown()`. The help text and each command's `--help` come from `src/help.ts`

## `src/burndown.ts`

The orchestrator: base gates, then every attempt and landing through `createSchedule(plan).run(work)` (the attempt port: implement, review, gate with repair; the land port: merge or squash, on the landing worker as each ticket goes green), then verify and report; it records what the scheduler tells, handing each ending to the ledger (`src/ledger.ts`), and posts the hold notes and the comments the ledger words after the schedule; the attempt reports its pipeline (`attempted`) with the agent's hand-back read as it ends (`handBack`) and the `.git` check after its sandbox closed (`settleAfter`), whose failure stops the run without replacing the pipeline's own ending, and writes only the pipeline's facts (commits, minutes, tokens); dependencies, the files the scheduler's hold compares (`ticketFiles`, `refreshFiles`: one ticket at a time per file git cannot merge) and the record of what it tells (`createHoldRecord`), re-runs of carried branches (land-only, narrow review), timings

## `src/landing.ts`

`landOne(ctx, outcome)`: landing one green branch (tracker check, moved head, held paths, then a merge as it is when the branch holds the base's tip, otherwise a merge gated in a sandbox, close) and what it returns - how it landed and the facts the run record keeps (the files a conflict or hold names, a red tree's failing tests, the paths beyond the Touches line, a failed close's error) - writing no verdict of its own, only the `landing` stage; `landingWork(ctx)`: the scheduler's land and host ports over one `LandContext`; the lines of a requeued ticket; `createHostGit`: the mutex through which every host git write goes and which moves the run's expected base; also the landing merge, its abort and the conflict line. What it posts to the tracker as it lands (the close comment, a hold, an earlier merge closed) it asks the ledger's `describe` for

## `src/ledger.ts`

The ticket ledger: one place that turns each ending (`src/schedule.ts`) into everything a run says about its ticket.

- **`describe(ending, context)`** is pure and exhaustive over the `Ending` kinds (the type checker holds it): the ticket state the run ends on, the **outcome** (kind, `with`, text), the view's word and whether it counts as landed, and the tracker's text (a close, a hold, or the one comment on a ticket that did not land). The context is what the ending does not carry: the base, the gates' names, the agents' report, a dry run, a kept worktree, a hold note (the ticket gets that note, never a second comment), the run's stop line. The agent's hand-back through the tracker's hold label is on the pipeline's result (`handedBack`), so the ending arrives complete. `test/ledger.test.ts` holds every ending's four sayings side by side.
- **The writer** (`createLedger`) records what `describe` says as burndown's `tell` hands it each ending (`ledger.tell`): the ticket state the run ends on, the outcome and the view's word - it is the only writer of each, so neither `landOne`, the attempt nor the burndown after the schedule writes a verdict. Its `outcomes` port is `outcomesFile`, the one caller of `recordOutcomes`. `test/ledger-guard.test.ts` holds that: outside `src/ledger.ts` a run writes only progress - a phase, the landing stage, queued or blocked, a note, the pipeline's facts - spelt out in each `.ticket(...)` call, and nothing calls `recordOutcomes`. Each ending is recorded once, as it is told; a ticket the run's stop left unstarted waits for the run's last words (`close(endings, stopLine)`, after the schedule: the most severe cause, which a ticket told earlier could not know). Beside the endings, `ready` writes a green branch as it waits to land, with its outcome and what will hold it for a person at landing. Each ticket's entry is kept.
- **A requeue** is a told change the writer records: the ticket written as queued with the line its second attempt's setup carries (`requeuedAs`), before it is pushed back. A second collision's note names the tickets of both attempts (`describe`). `landOne` writes no verdict, so a requeued ticket whose second attempt never began has nothing to undo: it is recorded from the ending the scheduler makes of it (its first landing, or withdrawn - then said as not started, and its first pipeline's line dropped), its record no longer `requeued`. `test/landing-requeue.test.ts` drives the scheduler with this writer over fake ports.
- **`accountLanding(entries)`**: what the closing notification and the verify read - the merged list and the counts - from the entries.
- **`partly-done`** is a landing ending: a branch an agent said leaves an acceptance criterion undone (its `<unmet>` line, read by `unmetOf` as `ungatedOf` reads `<ungated>`; the reviewers' word replaces the implementer's once a full review ran) merges, but the ticket is neither closed nor released to its dependants, and the ledger's comment names the criterion. Its merge subject says `part of` the ticket, not `closes` it (`mergeSubject`), so `mergedEarlier` does not close it on the next run, which picks up the remainder.
- Also the words themselves: `closeComment`, `partlyDoneComment`, `notLandedComment`, `pipelineOutcome`, `refusedRecord`, `withdrawnRecord`.

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

The `Touches:` line of a ticket body: `parseTouches`, `expandTouches` against a ref's tree, and `unmergeableFiles` (lockfiles, `generated` paths, minified blobs; sizes from one cached `ls-tree` per commit), and `isTestPath` (conventional test names; a test file a branch adds is not a `Touches:` overrun, and `overrunLine` folds the modified ones into a count, "+7 test files", listing only the other paths), and `isAgentDoc` (`AGENTS.md` and `CLAUDE.md` at any depth; a change to one is not an overrun when the branch adds a file). A scheduling hint and warning source, never a guard

## `src/lint.ts`

`lintQueue()`: the queue's shape for `sandcastle queue --lint` - longest `Blocked by` chain, edges that only order overlapping `Touches:`, wide tickets, hot and shared unmergeable files, `blockerProblems` and blockers listed under a heading (which the parser does not read), a rough estimate. Read-only advice

## `src/detach.ts`

`sandcastle run --detach`, `wait` and `stop`: `startDetached` (the run as a process of its own - `spawn` with `detached: true`, output to `.sandcastle/logs/run-output.log` - and the line printed once it is going), `livePid` (the run lock's pid, if it is a process of the kit), `waitForRun` (also waits for the pid run.json names while it has no end, and the one it last saw, to die: the lock goes before the record's `exitCode` is written), `recordedExitCode`

## `src/guard.ts`

Host safety: git hooks and auto-gc off, command-running config pinned, `.git` fingerprint (config, HEAD, info, hooks; its base is the one the run expects, which the landing worker moves only by its own writes; and the tips of `agent/issue-*`, which `HostGit.begin`, `settle` and `forget` in `src/landing.ts` keep: a ticket in flight may move its branch, any other tip that moves stops the run, and a branch that vanished is restored from the bare repo `.sandcastle/backup.git`, where a pipeline's end copies it, with the base branch under `refs/base` so a fetch is thin, and a landing drops it and, with no agent branch left, runs `gc --prune=now` in the backup alone), a deleted or moved base stops with the `update-ref` that restores it, a worktree record rewritten to a container path is named, protected paths and files over 50 MB held for a person, run lock

## `src/pool.ts`

The machine pool: sandbox and gate slots shared by every run on the machine, and the lock-file helper the run lock shares (`takeLock`: pid and token, guarded takeover). A **slot** is a lock file `<pool>-<n>.lock` whose line reads `<pid> <token> run=<id> <label>`: the pid stays first because `status.sh` reads it, and `run=` names the holding run (`RUN_ID`, one per process) so `slotsByRun` can count slots per live run. A lock from a kit that named no run reads as a run of its own pid.

A freed slot goes to the **longest wait, across runs**. `withSlot` writes a wait entry (`waits/<pool>-<since>-<run>-<n>.wait`, `<pid> <run> <since> <label>`, renamed into place whole) before its first try, and takes a free slot only when no other live run has an older entry for that pool (ties go to the lower run id), then removes the entry. Without it the run that has just freed a slot asks again at once and almost always wins, and a second project's run waits until the first drains. The rule is per pool, so a run holding a sandbox slot and waiting for a gates slot cannot deadlock on it. Waits of one run are never ordered against each other here: `slotTurn` (`src/landing.ts`) still puts a landing before the run's next pipeline. A wait entry or slot whose process is gone (`holderRunning`, the run lock's rule) is ignored, a wait entry's removed when seen, a slot taken over by the next `takeLock`. A younger waiter does not take a free slot while an older one polls (every 5 s), so a freed slot can idle up to one poll. A run started by an older kit writes no entries and is not waited for.

## `src/run.ts`

Preconditions, run arguments, keep-awake, preflight, prompt rendering, agent logs (with the raw `.jsonl` sidecar), run record and history, typical times and the estimate, recorded heads, outcomes (`outcomes.json`: each entry's kind from the closed set, the tickets it collided with and its line; a reader decides on the kind, never the line, and `test/outcome-kinds.test.ts` fails on one that matches the line; `test/status-contract.test.ts` holds `status.sh`'s `outcome_state` to the kinds, both ways), log archive, status pane

The run record's `settings` group (`RunSettings` in `mod/hooks/run-record.ts`) holds the run's settings as one turn wrote them: `autonomy` (the level, resolved once per run), `turn` (this record's, 1-based), `cap` (the level's most turns: 1 for level 0, the level for 2 and 3, `DRAIN_CAP` for `drain`, and none for level 1, which asks after every turn), and `crossReview` (on or off, resolved once per run) with `crossReviewModel` and `crossReviewEffort`, written only when it is on. The row shows `● cross-review <model> <effort>` or, greyed and dropped below 80 columns, `○ cross-review`; for a record that carries `crossReview`, `status.sh` drops the `cross-review` part of the models string so the models cell holds only models, and an older record's string is shown as written. `burndown()` writes it when `cli.ts` hands it a turn, and each turn's fresh record carries its own `turn`. The status view's settings row reads only these fields (`test/status-contract.test.ts` holds that), draws nothing from a record without the group, and never fills a field the record lacks. Idle, `sandcastle status` resolves the next run's settings with the same resolver and passes the group as `SANDCASTLE_SETTINGS` (`{}` when they cannot be resolved), marked `(next run)`; a bare `status.sh` falls back to the last run's record, marked `(last run)`. `status.sh`'s `settings_row` is a list of items, each with its text, a shorter text below 100 columns and the narrowest pane it stays in, so a later setting is one `set_item` call.

## `src/run-settings.ts`

The run settings (CONTEXT.md): `resolveSettings({ env, project, machine })`, the one pure resolver of what a run is told at its start - for now the autonomy level and cross-review (`crossReviewSetting` in `src/agents.ts`: `CROSS_REVIEW=1`, `CROSS_REVIEW_MODEL`, `CROSS_REVIEW_EFFORT`, the same reading `agents.ts` itself uses), with the unchanged precedence of environment over project config over default - and `settingsGroup`, the group a turn's run record carries. `sandcastle run` and `sandcastle status` both call it, so they cannot disagree about the next run; a later setting adds a field here. `test/run-settings.test.ts` and `test/run-settings-cross-review.test.ts` hold it

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

The optional Claude Code mod, a plugin linked as `~/.claude/skills/sandcastle-mod`: `hooks/register.tsx` (the hooks: watch `run.json`, the band above the prompt, the needs-you line and notice, the prompt when the run's process is gone, `/sandcastle-status`), `hooks/run-live.ts` (pure, imports nothing: the one rule for "is this run live" - a run is live when its record has not finished and its pid is a process whose command line contains `RUN_COMMAND`; `liveness` answers `live`, `finished` (with its exit code), `own` (the asking process itself, which is not "another live run") or `dead` from the record, the run lock's pid and an injected process check, and EPERM is the check's business: a process that exists is read like any other. `src/report.ts`, `src/herdr-plugin.ts` and `src/detach.ts` pass `commandOf` from `src/live-runs.ts`; the mod passes `ps`; `status.sh` keeps a bash `run_alive` of the same rule, which `test/run-live-contract.test.ts` holds to it. The mod alone ignores `finishedAt`, since every turn of one run writes one and the run goes on; the run lock and the machine-wide slot locks in `src/pool.ts` judge their owner by the same command-line check (`holderRunning`), with one difference: when `ps` cannot answer for a pid that exists, the lock is kept, since a live run misread as gone would let a second one take its project; `status.sh`'s `slot_alive` follows it), `hooks/run-record.ts` (pure, imports nothing: the run record and ticket record types, the closed list of ticket states, the derived states, the tables from ticket state to group and word, and the closed list of outcome kinds; the kit's own `src/` imports it too, so every write is typed by it, `readTickets` passes each state read from disk through the guard, and `readOutcomes` (`src/run.ts`) each outcome kind through `isOutcomeKind`), and `hooks/run-state.ts` (pure: the record read as groups, glyphs and colours, the palette and castle, and the band cut to its width - `test/mod.test.ts` holds both to `src/run.ts` and `status.sh`). It runs inside Claude Code, not under `tsx`, and imports nothing from `src/`. Its own tests are `mod/tests/`, run by `claude plugin test mod`

Verifying a change to it needs Claude Code 2.1.287 or newer on PATH: `pnpm test` then runs `claude plugin validate` and the mod's own tests (`test/mod.test.ts`), and skips them without it, as CI and the sandboxes do. That checks the hooks and the tree they return, never the paint: look at a changed drawing in a real session, `claude --plugin-dir mod` from a project with a run record. The mod's API is early access, and its types are the authority, not memory. That session writes them to `mod/.claude-plugin/types/` with a `mod/tsconfig.json` (both gitignored; they are absent until then, and `mod/types/index.d.ts` holds only the band's own types); from then on `pnpm test` type-checks the mod too, which the kit's own `tsc` does not cover. Grep the types for the member you need rather than reading them: they run to thousands of lines. `claude plugin test mod` reporting "hooks modules are turned off" is Claude Code's rollout switch, not the mod.

## `site/`

The project website on GitHub Pages: static HTML, CSS and plain scripts (not modules, so it also opens from disk), no build step. `js/status.js` ports the status view's grid to play a made-up run; `js/sand.js` draws the castle, dunes and grains. `.github/workflows/pages.yml` deploys it
