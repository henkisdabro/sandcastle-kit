# sandcastle-kit - instructions for coding agents

Two kinds of task happen in this repository. Decide which one you are doing first.

1. **Using the kit** (install it, set up a project, triage, run): follow `README.md` -> "If you
   are an AI coding agent reading this", starting with `sandcastle doctor`. You will mostly work
   in the user's *project*, not here.
2. **Changing the kit** (fix a bug, add a feature): read on.

## This repository is public

It is published on GitHub and used daily on the maintainer's machine, so everything committed
here is **generic**: no names, emails, tokens, private repo or client names, private issue
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
| `bin/sandcastle` | Shell entry; resolves symlinks, runs `src/cli.ts` with the kit's own `tsx` |
| `src/cli.ts` | Commands: setup, doctor, init, build, gates, land, preview, lean, lean-apply (internal hook), preflight, queue, requeue, blockers, run, report, status, clean |
| `src/init.ts` | `sandcastle init`: stack detection, config and Dockerfile scaffolding |
| `src/land.ts` | Landing one branch in a sandbox: merge, regenerate generated files, gate, fast-forward the base; `sandcastle land` |
| `src/preview.ts` | Landing preview: `git merge-tree` of each unlanded branch in the project image, nothing written to the repo |
| `src/burndown.ts` | The orchestrator: base gates, fan out, implement, review, gate (with repair), land, verify, report; dependencies, timings |
| `src/report.ts` | The closing summary (`sandcastle report`, and the end of every run): gather facts from run.json, git and the tracker; render the seven sections |
| `src/autonomy.ts` | Autonomy levels: how many turns one `sandcastle run` may make, which tickets are re-runnable, and the level-1 question |
| `src/usage.ts` | Opt-in plan usage guard (`USAGE_CHECK=1`) |
| `src/notify.ts` | End-of-run notify command from the personal config.json |
| `src/herdr.ts` | Herdr helpers and the per-sandbox view (panes, agent-state reports) |
| `src/tracker.ts` | The `Tracker` interface and its adapters: GitHub Issues, and Markdown ticket files (Matt Pocock's "Local Markdown" layout). Which one a project uses: config, then `docs/agents/`, then GitHub |
| `src/blockers.ts` | What holds a ticket back: `Blocked by` refs (GitHub, Linear, ticket files), and comments a run would ignore |
| `src/agents.ts` | Models, effort, review fallback, Codex cross-review |
| `src/sandbox.ts` | Credentials (and token policy), images (hash tags, pruning), sandbox mounts and hooks |
| `src/gates.ts` | Gate runs, and the green-base check before any agent starts (`sandcastle gates`) |
| `src/lean.ts` | Lean inventory and plan, per-worktree strip, hook check, token measurement |
| `src/guard.ts` | Host safety: git hooks off, `.git` fingerprint, protected paths, run lock |
| `src/pool.ts` | Machine-wide sandbox and gate slots, and the lock-file helper the run lock shares (pid and token, guarded takeover) |
| `src/run.ts` | Preconditions, preflight, prompt rendering, run record, log archive, status pane |
| `src/worktree-lock.ts` | Worktree locks against `git worktree prune`; time-bounded gates |
| `src/setup.ts` | Interactive install: links, credentials file, then doctor |
| `src/doctor.ts` | Setup self-check; the single source of truth for what a working install needs |
| `src/errors.ts` | `OperatorError`: a refusal the operator acts on; `cli.ts` prints its message with no stack trace and exits 1, any other error keeps its stack |
| `src/generated.ts` | Generated files: `covers`, `regensFor`, and `resolveGenerated` (take a side, rerun setup and `regen` in the sandbox, commit); also the shell quoting and host git identity the base merge uses |
| `src/config.ts` | The `ProjectConfig` type and loader |
| `prompts/` | Implement, review and repair templates. The kit fills `{{KIT_*}}`; Sandcastle fills `{{ISSUE_NUMBER}}`, `{{SOURCE_BRANCH}}`, `{{TARGET_BRANCH}}` and `` !`cmd` `` |
| `src/versions.ts` | Which Claude Code and Codex the image gets: the `latest` channel (or `claudeCode`, `CLAUDE_CODE_VERSION`, `CODEX_VERSION`) resolved on the host, cached six hours, with the Dockerfile's defaults as the offline fallback; the versions are part of the image tag |
| `docker/base.Dockerfile` | The shared base image; its Claude Code and Codex `ARG` versions are offline defaults, the kit passes the resolved ones |
| `status.sh` | Status view; bash 3.2-safe, macOS and Linux. A live run's tickets come from `run.json`'s `tickets`, never inferred |
| `test/status.test.sh` | The status view against a made-up repo and run records; `pnpm test` |
| `test/report.test.ts` | The closing summary's sections from made-up facts; `pnpm test` |
| `test/autonomy.test.ts` | The autonomy level, re-runnable tickets, turn decision and question, several run records in one process, and the CLI refusing a bad level; `pnpm test` |
| `test/cli.test.ts` | The CLI's one catch: an unknown command, a missing config, no repository and an existing init print a message, no stack; `pnpm test` |
| `test/layout.test.ts` | The Herdr view's proportions: the status view's share and the sandbox column's equal rows; `pnpm test` |
| `test/gates.test.ts` | Hook tests and gate runs against a made-up sandbox; `pnpm test` |
| `test/generated.test.ts` | Path matching, the resolve-by-regenerating helper against a real conflict in a temp repo, and the `generated` config validation; `pnpm test` |
| `test/guard.test.ts` | The shared-`.git` check in a throwaway repo: a moved base and tampering told apart; `pnpm test` |
| `test/land-command.test.ts` | `sandcastle land`: merge, gate, close and every refusal, in a temp repo with a host worktree as the sandbox; `pnpm test` |
| `test/lock.test.ts` | Lock takeover and release, and eight processes racing one stale lock; `pnpm test` |
| `skill/` | The sandcastle agent skill, shared by Claude Code, Codex and OpenCode: SKILL.md (the router and every short action), run.md (closing a run), update.md (the update action) and audit.md (the audit action) |
| `templates/` | What `sandcastle init` copies into a project |
| `examples/` | Invented example project configs |
| `docs/INSTALL.md` | Requirements, what `setup` does, the manual install, updating |
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
bash -n status.sh bin/sandcastle .githooks/pre-commit
pnpm test            # the status view, the closing summary, gates, locks and the .git guard against fixtures (no Docker, no model calls)
sandcastle doctor
# from inside a test project (no model calls):
sandcastle status 0
sandcastle lean
```

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
