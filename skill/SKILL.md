---
name: sandcastle
description: "sandcastle-kit: unattended coding agents that burn down a repo's GitHub issues or ticket files in Docker sandboxes. Actions: init (set a project up - gates, lean sandbox, hooks checked), audit (review the repo with read-only agents, one per lens, and file what they find as tickets ready to queue), queue (triage open tickets into the agent queue with the user), run (start a burndown with its status view), status (what a run is doing, or how the last one ended: `sandcastle report`), update (pull the latest kit and bring this project up to date with it). Use for sandcastle, burndown, AFK agents, auditing a repo to build a backlog, queueing tickets for agents, or updating or upgrading sandcastle-kit."
argument-hint: "[init|audit|queue|run|status|update]"
arguments: [action]
---

# Sandcastle

Requested action: `$action`

| Action | Does | Done when |
|---|---|---|
| `init` | Sets up the current project: config, rules, lean sandbox, hook decisions | The user has approved the config and it is committed |
| `audit` | Reviews the repo with read-only agents, one per lens, and files what they find as tickets that meet the queue criteria, with the user | Every finding is filed, merged into another, or dropped with a stated reason, and the user has the table |
| `queue` | Triages every open ticket into the agent queue, with the user | Every open ticket is labelled, parked, or left with a stated reason |
| `run` | Starts a burndown detached, waits for it with `sandcastle wait`, and closes it with a summary | The run is live and its printed status view is confirmed, or the user holds the exact command; when it ends, the user has the seven-section closing summary |
| `status` | Reports what a run is doing | The user has the snapshot and the cause of any failed row |
| `update` | Pulls the latest kit and brings the current project up to date with it | The kit is current, the project's image and hook check are clean, and every change that affects it is reported or applied |

With no action (blank, or the literal `$action` in a harness that does not fill it in), take it
from the user's request; if that names none either, run `sandcastle status 0` and suggest the
action that fits what it shows. When it shows no runs and `sandcastle queue` is empty, say so and
name the next step (file tickets - GitHub issues or ticket files - for the work, then the `queue` action) rather than
stopping.

## Before every action

1. Run `sandcastle doctor`. Its first line is the kit's location; that kit's `README.md` covers
   anything this file does not. If `sandcastle` is not found, the kit is not installed: have the
   user clone it and run `./bin/sandcastle setup` in their own terminal (it asks for tokens).
2. Fix every `FIX` line doctor prints before going further. A `warn` line is not a failure; mention it
   to the user. Tokens are the user's to create. When a
   run or preflight fails on auth, `sandcastle doctor --verify` asks GitHub and Anthropic whether the
   tokens are accepted (no model call).

**Where things are written.** The kit is shared by all the user's projects and may be public, so
its files (this skill, the README, prompts) stay generic. Project facts go in the project's
`.sandcastle/`; the user's preferences go in their memory.

**Costs.** `sandcastle run`, `sandcastle preflight` and `sandcastle lean --measure` call the model
and spend the user's plan allowance or API credits. Say so and get a yes before running them.

**Models and effort.** The kit's defaults are in its README ("Environment variables"). To change
them for a project, set `model` or `effort` under `implement` or `review` in the project's
`.sandcastle/config.ts` and commit it - for example `review: { effort: "medium" }`. For one run
only, prefix the command with `IMPL_MODEL`, `IMPL_EFFORT`, `REVIEW_MODEL` or `REVIEW_EFFORT`;
these win over the config. Repair uses the implementer's model and effort. A run that is already
going keeps its models; the change applies from the next one. It never needs a change to the kit.

## init - set up a project

1. Read the repo's `CLAUDE.md` / `AGENTS.md`, `package.json` (or equivalent), CI workflows and
   lockfile. Establish the package manager, the real gate commands (lint, typecheck, build, test -
   as CI runs them), what a sandbox needs installed, and what an agent must never do here
   (deploys, production databases, pushes).
2. Run `sandcastle init`. It detects the stack (Node with its package manager and scripts, Python
   with uv, Go, Rust), writes gates and setup from it, and writes `.sandcastle/Dockerfile` when
   the base image lacks the toolchain. Treat all of it as a draft: correct the gates to what CI
   really runs, then write `.sandcastle/rules.md` from those facts.
   Before writing it, ask the user three questions with the harness's question tool
   (`AskUserQuestion` in Claude Code), proposing an answer for each from what you read: **generated
   files** - committed files a command writes (minified CSS, a data file built from JSON, a
   sitemap), with that command: write each as a `generated: [{ paths, regen }]` entry in the config
   and a rules line telling agents to edit the source and run the command; **no-touch paths** -
   what an agent must never change: a rules line, and `protectedPaths` for any that change how the
   repo executes; **drift gate** - if there are generated files, propose a gate from the README's
   "A gate for generated files" recipe and add it to `gates` once the user agrees, or record in the
   rules why there is none. "None" is a fine answer to each; write it down so the next reader knows
   it was asked. The kit's `examples/` has two
   worked configs. Extend the Dockerfile (from the kit's `templates/Dockerfile` if init wrote
   none) only when the base image lacks something the gates or hooks need (browsers, a pinned
   package manager).
3. **Make the sandbox lean.** `sandcastle init` ends with the lean check: every skill, subagent,
   command, MCP server and plugin the repo would load into each sandbox agent, with its per-turn
   token cost. All of it is hidden unless `lean.keep` names it. Keep an item only when a run
   literally needs it - `rules.md` tells agents to use that skill, or a gate depends on that MCP
   server - with a comment saying why. The usual answer is `keep: []`. If `CLAUDE.md` or
   `AGENTS.md` sends agents to a skill you hide, add a line to `rules.md` saying it is absent and
   what to do instead. When the lean check lists a hidden item or a dropped hook as named by a
   kept file, open that file: if a gate, test or hook reads the item (a test comparing
   `.claude/settings.json` with the hooks it expects, say), keep it - otherwise that gate is red on
   every branch, base included, and no agent can fix it. Flag an always-loaded `CLAUDE.md` chain over ~10k tokens as worth trimming.
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
   setup, lean plan. A failed hook test is a guard that does not block in a sandbox: fix its
   dependencies (a module `setup` never installs is the usual cause), never the test.
   A gate red there is red on every branch, so fix the cause (an image missing a tool or too old
   for a test, a setup step, a hidden item or dropped hook a test reads) and run it again until
   every gate is green. The red gates' full output is in `.sandcastle/logs/base-gates.log`. Every
   run repeats this check and stops while a gate is red on base.
7. Show the user the config, rules, lean table, hook decisions and the green gate line. Offer
   (costs a little allowance) `sandcastle preflight`, and optionally `sandcastle lean --measure`
   to see the tokens saved. Inside Herdr, if `sandcastle doctor` lists `opt  Herdr plugin and
   sidebar rows`, recommend the kit's Herdr plugin as in update.md step 1; outside Herdr, say
   nothing about it.
8. Commit `.sandcastle/config.ts`, `rules.md`, the Dockerfile and `.sandcastle/.gitignore` by the
   repo's own commit rules. `.sandcastle/.env` stays uncommitted.

Re-run `sandcastle lean` whenever the project adds skills, MCP servers or hooks. Every run repeats
the hook check and refuses to start while a kept hook cannot run.

## audit - find work and file it

Read audit.md in this skill's directory (next to this file) and follow it. It files tickets by
the queue action's categories and its closed-spec test, so read the queue section below as well.

## queue - triage every open ticket into the queue

The queue is the config's `label` (default `ready-for-agent`). A ticket gets it only when its
spec is **closed**: an unattended agent with no chat context can finish it from the ticket and its
comments, and the gates can prove it.

0. **Which tracker?** `sandcastle queue` names it and why. `github`: use `gh` as below. `files`:
   tickets are `.scratch/<feature>/issues/<NN>-<slug>.md`; list them, write each decision under
   `## Comments`, and queue by setting `Status: <label>` (commit it). If the repo has
   `docs/agents/issue-tracker.md`, its conventions win. The kit reads that file (Matt Pocock's setup
   skill writes it) but does not need it.
1. **List every open ticket**: `gh issue list --state open --limit 500 --json
   number,title,labels,updatedAt` (files: every ticket whose `Status:` is not done). If exactly 500
   come back, the list was cut off: raise `--limit` and list again. Already-queued tickets get a quick sanity check only.
2. **Facts first.** Fan out read-only subagents, about seven tickets each (without subagents, work
   through them in the same batches). Each reads the ticket, its comments, the code it names,
   recent history, the repo's decision records (`docs/adr/` or similar), its label vocabulary
   (e.g. `docs/agents/triage-labels.md`), and any earlier decision or `PARKED:` comment - a
   recorded decision or revival condition is checked, not re-asked. Each returns per ticket: the
   category below, the evidence, and for a decision the concrete question with options and a
   recommendation. Ask the user only what the code and history cannot answer.

   **Persist each result.** The chat can be compacted and the results lost; files survive it. So
   each subagent writes its result for each ticket, as soon as it has it, to
   `.sandcastle/triage/<id>.json` in the project (`<id>` is the ticket number, or the ticket id for
   the files tracker; the directory is gitignored). Fields: `issue`, `category` (one of the table's
   rows), `evidence`, `triagedAt` (an ISO 8601 timestamp), and for a decision `question`, `options`
   (recommended first) and `recommendation`. A ticket that already has a file is not re-triaged
   unless the ticket was updated after the file was written (the ticket's `updatedAt` is later than
   the file's `triagedAt`). The subagents' file writes are the one exception to "no edits" in the
   brief below.

   Write the batch's ticket numbers into the `Tickets:` line before sending; never send a brief with
   a placeholder left in it.

   ```text
   Brief for each subagent
   You are triaging tickets. Read-only: read files, search, run `git log`, `git show`, `git blame`,
   and `gh issue view N --json title,body,comments,updatedAt` (files tracker: read the ticket
   file). No edits (bar the triage file below), no commits, no tracker writes (no `gh issue
   comment`, `gh issue edit`, `gh issue close`, `gh issue create`, no `gh label`), and no
   `sandcastle run`, `preflight` or anything else that spends model allowance.
   Tickets: <the batch's numbers>
   For each ticket read: the ticket and its comments, the code it names, recent history, the repo's
   decision records and label vocabulary, and any earlier decision or `PARKED:` comment.
   Classify each ticket as exactly one of: ready, needs a decision, human-only, blocked by another
   ticket, already fixed or false, epic or too big, parked.
   Return per ticket: the number, the category, and the evidence with file:line. For a decision, add
   one self-contained question with 2-4 options, recommended first. For blocked, name the blocking
   ticket. For too big, list the proposed child tickets.
   Also write each result as soon as you have it to `.sandcastle/triage/<id>.json` (the only file
   you may write): `issue`, `category`, `evidence`, `triagedAt` (ISO 8601 now) and, for a
   decision, `question`, `options`, `recommendation`. Skip a ticket whose file's `triagedAt` is
   later than the ticket's `updatedAt`.
   ```

   | Category | Action |
   |---|---|
   | Ready - spec closed, provable by the gates | label now; add a short triage note if the ticket is stale or half-fixed |
   | Needs a decision | ask (step 3) |
   | Human-only - console, device, secret, production, legal | the hold label - `ready-for-human`, or what `docs/agents/triage-labels.md` maps it to (a run never takes a ticket carrying it, nor the older `needs-human`) - with a comment saying why |
   | Blocked by another ticket | label it, with a `Blocked by #N` line in the ticket *body* (`gh issue edit`): a run skips it until #N is closed. A comment is not read. Write it as plain text: a line inside a code block or backticks is not read either. If the blocker is a Linear issue or an in-repo task file, name it (`Blocked by ENG-42`, `Blocked by tasks/0042-auth.md`) once the project's config has `blockers` for it (README -> Blockers); otherwise the line is ignored |
   | Already fixed or false | comment the evidence; ask before closing |
   | Epic or too big for one agent run | propose child tickets; ask before creating them |
   | Parked | retitle `PARKED: ...` with the revival condition in a comment, after asking |

3. **Ask in batched rounds**, from the files in `.sandcastle/triage/`, with the harness's
   question tool (`AskUserQuestion` in Claude Code): up to four questions a round, grouped by
   theme. Each question stands alone - enough context to decide without opening GitHub, the ticket
   link, the recommended option first. Continue until every decision is answered. A ticket the
   user says needs a design discussion stays unlabelled, with that noted.
4. **Close the spec, then label.** Take each decision from its file, and record the user's answer
   in it as `answer`. Then comment the decision on the ticket - the implementing agent reads the
   ticket and its comments, never this chat - then add the queue label. Create a missing label with
   `gh label create`. A hard ticket can carry `model:`/`effort:` labels (GitHub) for a stronger
   implementer; offer it, do not add it unasked.
5. **Report**: a table of what was labelled, what was decided, and what was left and why, built
   from the files in `.sandcastle/triage/`. Add the queue's shape from `sandcastle queue --lint`
   (read-only, no model calls): the longest `Blocked by` chain, edges that only order overlapping
   `Touches:`, wide tickets, hot and unmergeable files, and a rough turn count. It is advice, so
   quote it as a guess and offer to trim a chain or a `Blocked by` edge it flags; do not edit unasked.

## run - start a burndown

1. Check the tree: `git status --porcelain` empty, the base branch checked out, and
   `git log --oneline -5` plus `git reflog -5` look as expected (another session may be using the
   same checkout). Show the user the queue (`sandcastle queue`), the models, whether it is a dry
   run, and `sandcastle status 0`'s machine line (other projects' runs share the limits). Do not
   guess how long it takes: once the project has run before, the run prints a rough estimate at
   the start - quote that. Say that a red gate gets a repair pass (`repair.attempts`, default 1),
   and a repair that turns it green a second review - more allowance, fewer red branches - and
   offer `USAGE_CHECK=1` if the plan is close to its limit. If the config sets `autonomy` (or the
   user asks for `AUTONOMY_LEVEL`), say how many further turns the run may take by itself. If `sandcastle queue`
   shows `Blocked by` chains and no autonomy is set, recommend `AUTONOMY_LEVEL=drain` (or `autonomy: "drain"`): it
   takes turns until the queue is drained or a stop holds (no progress, the same ticket conflicting twice running,
   a red base, a usage limit, 20 turns at most), so the chain does not need a `sandcastle run` per link. Say that the run first gates the base commit and stops if a
   gate is red there; if the project has never had a green `sandcastle gates`, run that first (no
   model calls) rather than finding out after the image build. Confirm before starting - a run
   comments on and closes tickets in the tracker (GitHub, or commits to ticket files) and merges into the base branch locally. A dry run
   (`DRY_RUN=1`) merges and closes nothing, and its agents are told to write nothing to the tracker.
2. **Start it detached, never in a pane or tab of your own** - it takes hours, and a command
   run as your own background task has a time cap, dies with your session and has no terminal.
   From the project root run `<env vars> sandcastle run --detach` (the same arguments as
   `sandcastle run`). It checks what a run checks (clean tree, no other run, autonomy level),
   starts the run as a process of its own that outlives this session, and returns once the run is
   going. A detached run cannot ask a question, so it refuses autonomy level 1: use 2, 3 or
   `drain`, or run it attached (below). Inside Herdr the run opens a tab of its own holding only
   the status view - never open a status view of your own, and expect no pane per sandbox (the
   sidebar carries the run). It prints:

   ```
   Run started detached (pid <pid>). Status view: pane <id> (tab <id>). Output: .sandcastle/logs/run-output.log. ...
   ```

   **Confirm that line.** Outside Herdr it says ``Status view: run `sandcastle status` ``. If the
   command refuses, or prints `The run ended at once`, or no status view where Herdr is in use,
   say so plainly to the user - do not carry on as if they can watch it. Tell the user the pid,
   and the tab and status pane ids. `.sandcastle/logs/run-output.log` is the run's own output;
   the status view's bottom shows its last lines while the run is live.

   For a user who wants the run in their own terminal, give them the attached command to run
   there (`sandcastle run`, plus `sandcastle status` in a second terminal); started from a
   person's terminal alone in a Herdr tab it adopts that tab.
3. **Arrange to hear when it ends.** In Claude Code with the kit's mod loaded - this text then
   ends with a note saying so - skip this step: the mod submits a prompt when the run's process
   is gone, and that prompt is your cue for step 4. The mod follows the run this session
   started wherever its project lives (a second clone, a package of a monorepo), by the session
   id the run records; a run that `--detach` refused gets no prompt, so step 2's check of the
   printed line still matters. With no such note, arrange it
   yourself: the detached run is not your own process, so your harness never tells you it
   finished. Right after starting it, run `sandcastle wait` as a background
   command your harness reports back on when it exits (`run_in_background` in Claude Code): it
   blocks while the run is live, then prints the closing summary and exits with the run's exit
   code. A harness caps a background command (Claude Code: 2 hours), so give it a timeout under
   the cap, `sandcastle wait 6600`: at the timeout it exits 124 with the run untouched, which
   is no result - start the same `sandcastle wait` again. `sandcastle stop` stops the run as
   Ctrl-C does; use it only when the user asks, and `sandcastle wait` then shows how it ended.
4. **Close the run - required, even mid-way through another request.** When the run ends, read
   run.md in this skill's directory (next to this file) and follow it before writing your closing
   message.

## status - what a run is doing

`sandcastle status 0` prints a snapshot; `sandcastle status` refreshes every 10 s (run it in a
separate pane or terminal). While a run is live, every ticket it holds is shown from the run's
own record (`.sandcastle/logs/run.json`, `tickets`), and the header counts add up to the run:
working, ready to land, need you, queued, blocked, merged. The states:

- **Working** - `setup`, `impl`, `review`, `codex`, `gates` (with the gate running, `2/7 pytest`,
  or `waiting for a gates slot`), `repair`, `landing`. AGE in red and `usually 5m` mean the step
  has taken twice its usual time; `quiet Nm` means an agent's log has been silent that long. Read
  the log before calling either hung.
- **`ready`** - gates green, waiting for the landing worker, which lands each ticket as it goes
  green while the others still run. Once every sandbox has finished, the `run` line counts what is
  left down (`landing 6/25`). `human merge: <paths>` means it will be held for a person instead.
- **Needs you** - `gate red`, `conflict`, `held`, `crashed`, `not landed`, `stopped` (finished,
  but the run stopped before landing), `orphaned` (its run was killed and its container still
  works: `sandcastle clean` stops it); the activity says why. `withdrawn` (closed, unqueued or
  marked `ready-for-human` during the run) is greyed with the leftovers.
- **`queued`** (next to start, or how many are ahead), **`blocked`** (what it waits for, and
  `(lands this run)` when the blocker is in this run - then this run starts it once the blocker
  lands - or `(not in this run)`), **`merged`**,
  **`no change`**, **`skipped`** (not started because the run stopped early).

After a run, or for a ticket outside it, the state is inferred from branches and logs: `left
over` is a branch from an earlier run, for `sandcastle clean`. Each ticket's agent and gate logs
are `.sandcastle/logs/agent-issue-<n>-*.log` (the `-gates-` one is the orchestrator's gate
output; each pass's raw stream - every tool call and result - is the `.jsonl` beside its `.log`, so read that to check a reviewer's claim); the last lines of a failed run's log hold the real cause (a usage limit usually reads as
a "trust dialog" error). The live view fits its pane and summarises the rows that do not fit on
one line (`sandcastle status 10 all` shows them all). How long each step took, and each agent
pass's tokens, is in `.sandcastle/logs/timings.jsonl`.

## update - bring the kit and this project up to date

Read update.md in this skill's directory (next to this file) and follow it.
