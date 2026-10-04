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
- At runtime the kit writes only to the project's `.sandcastle/` (gitignored there), a temp
  directory, or its machine-wide live-runs directory (`src/live-runs.ts`) - its own directory
  stays read-only.
- The pre-commit hook (`git config core.hooksPath .githooks`) runs gitleaks and the user's
  denylist. Every commit goes through it; a finding is fixed, not bypassed with `--no-verify`.

## Layout

One line per path. What the larger modules own, and the rules each keeps (the scheduler's
requeue-once rule, the file hold, landing, the guard's fingerprint), is in `docs/architecture.md`:
read a module's section there before changing it.

| Path | What |
|---|---|
| `bin/sandcastle` | Shell entry: runs `src/cli.ts` with the kit's own tsx loader; `sandcastle herdr ...` runs `src/herdr-plugin.ts` alone |
| `src/cli.ts` | Every command (`sandcastle help` lists them) and the autonomy loop around `burndown()`; the help text is the file's header comment (read by `src/help.ts`), held by `test/help.test.ts` and `test/command-help*.test.ts` |
| `src/help.ts` | The help text (the header comment of `src/cli.ts`), `helpFor(command)` and `wantsHelp`: a `--help` or `-h` anywhere in a command's arguments prints its help before anything runs; the Herdr plugin's entry shares it |
| `src/init.ts` | `sandcastle init`: stack detection, config and Dockerfile scaffolding |
| `src/land.ts` | Landing one branch in a sandbox: merge, regenerate generated files, gate, fast-forward the base; `sandcastle land` |
| `src/preview.ts` | Landing preview: `git merge-tree` of each unlanded branch in the project image, nothing written to the repo |
| `src/burndown.ts` | The orchestrator: base gates, then every attempt and landing through `createSchedule`, then verify and report; one ticket's pipeline (`createPipeline`, over ports a test fakes), the file hold's inputs, re-runs of carried branches, timings |
| `src/landing.ts` | Landing one green branch (`landOne`, which returns facts and writes no verdict), the scheduler's land and host ports, and `createHostGit`, the mutex every host git write goes through |
| `src/ledger.ts` | The ticket ledger: `describe(ending)`, pure and exhaustive - the ticket state, outcome, view word and tracker text of every ending - and the writer that records it, and each requeue, as the scheduler tells them |
| `src/resolution.ts` | `strayChanges`: a conflict resolution checked against git's own automatic merge, so a resolution that dropped another ticket's lines is held |
| `src/schedule.ts` | `createSchedule(plan)`: the run's one path for attempts and landings - the requeue-once rule, the release of dependants, the file hold, the run's demand for slots, and `createQueue` |
| `src/report.ts` | The closing summary (`sandcastle report`, and the end of every run): gather facts from run.json, git and the tracker; render the seven sections |
| `src/autonomy.ts` | Autonomy levels: how many turns one `sandcastle run` may make, which tickets are re-runnable, and the level-1 question |
| `src/run-settings.ts` | The run settings: `resolveSettings` (environment, project config and machine settings in, the settings out: the autonomy level, repair attempts and concurrency, asked and effective) and `settingsGroup`, the group each turn's run record carries and the status view's settings row shows |
| `src/size.ts` | `sandcastle size`: recommends the pool's `maxSandboxes` and `maxGates` from the runtime's VM (`docker info`) and the measured sandbox peaks (`measuredPeak`), through injectable `Readers`; read-only, the assumed figures are constants at its top |
| `src/peaks.ts` | Sandbox peak memory: `memory.peak` read inside the container (`samplePeak`, `recordPeak`), and the machine-wide `peaks.jsonl` (`readPeaks`) that `size` reads |
| `src/usage.ts` | Opt-in plan usage guard (`USAGE_CHECK=1`); `usageToken` picks its credential, only when the sandboxes spend `CLAUDE_CODE_OAUTH_TOKEN`: the host's Claude Code login, read-only, else that token |
| `src/notify.ts` | End-of-run notify command from the personal config.json |
| `src/upgrading.ts` | Unacted **Upgrading** notes against the project's update record (`.sandcastle/.run/kit-updated`), and `kitVersion` |
| `src/herdr.ts` | Herdr helpers and the run's view: the tab, panes, agent-state reports, sidebar tokens |
| `src/live-runs.ts` | The machine-wide live-runs directory (`RUNS_DIR`, under `KIT_CACHE`) that the Herdr tab bar and the Claude Code mod read |
| `src/herdr-plugin.ts` | `sandcastle herdr`: `configure` (link the plugin, add or remove the config block), and the plugin's own verbs - the tab bar line, popups, Ctrl-click logs, the Agents view |
| `herdr/` | The Herdr plugin: `herdr-plugin.toml` (its `version` follows each release; a test checks) and `entry.sh`, through which every action, pane and hook runs |
| `src/tracker.ts` | The `Tracker` interface and its adapters: GitHub Issues, and Markdown ticket files. Which one a project uses, and its triage label names (`detectFromDocs`) |
| `src/blockers.ts` | What holds a ticket back: `Blocked by` refs (GitHub, Linear, ticket files), `openBlockersNow`, `blockedNote` |
| `src/touches.ts` | The `Touches:` line of a ticket body, and `unmergeableFiles`; a scheduling hint, never a guard |
| `src/lint.ts` | `lintQueue()`: the queue's shape for `sandcastle queue --lint`; read-only advice |
| `src/agents.ts` | Models, effort, review fallback, Codex cross-review |
| `src/sandbox.ts` | Credentials (and token policy), images (hash tags, pruning), sandbox mounts and hooks; `KIT`, the kit's own directory |
| `src/gates.ts` | Gate runs, and the green-base check before any agent starts (`sandcastle gates`) |
| `src/lean.ts` | Lean inventory and plan, per-worktree strip, hook check, token measurement |
| `src/detach.ts` | `sandcastle run --detach` (output to `.sandcastle/logs/run-output.log`), `wait` and `stop` |
| `src/guard.ts` | Host safety: git hooks and auto-gc off, the `.git` fingerprint and branch-tip backup (`.sandcastle/backup.git`), protected paths, the run lock |
| `src/pool.ts` | Machine-wide sandbox and gate slots (a freed slot goes to the longest wait across runs; a slot names its run; live runs register and split the sandbox slots by share, up to each run's demand), and the lock-file helper the run lock shares (pid and token, guarded takeover) |
| `src/run.ts` | Preconditions, prompt rendering, agent logs, the run record (`.sandcastle/logs/run.json`) and history, the estimate, the status pane |
| `src/worktree-lock.ts` | Worktree locks against `git worktree prune`; time-bounded gates, run without the kit's tokens and with their values redacted from the output |
| `src/setup.ts` | Interactive install: links, credentials file, then doctor |
| `src/doctor.ts` | Setup self-check; the single source of truth for what a working install needs |
| `src/errors.ts` | `OperatorError`: a refusal the operator acts on; `cli.ts` prints its message with no stack trace and exits 1, any other error keeps its stack |
| `src/generated.ts` | Generated files: `covers`, `regensFor`, and `resolveGenerated` (take a side, rerun setup and `regen` in the sandbox, commit); also the shell quoting and host git identity the base merge uses |
| `src/config.ts` | The `ProjectConfig` type, loader and validation; `pnpmStore`'s run-time mount and setup step |
| `src/versions.ts` | Which Claude Code and Codex versions the image gets, resolved on the host and part of the image tag |
| `prompts/` | Implement, review, repair and resolve templates; the kit fills `{{KIT_*}}`, Sandcastle the rest |
| `container/` | Mounted read-only at `/etc/claude-code` in every sandbox: managed settings and `git-guard.sh`, the hook that refuses damage to the shared `.git` |
| `docker/base.Dockerfile` | The shared base image. Its entrypoint is `sleep infinity`: a debugging `docker run` needs `--entrypoint bash` |
| `status.sh` | Status view; bash 3.2-safe, macOS and Linux, and no extglob in a per-cell helper (3.2 makes it slow). A live run's tickets come from `run.json`'s `tickets`, never inferred |
| `test/fixtures.ts` | `fakeTracker(overrides?)`: a project's `tracker` from `resolveTracker`'s own defaults. A test builds its `tracker` with it, never a full literal (`test/fixtures.test.ts` holds that); import it after `XDG_CONFIG_HOME` is set, like `src/` |
| `test/cli-spawn.ts` | `runKit`, `runNode`, `startKit`, `startNode`: how a test starts the kit as a child process - `process.execPath`, the launcher's V8 flags read from `bin/sandcastle` (the Node 24 exit deadlock, #164) and a time limit that fails the test with the command named; `test/cli-spawn.test.ts` refuses a test file that names a tsx entry itself |
| `test/shard.ts` | CI's shards: the test files of `TEST_SHARD=i/n`, packed by measured weight (`pnpm test:shard`); a file it has no weight for still runs |
| `test/status.test.sh` | The status view against a made-up repo and run records |
| `test/*.test.ts` | One file per behaviour, named after it (`ls test/` first: a test file a ticket names may not exist). The `skill*` tests read the skill files and this table's `skill/` row |
| `skill/` | The sandcastle agent skill, shared by Claude Code, Codex and OpenCode: SKILL.md (the router, loaded for every action) and one file per action: init.md, audit.md, queue.md (with the ticket-body rules audit.md shares), run.md (start to closing summary, models and effort), status.md and update.md. Before editing it, read its portability rules in `docs/architecture.md` |
| `mod/` | The optional Claude Code mod: `hooks/register.tsx` (the hooks), `hooks/run-record.ts` (the run record's types, imported by `src/` too), `hooks/run-live.ts` (the one "is this run live" rule, imported by `src/` too), `hooks/run-state.ts` (the drawing). Runs inside Claude Code, imports nothing from `src/` |
| `templates/` | What `sandcastle init` copies into a project |
| `examples/` | Invented example project configs |
| `docs/INSTALL.md` | Requirements, what `setup` does, the manual install, updating |
| `docs/img/` | The README's pictures. GitHub plays no SVG animation in a README, so the moving ones are GIFs, rebuilt by `record-gifs.sh` there; the castle's colours are the status view's |
| `docs/releasing.md` | Version bumps, the tag and the release notes' shape |
| `test/full-check.sh` | Every check below on this machine, then in a Linux container, then the outbound scan of the commits not yet on `origin/main` |
| `site/` | The project website on GitHub Pages: static HTML, CSS and plain scripts, no build step |
| `CHANGELOG.md` | Keep a Changelog; each release's **Upgrading** notes are what `/sandcastle update` acts on |

`@ai-hero/sandcastle` is a dependency, not vendored. Its behaviour is in
`node_modules/@ai-hero/sandcastle/dist` - read the source there when unsure.

## Verifying a change

A change is ready to commit when `README.md`, `skill/` and `docs/` no longer describe the old
behaviour (grep them for its words, not only for the function's name), and all of these pass:

```bash
pnpm exec tsc --noEmit
pnpm test            # every test/ file against fixtures and temp repos (no Docker, no model calls),
                     # with `bash -n` on every tracked shell script
./bin/sandcastle doctor
# from inside a test project (no model calls), giving the path to this checkout's bin/sandcastle:
/path/to/this/checkout/bin/sandcastle status 0
/path/to/this/checkout/bin/sandcastle lean
```

Write `./bin/sandcastle`, not a bare `sandcastle`: from a clone or a worktree, the one on PATH is the
installed kit, so those checks would never exercise the change (doctor notes this, it does not fail).

A change to `mod/` has checks of its own, which `pnpm test` skips without a recent Claude Code:
read the `mod/` section of `docs/architecture.md`.

Before a branch's work is pushed, `bash test/full-check.sh` repeats the checks on this machine and
in Linux (agents' sandboxes are Linux, so BSD tools and macOS's bash 3.2 break only here), and
scans the new commits for secrets, the denylist and home-directory paths.

`sandcastle run`, `preflight` and `lean --measure` spend the user's model allowance; ask first.
Test a guard (git hooks, protected paths, fingerprint) in a throwaway clone under a temp
directory, never in a real project.

## Conventions

- TypeScript run by `tsx`, ESM, `.ts` import extensions, strict mode. No build step.
- A test that reads a function out of `status.sh` uses `eval "$(sed ...)"`, never `source <(sed ...)`:
  macOS CI's bash is 3.2, which cannot source a process substitution (`test/bash32-source.test.ts` holds it).
- Comments explain *why* - the failure a line prevents - not what the code does.
- Every file write outside a temp dir targets the project root. Every shell call passes arguments
  as an array; an interpolated string is only for a script run inside the container.
- British English in prose; hyphens with spaces ( - ) rather than em dashes.
- Commit messages: `type: subject` (Conventional Commits), imperative, body says why.
- A change made by hand goes on a `feature/`, `fix/`, `docs/` or `refactor/` branch cut from
  `origin/main`, and reaches main through a pull request the maintainer merges. A run's own
  landings and the release commit are the exceptions.
- Every user-facing change gets a `CHANGELOG.md` line under `[Unreleased]`. One an existing
  project may need to act on - a new default that changes what a run does or spends, a new
  convention, anything `sandcastle init` now writes differently - also gets an **Upgrading**
  note, and if a project needs a check or a fix, a step in the skill's `update` action (`skill/update.md`). Write
  that step as a check that is safe to repeat, never as "since version X".

## Releases

Releasing - a version bump, a tag, release notes - follows `docs/releasing.md`: read it first.

## Agent skills

### Issue tracker

This repository's own work is tracked in GitHub Issues (`gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Matt Pocock's five default role names, unchanged (the kit reads this file too). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the root, created when a term or decision settles. See `docs/agents/domain.md`.
