# sandcastle init - set up a project

This continues SKILL.md: run its "Before every action" first.

1. **Read the repo.** Its `CLAUDE.md` / `AGENTS.md`, `package.json` (or equivalent), CI workflows
   and lockfile. Establish the package manager, the real gate commands (lint, typecheck, build,
   test - as CI runs them), what a sandbox needs installed, and what an agent must never do here
   (deploys, production databases, pushes).
2. **Draft the config and rules.** Run `sandcastle init`. It detects the stack (Node with its
   package manager and scripts, Python with uv, Go, Rust), writes gates and setup from it, and
   writes `.sandcastle/Dockerfile` when the base image lacks the toolchain. Treat all of it as a
   draft: correct the gates to what CI really runs, then write `.sandcastle/rules.md` from those
   facts. The kit's `examples/` has two worked configs.

   Before writing the rules, ask the user three questions with the harness's question tool
   (`AskUserQuestion` in Claude Code), proposing an answer for each from what you read:
   - **Generated files** - committed files a command writes (minified CSS, a data file built from
     JSON, a sitemap), with that command. Write each as a `generated: [{ paths, regen }]` entry in
     the config, and a rules line telling agents to edit the source and run the command.
   - **No-touch paths** - what an agent must never change: a rules line, and `protectedPaths` for
     any that change how the repo executes.
   - **Drift gate** - if there are generated files, propose a gate from the README's "A gate for
     generated files" recipe and add it to `gates` once the user agrees, or record in the rules
     why there is none.

   "None" is a fine answer to each; write it down so the next reader knows it was asked. Extend
   the Dockerfile (from the kit's `templates/Dockerfile` if init wrote none) only when the base
   image lacks something the gates or hooks need (browsers, a pinned package manager).
   If the project tests in Chromium (Playwright, Puppeteer), tell the user its tests must launch
   it with `--disable-dev-shm-usage`: a sandbox has the runtime's default `/dev/shm`, 64 MB on
   Docker (`df -h /dev/shm` in one shows it), and a heavy page crashes there. Add a line to
   `rules.md` too, so an agent does not mistake the crash for its own bug.
3. **Make the sandbox lean.** `sandcastle init` ends with the lean check: every skill, subagent,
   command, MCP server and plugin the repo would load into each sandbox agent, with its per-turn
   token cost. All of it is hidden unless `lean.keep` names it. Keep an item only when a run
   literally needs it - `rules.md` tells agents to use that skill, or a gate depends on that MCP
   server - with a comment saying why. The usual answer is `keep: []`.
   - If `CLAUDE.md` or `AGENTS.md` sends agents to a skill you hide, add a line to `rules.md`
     saying it is absent and what to do instead.
   - When the lean check lists a hidden item or a dropped hook as named by a kept file, open that
     file: if a gate, test or hook reads the item (a test comparing `.claude/settings.json` with
     the hooks it expects, say), keep it - otherwise that gate is red on every branch, base
     included, and no agent can fix it.
   - Flag an always-loaded `CLAUDE.md` chain over ~10k tokens as worth trimming.
4. **Keep the enforcement - review every hook.** Hooks cost no context and are how a repo
   enforces its rules, so every hook in `.claude/settings.json` is kept by default. Read each
   hook's script and sort it:

   | Hook does | Decision |
   |---|---|
   | Guards, blocks, validates, lints, formats, runs tests, gates a push, writes an audit log | keep - it is the point |
   | Loads or checks context at session start (drift, freshness, allowlists) | keep, unless it needs a host-only service or credential; then ask the user |
   | Host-only convenience: a token compressor, a preview or dev server, a notification, a sound, a terminal-multiplexer or editor integration | drop - a distinctive substring of its command in `lean.dropHooks`, with a comment saying why |

   A guard stays even when it blocks a run: fix its dependencies instead. When unsure, keep it and
   ask. Then:
   - `sandcastle build`, then `sandcastle lean`. Its hook check proves every kept hook can run in
     the image. Fix each `HOOK FAIL` in the project's Dockerfile until the check is clean. A
     `hook warn` for a missing module is fine only if a `setup` step installs it - name the step.
   - Hooks in `.claude/settings.local.json` (untracked) or the user's own settings never reach a
     sandbox. If one is a guard the project relies on, propose moving it into
     `.claude/settings.json`.
   - Git hooks (`core.hooksPath`, `.husky`) run on every agent commit inside the sandbox. Check
     that what they call is in the image and that none pushes or deploys.
   - **Prove the guards.** The hook check only proves a hook can run. For each kept `PreToolUse`
     guard that matters, add a `hookTests` entry to the config (README: Hook tests): a tool call
     it must refuse, with `expect: "block"` - read the guard's script for what it refuses - and
     for a broad guard one ordinary call with `expect: "allow"`. Step 6 runs them.
5. **Settings that stay.** Permissions and `env` in `.claude/settings.json` are kept. Check `env`
   for host paths or secrets a container cannot resolve.
6. **Gate the base commit: `sandcastle gates`.** Required, and free of model calls. It runs every
   gate and hook test on the base branch in a sandbox set up exactly as an agent's is - image,
   setup, lean plan. Done when every gate and hook test is green. A failed hook test is a guard
   that does not block in a sandbox: fix its dependencies (a module `setup` never installs is the
   usual cause), never the test. A gate red there is red on every branch, so fix the cause (an
   image missing a tool or too old for a test, a setup step, a hidden item or dropped hook a test
   reads) and run it again. The red gates' full output is in `.sandcastle/logs/base-gates.log`.
   Every run repeats this check and stops while a gate is red on base.
7. **Show the user** the config, rules, lean table, hook decisions and the green gate line. Offer
   (costs a little allowance) `sandcastle preflight`, and optionally `sandcastle lean --measure`
   to see the tokens saved. If `sandcastle doctor` lists `opt  Herdr plugin and sidebar rows`,
   recommend the kit's Herdr plugin as update.md step 1 does.
8. **Commit** `.sandcastle/config.ts`, `rules.md`, the Dockerfile and `.sandcastle/.gitignore` by
   the repo's own commit rules. `.sandcastle/.env` stays uncommitted.

Re-run `sandcastle lean` whenever the project adds skills, MCP servers or hooks. Every run repeats
the hook check and refuses to start while a kept hook cannot run.
