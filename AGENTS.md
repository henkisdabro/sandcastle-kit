# sandcastle-kit - instructions for coding agents

Two kinds of task happen in this repository. Decide which one you are doing first.

1. **Using the kit** (install it, set up a project, triage, run): follow `README.md` -> "If you
   are an AI coding agent reading this", starting with `sandcastle doctor`. You will mostly work
   in the user's *project*, not here.
2. **Changing the kit** (fix a bug, add a feature): read on.

## This repository is public

It is published on GitHub and used daily on the maintainer's machine, so everything committed
here is **generic**: no names, emails, tokens, private repo or client names, private ticket
numbers or home-directory paths. Write a lesson as a pattern ("a review caught a money-handling
bug no gate would fail"), never as an incident from a named project.

- Personal things live in `~/.config/sandcastle-kit/` (`.env`, `config.json`, `denylist`);
  project things live in each project's `.sandcastle/`. A user's preference ("always keep skill
  X") belongs in their memory or project config, not in `skill/` or the README.
- At runtime the kit writes only to the project's `.sandcastle/` (gitignored there) or a temp
  directory - its own directory stays read-only.
- The pre-commit hook (`git config core.hooksPath .githooks`) runs gitleaks and the user's
  denylist. Every commit goes through it; a finding is fixed, not bypassed with `--no-verify`.

## Layout

| Path | What |
|---|---|
| `bin/sandcastle` | Shell entry; resolves symlinks, checks the temp directory can be written, runs `src/cli.ts` in one node process with the kit's own tsx loader (not the tsx binary, whose child is SIGKILLed on a slow answer to SIGTERM); `sandcastle herdr ...` runs `src/herdr-plugin.ts` alone, as Herdr's tab bar calls it every 10 seconds |
| `src/cli.ts` | Commands: help, setup, doctor, init, updated, build, gates, land, preview, lean, lean-apply (internal hook), preflight, queue, requeue, blockers, run (`--detach`), wait, stop, report, status, clean, herdr; also the autonomy loop around `burndown()` |
| `src/init.ts` | `sandcastle init`: stack detection, config and Dockerfile scaffolding |
| `src/land.ts` | Landing one branch in a sandbox: merge, regenerate generated files, gate, fast-forward the base; `sandcastle land` |
| `src/preview.ts` | Landing preview: `git merge-tree` of each unlanded branch in the project image, nothing written to the repo |
| `src/burndown.ts` | The orchestrator: base gates, then every attempt and landing through `createSchedule(plan).run(work)` (the attempt port: implement, review, gate with repair; the land port: merge or squash, on the landing worker as each ticket goes green), then verify and report; it records what the scheduler tells and builds the Landings lists and outcome lines from the endings; dependencies, the file hold (`ticketFiles`: one ticket at a time per file git cannot merge), re-runs of carried branches (land-only, narrow review), timings |
| `src/landing.ts` | `landOne(ctx, outcome)`: landing one green branch (tracker check, moved head, held paths, then a merge as it is when the branch holds the base's tip, otherwise a merge gated in a sandbox, close) and what it returns; `landingWork(ctx)`: the scheduler's land and host ports over one `LandContext`; `accountLanding`, `landingLines` and the record helpers the burndown turns endings into; `createSettling`: the hand wiring of a landing's `settled` and `stopped` and of a ticket sent back that `test/landing-requeue.test.ts` still copies; `createFlow`: sends a ticket that conflicts or goes red at landing back to the pipeline queue once, takes a dependant a landing released (`start`), and closes the queues when every ticket has its ending (the scheduler runs it); `createHostGit`: the mutex through which every host git write goes and which moves the run's expected base; also the landing merge, its abort, the close comment and the conflict line |
| `src/resolution.ts` | `strayChanges`: compares a conflict resolution with git's own automatic merge (`git merge-tree --write-tree`, git 2.38 or newer) and names the changed paths that merged cleanly, so the land-only path holds the ticket instead of reviewing a resolution that dropped another ticket's lines |
| `src/schedule.ts` | `createSchedule(plan)`: the run's one path for attempts and landings - `start` (the candidates in start order) and `run(work)` with the ports `attempt` (with `last()`, true once nothing more will start), `land`, `host` and `tell`, resolving to each ticket's typed **ending** and the run's stop state; `createStopState`: the stop state, whose `add` only the scheduler holds; `createLanding`: the one worker that lands each green ticket, a carried branch first. `createQueue<T>(rank?)`: the work queue of the pipeline fan-out and of the landing worker (`push`, `close`, `run(workers, fn)`); workers wait while it is open and empty, so an item can be pushed mid-run; a higher `rank` goes first, equals in arrival order. `createFileHold`: which tickets may start - a ticket sharing a file git cannot merge with one in flight is parked until that one lands or leaves the run (`admit`, `end`); mergeable shares are only named; a ticket in flight has its branch's files read again before each comparison (`refresh`), and `stop` settles the parked tickets of a run that is ending without starting any. `startHold`: the start of the run's hold - parked tickets, `waiting`, candidates, `order` and label checks - which `burndown()` and `test/overlap.test.ts` both call |
| `src/report.ts` | The closing summary (`sandcastle report`, and the end of every run): gather facts from run.json, git and the tracker; render the seven sections |
| `src/autonomy.ts` | Autonomy levels: how many turns one `sandcastle run` may make, which tickets are re-runnable, and the level-1 question |
| `src/usage.ts` | Opt-in plan usage guard (`USAGE_CHECK=1`) |
| `src/notify.ts` | End-of-run notify command from the personal config.json |
| `src/upgrading.ts` | Whether a pulled kit has **Upgrading** notes a project has not had: the kit commit the project was last updated to (`.sandcastle/.run/kit-updated`, written by `sandcastle updated` and `init`), the changelog's notes there against the kit's own, and the lines doctor and a run print |
| `src/herdr.ts` | Herdr helpers and the run's view: the tab (adopted only from a terminal), per-sandbox panes only with `herdr.panes: "all"` (otherwise the run is one agent on the status pane), agent-state reports, sidebar tokens, the workspace's run summary |
| `src/live-runs.ts` | The machine-wide live-runs directory (`RUNS_DIR`, `XDG_CACHE_HOME` or `~/.cache`, on Linux and macOS alike): `registerRun` writes a run's file (named by the resolved root) from `burndown()`, Herdr or not, and removes it at exit. The Herdr tab bar (`liveRuns` in `src/herdr-plugin.ts`) and the Claude Code mod (`REGISTRY_SCRIPT` in `mod/hooks/run-state.ts`) read it; the mod follows a run whose recorded `session` (`CLAUDE_CODE_SESSION_ID`) is its own |
| `src/herdr-plugin.ts` | `sandcastle herdr`: `configure` (link the plugin, add or remove the config block), and the plugin's own verbs - the tab bar line, popups, Ctrl-click logs, the Agents view |
| `herdr/` | The Herdr plugin: `herdr-plugin.toml` (its `version` follows each release; a test checks) and `entry.sh`, through which every action, pane and hook runs |
| `src/tracker.ts` | The `Tracker` interface and its adapters: GitHub Issues, and Markdown ticket files (Matt Pocock's "Local Markdown" layout). Which one a project uses: config, then `docs/agents/`, then GitHub |
| `src/blockers.ts` | What holds a ticket back: `Blocked by` refs (GitHub, Linear, ticket files), and comments a run would ignore; `createDependants` and `createRelease`: the tickets held for a blocker in the same run, re-read after each landing closes its ticket, and started when none is open |
| `src/touches.ts` | The `Touches:` line of a ticket body: `parseTouches`, `expandTouches` against a ref's tree, and `unmergeableFiles` (lockfiles, `generated` paths, minified blobs; sizes from one cached `ls-tree` per commit). A scheduling hint and warning source, never a guard |
| `src/lint.ts` | `lintQueue()`: the queue's shape for `sandcastle queue --lint` - longest `Blocked by` chain, edges that only order overlapping `Touches:`, wide tickets, hot and shared unmergeable files, `blockerProblems`, a rough turn count. Read-only advice |
| `src/agents.ts` | Models, effort, review fallback, Codex cross-review |
| `src/sandbox.ts` | Credentials (and token policy), images (hash tags, pruning), sandbox mounts and hooks |
| `src/gates.ts` | Gate runs, and the green-base check before any agent starts (`sandcastle gates`) |
| `src/lean.ts` | Lean inventory and plan, per-worktree strip, hook check, token measurement |
| `src/detach.ts` | `sandcastle run --detach`, `wait` and `stop`: `startDetached` (the run as a process of its own - `spawn` with `detached: true`, output to `.sandcastle/logs/run-output.log` - and the line printed once it is going), `livePid` (the run lock's pid, if alive), `waitForRun` (also waits for that pid to die: the lock goes before the record's `exitCode` is written), `recordedExitCode` |
| `src/guard.ts` | Host safety: git hooks and auto-gc off, command-running config pinned, `.git` fingerprint (config, HEAD, info, hooks; its base is the one the run expects, which the landing worker moves only by its own writes; and the tips of `agent/issue-*`, which `HostGit.begin`, `settle` and `forget` in `src/landing.ts` keep: a ticket in flight may move its branch, any other tip that moves stops the run, and a branch that vanished is restored from the bare repo `.sandcastle/backup.git`, where a pipeline's end copies it and a landing drops it), a deleted or moved base stops with the `update-ref` that restores it, a worktree record rewritten to a container path is named, protected paths and files over 50 MB held for a person, run lock |
| `src/pool.ts` | Machine-wide sandbox and gate slots, and the lock-file helper the run lock shares (pid and token, guarded takeover) |
| `src/run.ts` | Preconditions, run arguments, keep-awake, preflight, prompt rendering, agent logs (with the raw `.jsonl` sidecar), run record and history, typical times and the estimate, recorded heads, log archive, status pane |
| `src/worktree-lock.ts` | Worktree locks against `git worktree prune`; time-bounded gates, run without the kit's tokens and with their values redacted from the output |
| `src/setup.ts` | Interactive install: links, credentials file, then doctor |
| `src/doctor.ts` | Setup self-check; the single source of truth for what a working install needs |
| `src/errors.ts` | `OperatorError`: a refusal the operator acts on; `cli.ts` prints its message with no stack trace and exits 1, any other error keeps its stack |
| `src/generated.ts` | Generated files: `covers`, `regensFor`, and `resolveGenerated` (take a side, rerun setup and `regen` in the sandbox, commit); also the shell quoting and host git identity the base merge uses |
| `src/config.ts` | The `ProjectConfig` type, loader and validation |
| `src/versions.ts` | Which Claude Code and Codex the image gets: Claude Code's `stable` channel by default (`claudeCode` or `CLAUDE_CODE_VERSION` picks `latest` or an exact version), Codex's npm `latest` tag (or `CODEX_VERSION`), resolved on the host, cached six hours, with the Dockerfile's defaults as the offline fallback; the versions are part of the image tag |
| `prompts/` | Implement, review, repair and resolve (a re-run's conflicted base merge) templates. The kit fills `{{KIT_*}}`; Sandcastle fills `{{ISSUE_NUMBER}}`, `{{TICKET}}`, `{{SOURCE_BRANCH}}`, `{{TARGET_BRANCH}}` and `` !`cmd` `` |
| `container/` | Mounted read-only at `/etc/claude-code` in every sandbox (`sandboxMounts` in `src/sandbox.ts`): `managed-settings.json` registers `git-guard.sh`, a `PreToolUse` hook on the Bash, Write and Edit tools that refuses commands and writes that damage the shared `.git` (`test/git-guard.test.ts`). Managed settings sit above project settings, so a branch cannot disable it. Needs bash and `jq` in the image |
| `docker/base.Dockerfile` | The shared base image; its Claude Code and Codex `ARG` versions are offline defaults, the kit passes the resolved ones |
| `status.sh` | Status view; bash 3.2-safe, macOS and Linux, and no extglob in a per-cell helper (3.2 makes it slow). A live run's tickets come from `run.json`'s `tickets`, never inferred |
| `test/status.test.sh` | The status view against a made-up repo and run records |
| `test/*.test.ts` | One file per behaviour, named after it (`land-command`, `autonomy`, `report`, `guard`, `skill-split` ...), against temp repos, made-up records and fake sandboxes. Some read the docs: the `skill*` tests check SKILL.md's frontmatter and sections, run.md's seven headings against `src/report.ts`, update.md's step references and this table's `skill/` row |
| `skill/` | The sandcastle agent skill, shared by Claude Code, Codex and OpenCode: SKILL.md (the router and every short action), run.md (closing a run), update.md (the update action) and audit.md (the audit action) |
| `mod/` | The optional Claude Code mod, a plugin linked as `~/.claude/skills/sandcastle-mod`: `hooks/register.tsx` (the hooks: watch `run.json`, the band above the prompt, the needs-you line and notice, the prompt when the run's process is gone, `/sandcastle-status`), `hooks/run-record.ts` (pure, imports nothing: the run record and ticket record types, the closed list of ticket states, the derived states, and the tables from ticket state to group and word; the kit's own `src/` imports it too, so every write is typed by it, and `readTickets` passes each state read from disk through the guard), and `hooks/run-state.ts` (pure: the record read as groups, glyphs and colours, the palette and castle, and the band cut to its width - `test/mod.test.ts` holds both to `src/run.ts` and `status.sh`). It runs inside Claude Code, not under `tsx`, and imports nothing from `src/`. Its own tests are `mod/tests/`, run by `claude plugin test mod` |
| `templates/` | What `sandcastle init` copies into a project |
| `examples/` | Invented example project configs |
| `docs/INSTALL.md` | Requirements, what `setup` does, the manual install, updating |
| `site/` | The project website on GitHub Pages: static HTML, CSS and plain scripts (not modules, so it also opens from disk), no build step. `js/status.js` ports the status view's grid to play a made-up run; `js/sand.js` draws the castle, dunes and grains. `.github/workflows/pages.yml` deploys it |
| `CHANGELOG.md` | Keep a Changelog; each release's **Upgrading** notes are what `/sandcastle update` acts on |

`@ai-hero/sandcastle` is a dependency, not vendored. Its behaviour is in
`node_modules/@ai-hero/sandcastle/dist` - read the source there when unsure.

## The skill serves three harnesses

The `skill/` directory (not the file - `src/setup.ts` links the directory) is symlinked into
`~/.claude/skills/sandcastle` (Claude Code, also scanned by OpenCode) and
`~/.agents/skills/sandcastle` (Codex). `SKILL.md` works in all three because each ignores
frontmatter it does not know. Keep it portable:

- `name` stays `sandcastle`, matching the directory the user links it as.
- `description` stays under 1,024 characters (OpenCode rejects longer) and carries every trigger:
  Codex and OpenCode never see Claude Code's `when_to_use`.
- `argument-hint` and `arguments: [action]` are Claude Code's; the body handles an unfilled
  `$action` for the other two.
- Name harness-specific tools by what they do, with the Claude Code name as an example
  ("the harness's question tool (`AskUserQuestion` in Claude Code)").
- `SKILL.md` loads whole for every action, so a long section that only one action needs lives in a
  sibling file that `SKILL.md` names in prose ("read run.md in this skill's directory") - Codex and
  OpenCode do not fill `$action`, so they find the file from the text.

## Verifying a change

A change is ready to commit when all of these pass:

```bash
pnpm exec tsc --noEmit
bash -n status.sh bin/sandcastle .githooks/pre-commit container/git-guard.sh
pnpm test            # every test/ file against fixtures and temp repos (no Docker, no model calls)
sandcastle doctor
# from inside a test project (no model calls):
sandcastle status 0
sandcastle lean
```

A change to `mod/` also needs Claude Code 2.1.287 or newer on PATH: `pnpm test` then runs
`claude plugin validate` and the mod's own tests (`test/mod.test.ts`), and skips them without it,
as CI and the sandboxes do. That checks the hooks and the tree they return, never the paint: look
at a changed drawing in a real session, `claude --plugin-dir mod` from a project with a run
record. The mod's API is early access - the `.d.ts` that session writes under
`mod/.claude-plugin/types/` is the authority, not memory.

`sandcastle run`, `preflight` and `lean --measure` spend the user's model allowance; ask first.
Test a guard (git hooks, protected paths, fingerprint) in a throwaway clone under a temp
directory, never in a real project.

## Conventions

- TypeScript run by `tsx`, ESM, `.ts` import extensions, strict mode. No build step.
- Comments explain *why* - the failure a line prevents - not what the code does.
- Every file write outside a temp dir targets the project root. Every shell call passes arguments
  as an array; an interpolated string is only for a script run inside the container.
- British English in prose; hyphens with spaces ( - ) rather than em dashes.
- Commit messages: `type: subject` (Conventional Commits), imperative, body says why.
- Every user-facing change gets a `CHANGELOG.md` line under `[Unreleased]`. One an existing
  project may need to act on - a new default that changes what a run does or spends, a new
  convention, anything `sandcastle init` now writes differently - also gets an **Upgrading**
  note, and if a project needs a check or a fix, a step in the skill's `update` action (`skill/update.md`). Write
  that step as a check that is safe to repeat, never as "since version X".

## GitHub releases

The release notes are a short, emoji-led summary, never the changelog pasted in. Copy the shape of
the latest release (`gh release view`) and keep it:

- Title: `🏰 sandcastle-kit vX.Y.Z - <tagline>`, a short lowercase phrase saying what the release
  is about.
- Body opens with `## 🏰 vX.Y.Z - <tagline>`, then one bold sentence and a short paragraph on
  where the release came from.
- Then `### ✨ New`, `### 🐛 Fixed` (a `### 🔒 Security` section before it when there is any),
  `### ⬆️ Upgrading` (starting with `/sandcastle update`), `### 🙏 Built on Sandcastle` (the
  thanks to Matt Pocock), and `**Full diff:**` with the compare link.
- Each bullet starts with an emoji and a bold or short lead, then a dash and one line. Pick the
  handful of changes a user notices, and end Fixed and Upgrading with a link to the changelog's
  version anchor for the rest.

## Agent skills

### Issue tracker

This repository's own work is tracked in GitHub Issues (`gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Matt Pocock's five default role names, unchanged (the kit reads this file too). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the root, created when a term or decision settles. See `docs/agents/domain.md`.
