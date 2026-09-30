# sandcastle-kit - instructions for coding agents

Two kinds of task happen in this repository. Decide which one you are doing first.

1. **The user wants to USE the kit** (install it, set up a project, triage, run): follow
   `README.md` -> "If you are an AI coding agent reading this". Start with `sandcastle doctor`.
   You will mostly work in the user's *project*, not here.
2. **The user wants to CHANGE the kit** (fix a bug, add a feature): read on.

## This repository is public

It is published on GitHub and used daily on the maintainer's machine. **Never commit anything
personal, client-specific, project-specific or secret**: no names, emails, tokens, private repo or
client names, private issue numbers, home-directory paths. Write lessons generically ("a review
caught a money-handling bug no gate would fail"), not as incidents from a named project.

- Personal things live outside the repo, in `~/.config/sandcastle-kit/` (`.env`, `config.json`,
  `denylist`). Project things live in each project's `.sandcastle/`.
- The kit must never write into its own directory at runtime. Everything a run writes goes to the
  project's `.sandcastle/` (gitignored there) or to a temp directory.
- The pre-commit hook (`git config core.hooksPath .githooks`) runs gitleaks and the user's
  denylist. Do not bypass it with `--no-verify`.
- A user's preference ("always keep skill X", "my client does Y") belongs in their memory or
  their project config, never in `skill/SKILL.md` or the README.

## Layout

| Path | What |
|---|---|
| `bin/sandcastle` | Shell entry; resolves symlinks, runs `src/cli.ts` with the kit's own `tsx` |
| `src/cli.ts` | Commands: doctor, init, build, lean, lean-apply (internal hook), preflight, run, status |
| `src/burndown.ts` | The orchestrator: fan out, implement, review, gate, land, verify, report |
| `src/agents.ts` | Models, effort, review fallback, Codex cross-review |
| `src/sandbox.ts` | Credentials (and token policy), images (hash tags, pruning), sandbox mounts and hooks |
| `src/lean.ts` | Lean inventory and plan, per-worktree strip, hook check, token measurement |
| `src/guard.ts` | Host safety: git hooks off, `.git` fingerprint, protected paths, run lock |
| `src/pool.ts` | Machine-wide sandbox and gate slots (lock files with pids) |
| `src/run.ts` | Preconditions, preflight, prompt rendering, run record, log archive, status pane |
| `src/worktree-lock.ts` | Worktree locks against `git worktree prune`; time-bounded gates |
| `src/doctor.ts` | Setup self-check |
| `src/config.ts` | The `ProjectConfig` type and loader |
| `prompts/` | Implement and review templates. `{{KIT_*}}` are filled by the kit; `{{ISSUE_NUMBER}}`, `{{SOURCE_BRANCH}}`, `{{TARGET_BRANCH}}` and `` !`cmd` `` by Sandcastle |
| `docker/base.Dockerfile` | The shared base image; pins Claude Code and Codex |
| `status.sh` | Status view; bash 3.2-safe, macOS and Linux |
| `skill/SKILL.md` | The `/sandcastle` Claude Code skill (users symlink it into `~/.claude/skills/`) |
| `templates/` | What `sandcastle init` copies into a project |
| `examples/` | Invented example project configs |

`@ai-hero/sandcastle` is a dependency, not vendored. When unsure what it does, read its source in
`node_modules/@ai-hero/sandcastle/dist` - do not guess.

## Verifying a change

Nothing here has unit tests yet. Before committing:

```bash
pnpm exec tsc --noEmit
bash -n status.sh bin/sandcastle .githooks/pre-commit
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
  as an array, never an interpolated string, unless it is a script run inside the container.
- British English in prose; hyphens with spaces ( - ) rather than em dashes.
- Commit messages: `type: subject` (Conventional Commits), imperative, body says why.
