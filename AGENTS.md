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

The table of every path, one line each, is `docs/layout.md`: read it to find where a thing lives,
and add a row there when you add a module. What the larger modules own, and the rules each keeps
(the scheduler's requeue-once rule, the file hold, landing, the guard's fingerprint), is in
`docs/architecture.md`: read a module's section there before changing it.

| Area | What |
|---|---|
| `bin/sandcastle` | Shell entry: runs `src/cli.ts` on Node's own type stripping |
| `src/` | The kit: the CLI and every command, the run (burndown, schedule, landing, ledger, report), sandboxes and gates, the guard and pool, the trackers, the Herdr and herdr-core views, and the status view |
| `herdr/`, `herdr-app/` | The Herdr TUI plugin and the Herdr app mod |
| `mod/` | The optional Claude Code mod; imports nothing from `src/` |
| `skill/` | The sandcastle agent skill, shared by Claude Code, Codex and OpenCode. Before editing it, read its portability rules in `docs/architecture.md` |
| `prompts/` | Implement, review, repair and resolve templates |
| `container/` | Mounted read-only at `/etc/claude-code` in every sandbox: managed settings, `git-guard.sh`, the report schema |
| `docker/` | The shared base and agents images |
| `status.sh` | The status view's entry, a Bash 3.2-safe wrapper with no logic |
| `templates/`, `examples/` | What `sandcastle init` copies into a project; invented example configs |
| `test/` | One `*.test.ts` file per behaviour, the runners and fixtures, `full-check.sh` |
| `docs/`, `site/`, `CHANGELOG.md` | User documentation, the GitHub Pages site, Keep a Changelog |

`@ai-hero/sandcastle` is a dependency, not vendored, with a pnpm patch (`patches/`; why, in
`docs/architecture.md` -> "patched dependency"). Its behaviour is in
`node_modules/@ai-hero/sandcastle/dist` - read the source there when unsure.

## Verifying a change

A change is ready to commit when `README.md`, `skill/` and `docs/` no longer describe the old
behaviour (grep them for its words, not only for the function's name), and all of these pass:

```bash
pnpm lint            # oxlint (.oxlintrc.json); a false positive is disabled at its line, with the reason
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
in Linux (agents' sandboxes are Linux, so BSD tools break only here), and scans the new commits
for secrets, the denylist and home-directory paths. It takes minutes: it names its log directory at
once and each leg's result on stderr as the leg ends, but the summary only when every leg is done,
so start it in the background with both streams in a file, and read its `RESULT:` line.

In this repository's sandbox image (`.sandcastle/Dockerfile`), `bash32` is macOS's bash 3.2 built
from source, and `test/status.test.sh` (part of `pnpm test`) renders one scenario through `status.sh`
under it and checks the frame is the same as under the bash on PATH. Every
host shell script (all but `container/`) parses under it too, and `test/host-shell-portability.test.ts`
refuses a bash 4 construct or a GNU-only flag without a fallback in one: shellcheck has no 3.2
dialect. A line that must keep one says why with `# portability-ok: <reason>`. Before
committing a change to a shell script, run `shellcheck -S error` on it; `shellcheck` is installed there too.

`sandcastle run`, `preflight` and `lean --measure` spend the user's model allowance; ask first.
Test a guard (git hooks, protected paths, fingerprint) in a throwaway clone under a temp
directory, never in a real project.

## Conventions

- TypeScript run by Node's own type stripping (Node 22.18+), ESM, `.ts` import extensions (not in `mod/hooks/`: see `test/mod-resolve.ts`), strict mode,
  erasable syntax only (no enums, namespaces or parameter properties; `tsc` refuses them). No build step.
- A test that reads a function out of a shell script uses `eval "$(sed ...)"`, never `source <(sed ...)`:
  macOS CI's bash is 3.2, which cannot source a process substitution (`test/bash32-source.test.ts` holds it).
- Comments explain *why* - the failure a line prevents - not what the code does.
- Every file write outside a temp dir targets the project root. Every shell call passes arguments
  as an array; an interpolated string is only for a script run inside the container.
- British English in prose; hyphens with spaces ( - ) rather than em dashes.
- Wrap prose in `docs/*.md` at about 100 columns, a sentence to start a line, and never keep a
  paragraph on one line: a grep or diff of a 10,000-character line overflows an agent's tool output,
  and two tickets that append to it conflict on it. `test/docs-line-length.test.ts` refuses a line
  over 400 characters outside tables and fenced code. A wrapped line never starts with a spaced
  hyphen ( - ): Markdown reads it as a list item; the hyphen ends the line before.
- Commit messages: `type: subject` (Conventional Commits), imperative, body says why.
- A change made by hand goes on a `feature/`, `fix/`, `docs/` or `refactor/` branch cut from
  `origin/main`, and reaches main through a pull request the maintainer merges. A run's own
  landings and the release commit are the exceptions.
- Every user-facing change gets a `CHANGELOG.md` line under `[Unreleased]`. One an existing
  project may need to act on - a new default that changes what a run does or spends, a new
  convention, anything `sandcastle init` now writes differently - also gets an **Upgrading**
  note, and if a project needs a check or a fix, a step in the skill's `update` action (`skill/update.md`). Write
  that step as a check that is safe to repeat, never as "since version X". A pull request that
  changes shipped files and adds nothing under `[Unreleased]` fails the Changelog check
  (`scripts/changelog-check.mjs`, which lists the paths that count); label it `no-changelog`
  when nobody outside the code would notice, a refactor say.

## Releases

Releasing - a version bump, a tag, release notes - follows `docs/releasing.md`: read it first.

## Agent skills

### Issue tracker

This repository's own work is tracked in GitHub Issues (`gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Matt Pocock's five default role names, unchanged (the kit reads this file too). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the root, created when a term or decision settles. See `docs/agents/domain.md`.
