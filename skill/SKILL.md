---
name: sandcastle
description: "sandcastle-kit: unattended coding agents that burn down a repo's GitHub issues in Docker sandboxes. Actions: init (set a project up - gates, lean sandbox, hooks checked), queue (triage open issues into the agent queue with the user), run (start a burndown with its status view), status (what a run is doing). Use for sandcastle, burndown, AFK agents, or queueing issues for agents."
argument-hint: "[init|queue|run|status]"
arguments: [action]
---

# Sandcastle

Requested action: `$action`

| Action | Does | Done when |
|---|---|---|
| `init` | Sets up the current project: config, rules, lean sandbox, hook decisions | The user has approved the config and it is committed |
| `queue` | Triages every open issue into the agent queue, with the user | Every open issue is labelled, parked, or left with a stated reason |
| `run` | Starts a burndown in a separate pane or terminal | The run is live in its own pane, or the user holds the exact command |
| `status` | Reports what a run is doing | The user has the snapshot and the cause of any failed row |

With no action (blank, or the literal `$action` in a harness that does not fill it in), take it
from the user's request; if that names none either, run `sandcastle status 0` and suggest the
action that fits what it shows.

## Before every action

1. Run `sandcastle doctor`. Its first line is the kit's location; that kit's `README.md` covers
   anything this file does not. If `sandcastle` is not found, the kit is not installed: follow the
   README's Install section with the user.
2. Fix every `FIX` line doctor prints before going further. Tokens are the user's to create.

**Where things are written.** The kit is shared by all the user's projects and may be public, so
its files (this skill, the README, prompts) stay generic. Project facts go in the project's
`.sandcastle/`; the user's preferences go in their memory.

**Costs.** `sandcastle run`, `sandcastle preflight` and `sandcastle lean --measure` call the model
and spend the user's plan allowance or API credits. Say so and get a yes before running them.

## init - set up a project

1. Read the repo's `CLAUDE.md` / `AGENTS.md`, `package.json` (or equivalent), CI workflows and
   lockfile. Establish the package manager, the real gate commands (lint, typecheck, build, test -
   as CI runs them), what a sandbox needs installed, and what an agent must never do here
   (deploys, production databases, pushes).
2. Run `sandcastle init`, then fill in `.sandcastle/config.ts` and `.sandcastle/rules.md` from
   those facts. The kit's `examples/` has two worked configs. Write `.sandcastle/Dockerfile` from
   the kit's `templates/Dockerfile` only when the base image lacks something the gates or hooks
   need (browsers, Python tooling, a pinned package manager).
3. **Make the sandbox lean.** `sandcastle init` ends with the lean check: every skill, subagent,
   command, MCP server and plugin the repo would load into each sandbox agent, with its per-turn
   token cost. All of it is hidden unless `lean.keep` names it. Keep an item only when a run
   literally needs it - `rules.md` tells agents to use that skill, or a gate depends on that MCP
   server - with a comment saying why. The usual answer is `keep: []`. If `CLAUDE.md` or
   `AGENTS.md` sends agents to a skill you hide, add a line to `rules.md` saying it is absent and
   what to do instead. Flag an always-loaded `CLAUDE.md` chain over ~10k tokens as worth trimming.
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
5. **Settings that stay.** Permissions and `env` in `.claude/settings.json` are kept. Check `env`
   for host paths or secrets a container cannot resolve.
6. Show the user the config, rules, lean table and hook decisions. Offer (costs a little allowance)
   `sandcastle preflight`, and optionally `sandcastle lean --measure` to see the tokens saved.
7. Commit `.sandcastle/config.ts`, `rules.md`, the Dockerfile and `.sandcastle/.gitignore` by the
   repo's own commit rules. `.sandcastle/.env` stays uncommitted.

Re-run `sandcastle lean` whenever the project adds skills, MCP servers or hooks. Every run repeats
the hook check and refuses to start while a kept hook cannot run.

## queue - triage every open issue into the queue

The queue is the config's `label` (default `ready-for-agent`). An issue gets it only when its
spec is **closed**: an unattended agent with no chat context can finish it from the issue and its
comments, and the gates can prove it.

1. **List every open issue**: `gh issue list --state open --limit 500 --json
   number,title,labels,updatedAt`. Already-queued issues get a quick sanity check only.
2. **Facts first.** Fan out read-only subagents, about seven issues each (without subagents, work
   through them in the same batches). Each reads the issue, its comments, the code it names,
   recent history, the repo's decision records (`docs/adr/` or similar), its label vocabulary
   (e.g. `docs/agents/triage-labels.md`), and any earlier decision or `PARKED:` comment - a
   recorded decision or revival condition is checked, not re-asked. Each returns per issue: the
   category below, the evidence, and for a decision the concrete question with options and a
   recommendation. Ask the user only what the code and history cannot answer.

   | Category | Action |
   |---|---|
   | Ready - spec closed, provable by the gates | label now; add a short triage note if the issue is stale or half-fixed |
   | Needs a decision | ask (step 3) |
   | Human-only - console, device, secret, production, legal | the repo's human label (e.g. `needs-human`), with a comment saying why |
   | Blocked by another issue | no label; comment "blocked by #N" so no run starts it early |
   | Already fixed or false | comment the evidence; ask before closing |
   | Epic or too big for one agent run | propose child issues; ask before creating them |
   | Parked | retitle `PARKED: ...` with the revival condition in a comment, after asking |

3. **Ask in batched rounds** with the harness's question tool (`AskUserQuestion` in Claude Code):
   up to four questions a round, grouped by theme. Each question stands alone - enough context to
   decide without opening GitHub, the issue link, the recommended option first. Continue until
   every decision is answered. An issue the user says needs a design discussion stays unlabelled,
   with that noted.
4. **Close the spec, then label.** For each answer: comment the decision on the issue - the
   implementing agent reads the issue and its comments, never this chat - then add the queue
   label. Create a missing label with `gh label create`.
5. **Report**: a table of what was labelled, what was decided, and what was left and why.

## run - start a burndown

1. Check the tree: `git status --porcelain` empty, the base branch checked out, and
   `git log --oneline -5` plus `git reflog -5` look as expected (another session may be using the
   same checkout). Show the user the queue (`gh issue list --label <label>`), the models, whether
   it is a dry run, and `sandcastle status 0`'s machine line (other projects' runs share the
   limits). Confirm before starting - a run comments on and closes issues on GitHub and merges
   into the base branch locally.
2. Start it outside your own shell - it takes hours. In a terminal multiplexer you can drive (for
   example Herdr: `test "${HERDR_ENV:-}" = 1`), open a sibling pane at the repo root without
   taking focus and run `<env vars> sandcastle run` there; inside Herdr the run opens its own
   status pane. Otherwise give the user the command to run in a second terminal, plus
   `sandcastle status` for a third.
3. A run pushes nothing. Pushing the merged base branch afterwards follows the repo's own
   shipping rules. Branches labelled `needs-human` were green but change hooks, CI or install
   scripts: they need a human review and merge.

## status - what a run is doing

`sandcastle status 0` prints a snapshot; `sandcastle status` refreshes every 10 s (run it in a
separate pane or terminal). Each row's log is `.sandcastle/logs/agent-issue-<n>-*.log`; the last
lines of a failed run's log hold the real cause (a usage limit usually reads as a "trust dialog"
error).
