<!-- Added to both the implement and the review prompt under "Project rules". -->

This repository is sandcastle-kit itself. `AGENTS.md` is the rule book: read it first, and its
"This repository is public", "Verifying a change" and "Conventions" sections apply to every change.

- **Do only what the ticket and its comments decided.** The maintainer decides any change to the
  kit's approach, defaults, commands, config keys, output or look. If the fix would need such a
  change and the ticket does not decide it, hand the ticket back rather than choosing.
- **Cross-platform, with no macOS regression.** The kit runs on macOS (BSD tools, bash 3.2,
  Docker Desktop or OrbStack) and Linux (GNU tools, bash 5, native Docker). A fix for one platform
  must leave the other working exactly as before. Shell code - `status.sh`, `bin/sandcastle`,
  scripts run in a container - uses no GNU-only or BSD-only flag without a fallback (`date`,
  `sed -i`, `stat`, `readlink -f`, `timeout` all differ), and TypeScript uses `node:path` and
  `os.tmpdir()`, never a hard-coded path or `/tmp`. Say in your final message which platform
  differences you considered and how the test covers them.
- **Prove it with a test.** A fix gets a test in `test/` that fails without it, using a temp git
  repo, a fake `gh` on `PATH` and made-up fixtures - never Docker, a model call or the network.
- **Never run** `sandcastle run`, `preflight`, `build`, `lean --measure`, `setup` or `clean` here:
  they need Docker or spend model allowance. `pnpm exec tsc --noEmit`, `bash -n` and `pnpm test`
  are the checks.
- **Do not edit `CHANGELOG.md`**, even where AGENTS.md or the ticket asks for a line: tickets in one
  run all add at the same spot and would conflict at landing. The maintainer writes the entries
  from the run's closing summary, so say in your final message what a changelog line should say.
- **New tests go in a new file** under `test/`, named for what it tests (`test/preflight.test.ts`),
  not appended to an existing one, for the same reason. `pnpm test` picks up `test/*.test.ts`.
- `skill/SKILL.md`'s `description` stays under 1,024 characters and the skill stays portable across
  Claude Code, Codex and OpenCode (AGENTS.md -> "The skill serves three harnesses").
- Nothing personal in any file, commit or issue comment: no names, emails, tokens, home paths or
  private repo names. Write a lesson as a pattern, not as an incident.
- Leave `docker/base.Dockerfile` version pins alone unless the ticket is about them.
