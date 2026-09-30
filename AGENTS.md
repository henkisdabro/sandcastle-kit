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
  X") belongs in their memory or project config, not in `skill/SKILL.md` or the README.
- At runtime the kit writes only to the project's `.sandcastle/` (gitignored there) or a temp
  directory - its own directory stays read-only.
- The pre-commit hook (`git config core.hooksPath .githooks`) runs gitleaks and the user's
  denylist. Every commit goes through it; a finding is fixed, not bypassed with `--no-verify`.

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
| `prompts/` | Implement and review templates. The kit fills `{{KIT_*}}`; Sandcastle fills `{{ISSUE_NUMBER}}`, `{{SOURCE_BRANCH}}`, `{{TARGET_BRANCH}}` and `` !`cmd` `` |
| `docker/base.Dockerfile` | The shared base image; pins Claude Code and Codex |
| `status.sh` | Status view; bash 3.2-safe, macOS and Linux |
| `skill/SKILL.md` | The `sandcastle` agent skill - one file shared by Claude Code, Codex and OpenCode |
| `templates/` | What `sandcastle init` copies into a project |
| `examples/` | Invented example project configs |

`@ai-hero/sandcastle` is a dependency, not vendored. Its behaviour is in
`node_modules/@ai-hero/sandcastle/dist` - read the source there when unsure.

## The skill serves three harnesses

`skill/SKILL.md` is symlinked into `~/.claude/skills/` (Claude Code, also scanned by OpenCode)
and `~/.agents/skills/` (Codex). One file works in all three because each ignores frontmatter it
does not know. Keep it portable:

- `name` stays `sandcastle`, matching the directory the user links it as.
- `description` stays under 1,024 characters (OpenCode rejects longer) and carries every trigger:
  Codex and OpenCode never see Claude Code's `when_to_use`.
- `argument-hint` and `arguments: [action]` are Claude Code's; the body handles an unfilled
  `$action` for the other two.
- Name harness-specific tools by what they do, with the Claude Code name as an example
  ("the harness's question tool (`AskUserQuestion` in Claude Code)").

## Verifying a change

Nothing here has unit tests yet. A change is ready to commit when all of these pass:

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
  as an array; an interpolated string is only for a script run inside the container.
- British English in prose; hyphens with spaces ( - ) rather than em dashes.
- Commit messages: `type: subject` (Conventional Commits), imperative, body says why.
