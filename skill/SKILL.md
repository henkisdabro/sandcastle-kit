---
name: sandcastle
description: "sandcastle-kit: unattended coding agents that burn down a repo's GitHub issues or ticket files in Docker sandboxes. Actions: init (set a project up - gates, lean sandbox, hooks checked), audit (review the repo with read-only agents, one per lens, and file what they find as issues ready to queue), queue (triage open issues into the agent queue with the user), run (start a burndown with its status view), status (what a run is doing, or how the last one ended: `sandcastle report`), update (pull the latest kit and bring this project up to date with it). Use for sandcastle, burndown, AFK agents, auditing a repo to build a backlog, queueing issues for agents, or updating or upgrading sandcastle-kit."
argument-hint: "[init|audit|queue|run|status|update]"
arguments: [action]
---

# Sandcastle

Requested action: `$action`

| Action | Does | Done when |
|---|---|---|
| `init` | Sets up the current project: config, rules, lean sandbox, hook decisions | The user has approved the config and it is committed |
| `audit` | Reviews the repo with read-only agents, one per lens, and files what they find as issues that meet the queue criteria, with the user | Every finding is filed, merged into another, or dropped with a stated reason, and the user has the table |
| `queue` | Triages every open issue into the agent queue, with the user | Every open issue is labelled, parked, or left with a stated reason |
| `run` | Starts a burndown in a tab of its own, and closes it with a summary | The run is live in its own tab and its status view is confirmed, or the user holds the exact command; when it ends, the user has the seven-section closing summary |
| `status` | Reports what a run is doing | The user has the snapshot and the cause of any failed row |
| `update` | Pulls the latest kit and brings the current project up to date with it | The kit is current, the project's image and hook check are clean, and every change that affects it is reported or applied |

With no action (blank, or the literal `$action` in a harness that does not fill it in), take it
from the user's request; if that names none either, run `sandcastle status 0` and suggest the
action that fits what it shows. When it shows no runs and `sandcastle queue` is empty, say so and
name the next step (file issues or ticket files for the work, then the `queue` action) rather than
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
   to see the tokens saved.
8. Commit `.sandcastle/config.ts`, `rules.md`, the Dockerfile and `.sandcastle/.gitignore` by the
   repo's own commit rules. `.sandcastle/.env` stays uncommitted.

Re-run `sandcastle lean` whenever the project adds skills, MCP servers or hooks. Every run repeats
the hook check and refuses to start while a kept hook cannot run.

## audit - find work and file it

Read audit.md in this skill's directory (next to this file) and follow it. It files issues by
the queue action's categories and its closed-spec test, so read the queue section below as well.

## queue - triage every open issue into the queue

The queue is the config's `label` (default `ready-for-agent`). A ticket gets it only when its
spec is **closed**: an unattended agent with no chat context can finish it from the issue and its
comments, and the gates can prove it.

0. **Which tracker?** `sandcastle queue` names it and why. `github`: use `gh` as below. `files`:
   tickets are `.scratch/<feature>/issues/<NN>-<slug>.md`; list them, write each decision under
   `## Comments`, and queue by setting `Status: <label>` (commit it). If the repo has
   `docs/agents/issue-tracker.md`, its conventions win. The kit reads that file (Matt Pocock's setup
   skill writes it) but does not need it.
1. **List every open issue**: `gh issue list --state open --limit 500 --json
   number,title,labels,updatedAt` (files: every ticket whose `Status:` is not done). If exactly 500
   come back, the list was cut off: raise `--limit` and list again. Already-queued issues get a quick sanity check only.
2. **Facts first.** Fan out read-only subagents, about seven issues each (without subagents, work
   through them in the same batches). Each reads the issue, its comments, the code it names,
   recent history, the repo's decision records (`docs/adr/` or similar), its label vocabulary
   (e.g. `docs/agents/triage-labels.md`), and any earlier decision or `PARKED:` comment - a
   recorded decision or revival condition is checked, not re-asked. Each returns per issue: the
   category below, the evidence, and for a decision the concrete question with options and a
   recommendation. Ask the user only what the code and history cannot answer.

   **Persist each result.** The chat can be compacted and the results lost; files survive it. So
   each subagent writes its result for each ticket, as soon as it has it, to
   `.sandcastle/triage/<id>.json` in the project (`<id>` is the issue number, or the ticket id for
   the files tracker; the directory is gitignored). Fields: `issue`, `category` (one of the table's
   rows), `evidence`, `triagedAt` (an ISO 8601 timestamp), and for a decision `question`, `options`
   (recommended first) and `recommendation`. A ticket that already has a file is not re-triaged
   unless the issue was updated after the file was written (the issue's `updatedAt` is later than
   the file's `triagedAt`). The subagents' file writes are the one exception to "no edits" in the
   brief below.

   Write the batch's issue numbers into the `Issues:` line before sending; never send a brief with
   a placeholder left in it.

   ```text
   Brief for each subagent
   You are triaging issues. Read-only: read files, search, run `git log`, `git show`, `git blame`,
   and `gh issue view N --json title,body,comments,updatedAt` (files tracker: read the ticket
   file). No edits (bar the triage file below), no commits, no tracker writes (no `gh issue
   comment`, `gh issue edit`, `gh issue close`, `gh issue create`, no `gh label`), and no
   `sandcastle run`, `preflight` or anything else that spends model allowance.
   Issues: <the batch's numbers>
   For each issue read: the issue and its comments, the code it names, recent history, the repo's
   decision records and label vocabulary, and any earlier decision or `PARKED:` comment.
   Classify each issue as exactly one of: ready, needs a decision, human-only, blocked by another
   issue, already fixed or false, epic or too big, parked.
   Return per issue: the number, the category, and the evidence with file:line. For a decision, add
   one self-contained question with 2-4 options, recommended first. For blocked, name the blocking
   issue. For too big, list the proposed child issues.
   Also write each result as soon as you have it to `.sandcastle/triage/<id>.json` (the only file
   you may write): `issue`, `category`, `evidence`, `triagedAt` (ISO 8601 now) and, for a
   decision, `question`, `options`, `recommendation`. Skip an issue whose file's `triagedAt` is
   later than the issue's `updatedAt`.
   ```

   | Category | Action |
   |---|---|
   | Ready - spec closed, provable by the gates | label now; add a short triage note if the issue is stale or half-fixed |
   | Needs a decision | ask (step 3) |
   | Human-only - console, device, secret, production, legal | `needs-human` (the kit's human label: a run never takes a ticket carrying it), with a comment saying why |
   | Blocked by another issue | label it, with a `Blocked by #N` line in the issue *body* (`gh issue edit`): a run skips it until #N is closed. A comment is not read. Write it as plain text: a line inside a code block or backticks is not read either. If the blocker is a Linear issue or an in-repo task file, name it (`Blocked by ENG-42`, `Blocked by tasks/0042-auth.md`) once the project's config has `blockers` for it (README -> Blockers); otherwise the line is ignored |
   | Already fixed or false | comment the evidence; ask before closing |
   | Epic or too big for one agent run | propose child issues; ask before creating them |
   | Parked | retitle `PARKED: ...` with the revival condition in a comment, after asking |

3. **Ask in batched rounds**, from the files in `.sandcastle/triage/`, with the harness's
   question tool (`AskUserQuestion` in Claude Code): up to four questions a round, grouped by
   theme. Each question stands alone - enough context to decide without opening GitHub, the issue
   link, the recommended option first. Continue until every decision is answered. An issue the
   user says needs a design discussion stays unlabelled, with that noted.
4. **Close the spec, then label.** Take each decision from its file, and record the user's answer
   in it as `answer`. Then comment the decision on the issue - the implementing agent reads the
   issue and its comments, never this chat - then add the queue label. Create a missing label with
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
   user asks for `AUTONOMY_LEVEL`), say how many further turns the run may take by itself. Say that the run first gates the base commit and stops if a
   gate is red there; if the project has never had a green `sandcastle gates`, run that first (no
   model calls) rather than finding out after the image build. Confirm before starting - a run
   comments on and closes tickets in the tracker (GitHub, or commits to ticket files) and merges into the base branch locally. A dry run
   (`DRY_RUN=1`) merges and closes nothing, and its agents are told to write nothing to the tracker.
2. **Start it in a tab of its own, never beside yourself** - it takes hours. In a terminal
   multiplexer you can drive (for example Herdr: `test "${HERDR_ENV:-}" = 1`):
   1. Create a tab without taking focus, at the repo root, in your own workspace: `herdr tab
      create --workspace "$HERDR_WORKSPACE_ID" --label "sandcastle <project>" --cwd <root>
      --no-focus`. Without `--workspace` Herdr uses the focused one, and the user may have moved
      to another workspace by then. Its root pane is the run pane: name it `herdr pane rename
      <pane> "sandcastle run <project>"`.
   2. Run `<env vars> sandcastle run` in that pane (`herdr pane run <pane> "..."`). Alone in its
      tab, the run adopts it: the status view opens beside it at once - before the image check,
      preflight and base gates - and one pane per sandbox follows, each reported to the agent
      sidebar (blocked means a human has to act). Never open a status view of your own: the kit
      opens exactly one.
   3. **Confirm the view exists** within a minute: the run pane prints `Status view: pane <id>`
      (`herdr pane wait-output <pane> --match "Status view:" --timeout 60000`), and `herdr tab get
      <tab>` shows more than one pane. If the line is missing, or the run printed "Could not open
      the status view", say so plainly to the user - do not carry on as if they can watch it.
   4. Tell the user the tab, the run pane and the status pane ids.

   Otherwise give the user the command to run in a second terminal, plus `sandcastle status` for
   a third.
3. **Arrange to hear when it ends.** A command handed to another pane is not your own process, so
   your harness never tells you it finished. Every run's last line is `sandcastle run ended (exit
   N)` - after the report, after a drained queue, after a crash or Ctrl-C. Right after starting
   it, start a background command your harness reports back on when it exits (`run_in_background`
   in Claude Code) that waits for that line in the run pane, for example `herdr pane wait-output
   <pane> --match "sandcastle run ended" --timeout <ms>`. Use a fresh pane per run - the wait also
   matches output already in the pane. Runs take hours; a timeout exits 1 with
   `{"error":{"code":"timeout"...}}`, which your harness reports as a failed task although the run
   is fine. That is not a result: check `.sandcastle/logs/run.json` (a `finishedAt` means it
   ended; no `finishedAt` and a live `pid` means it is still going) and, if it is still going,
   start the wait again. When the line arrives, read the report (`herdr pane read <pane> --source
   recent-unwrapped`) and tell the user.
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
- **`ready`** - gates green, lands when the run ends. Landing starts only once every sandbox has
  finished; the `run` line then counts it down (`landing 6/25`), and before that estimates when it
  starts (`lands ~16:20`). `human merge: <paths>` means it will be held for a person instead.
- **Needs you** - `gate red`, `conflict`, `held`, `crashed`, `not landed`, `stopped` (finished,
  but the run stopped before landing), `orphaned` (its run was killed and its container still
  works: `sandcastle clean` stops it); the activity says why. `withdrawn` (closed, unqueued or
  marked `needs-human` during the run) is greyed with the leftovers.
- **`queued`** (next to start, or how many are ahead), **`blocked`** (what it waits for, and
  `(this run)` when the blocker is in this run - then the next run can start it), **`merged`**,
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
