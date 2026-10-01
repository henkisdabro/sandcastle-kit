<!-- Added to both the implement and the review prompt under "Project rules". -->

This repository is sandcastle-kit itself. `AGENTS.md` is the rule book: read it first, and its
"This repository is public", "Verifying a change" and "Conventions" sections apply to every change.

- **Do only what the ticket and its comments decided.** The maintainer decides any change to the
  kit's approach, defaults, commands, config keys, output or look. If the fix would need such a
  change and the ticket does not decide it, hand the ticket back rather than choosing.
- **Cross-platform.** The kit runs on macOS (BSD tools, bash 3.2) and Linux (GNU tools). Shell
  code - `status.sh`, `bin/sandcastle`, scripts run in a container - must work on both: no GNU-only
  or BSD-only flags without a fallback.
- **Prove it with a test.** A fix gets a test in `test/` that fails without it, using a temp git
  repo, a fake `gh` on `PATH` and made-up fixtures - never Docker, a model call or the network.
- **Never run** `sandcastle run`, `preflight`, `build`, `lean --measure`, `setup` or `clean` here:
  they need Docker or spend model allowance. `pnpm exec tsc --noEmit`, `bash -n` and `pnpm test`
  are the checks.
- **Every user-facing change** gets a `CHANGELOG.md` line under `[Unreleased]`, with an
  **Upgrading** note when an existing project must act (AGENTS.md -> Conventions).
- `skill/SKILL.md`'s `description` stays under 1,024 characters and the skill stays portable across
  Claude Code, Codex and OpenCode (AGENTS.md -> "The skill serves three harnesses").
- Nothing personal in any file, commit or issue comment: no names, emails, tokens, home paths or
  private repo names. Write a lesson as a pattern, not as an incident.
- Leave `docker/base.Dockerfile` version pins alone unless the ticket is about them.
