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
- **Run one test file with `pnpm test:file test/<name>.test.ts`**, not a bare `node --test`: it
  loads the preloads `pnpm test` does (a test that prints outside `quietly` passes by hand and fails
  the suite otherwise), limits each test to two minutes and exits when the file is done, so a red
  test that leaves a poll or a pool wait alive cannot hang the pass. A test that takes pool slots
  goes through `test/pool-sim.ts`, whose probe it needs.
- **Final check: `pnpm exec tsc --noEmit` and `pnpm test:related <the files you changed>`.** It
  runs every test that names a changed path or anything it exports, including the tests that pin
  source text or wording, which a red ticket gate would otherwise find after you finish.
- **`burndown()` needs Docker, so no test drives it.** Put logic you add there in an exported helper
  a test calls, and hold the call site with a source-match test (as `test/ticket-first-start.test.ts`
  does). Before you edit a line of `burndown()` or `timed`, `grep -rn` `test/` for a phrase of it:
  some tests pin its text, and fail only in the full suite.
- **A test that starts the kit as a child process** uses `runKit`, `runNode`, `startKit` or
  `startNode` from `test/cli-spawn.ts` (`process.execPath` with the launcher's V8 flags and a time
  limit; `test/cli-spawn.test.ts` refuses a test file that names the launcher's preload), never
  `bin/sandcastle`: it finds `node` on PATH, and on a Mac that is often a mise or asdf
  shim, which fails once the test moves `XDG_CONFIG_HOME`. Give `script` and other terminal tools `stdio: ["ignore", ...]`: BSD tools
  refuse the socket Node passes as stdin. The sandbox is Linux, so it cannot catch either.
- **A new or changed shell script that runs on the host** (anything outside `container/`): run it,
  or the test that runs it, under `bash32` too - macOS's bash 3.2, built in this sandbox - and
  `shellcheck -S error` it; both are installed here. Users' Macs run `#!/usr/bin/env bash` scripts
  under 3.2, which has no associative arrays, `mapfile`, `${x,,}` or `source <(...)`.
- **Never run** `sandcastle run`, `preflight`, `build`, `lean --measure`, `setup` or `clean` here:
  they need Docker or spend model allowance. AGENTS.md's `doctor`, `status 0` and `lean` checks
  are for the maintainer's machine: here they only report that Docker is missing. `pnpm lint`, `pnpm exec tsc --noEmit`, `bash -n` and
  `pnpm test` are the checks.
- **Do not edit `CHANGELOG.md`**, even where AGENTS.md or the ticket asks for a line: tickets in one
  run all add at the same spot and would conflict at landing. The maintainer writes the entries
  from the run's closing summary: give each line in a `<changelog>...</changelog>` tag in your final
  message, as the prompt asks, starting `Added:`, `Changed:` or `Fixed:` - and a line starting
  `Upgrading:` for a change AGENTS.md -> Conventions gives an **Upgrading** note, saying what an
  existing project must do (the `skill/update.md` step, if it needs one, is still yours to write).
- **New tests go in a new file** under `test/`, named for what it tests (`test/preflight.test.ts`),
  not appended to an existing one, for the same reason. `pnpm test` picks up `test/*.test.ts`.
- `skill/SKILL.md`'s `description` stays under 1,024 characters and the skill stays portable across
  Claude Code, Codex and OpenCode (`docs/architecture.md` -> `skill/`).
- Nothing personal in any file, commit or ticket comment: no names, emails, tokens, home paths or
  private repo names. A path in a test or fixture uses a placeholder home - `/home/user`, `/home/node`
  or `/home/agent` - never a made-up name under `/home` or `/Users`: `test/source-hygiene.test.ts` refuses any
  other. Write a lesson as a pattern, not as an incident.
- Leave `docker/base.Dockerfile` version pins alone unless the ticket is about them.
- **How the test runner reports.** `pnpm test` runs `node:test` with its spec output: a pass is
  `ℹ pass N`, a failure is a line starting `✖` and `ℹ fail N`. It does not print TAP, so grepping
  for `^not ok` or `^# pass` finds nothing. Redirect the run to a file and grep that. `pnpm test`
  runs `test/status.test.sh` first, and it reports a failure as a line starting `FAIL [` instead:
  grep for both (`^✖|^FAIL \[`), or a red run can show no matching line.
