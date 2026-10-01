---
name: sandcastle
description: "sandcastle-kit: unattended coding agents that burn down a repo's GitHub issues in Docker sandboxes. Actions: init (set a project up - gates, lean sandbox, hooks checked), queue (triage open issues into the agent queue with the user), run (start a burndown with its status view), status (what a run is doing, or how the last one ended: `sandcastle report`), update (pull the latest kit and bring this project up to date with it). Use for sandcastle, burndown, AFK agents, queueing issues for agents, or updating or upgrading sandcastle-kit."
argument-hint: "[init|queue|run|status|update]"
arguments: [action]
---

# Sandcastle

Requested action: `$action`

| Action | Does | Done when |
|---|---|---|
| `init` | Sets up the current project: config, rules, lean sandbox, hook decisions | The user has approved the config and it is committed |
| `queue` | Triages every open issue into the agent queue, with the user | Every open issue is labelled, parked, or left with a stated reason |
| `run` | Starts a burndown in a tab of its own, and closes it with a summary | The run is live in its own tab and its status view is confirmed, or the user holds the exact command; when it ends, the user has the seven-section closing summary |
| `status` | Reports what a run is doing | The user has the snapshot and the cause of any failed row |
| `update` | Pulls the latest kit and brings the current project up to date with it | The kit is current, the project's image and hook check are clean, and every change that affects it is reported or applied |

With no action (blank, or the literal `$action` in a harness that does not fill it in), take it
from the user's request; if that names none either, run `sandcastle status 0` and suggest the
action that fits what it shows.

## Before every action

1. Run `sandcastle doctor`. Its first line is the kit's location; that kit's `README.md` covers
   anything this file does not. If `sandcastle` is not found, the kit is not installed: have the
   user clone it and run `./bin/sandcastle setup` in their own terminal (it asks for tokens).
2. Fix every `FIX` line doctor prints before going further. Tokens are the user's to create.

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
   really runs, then write `.sandcastle/rules.md` from those facts. The kit's `examples/` has two
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

   Write the batch's issue numbers into the `Issues:` line before sending; never send a brief with
   a placeholder left in it.

   ```text
   Brief for each subagent
   You are triaging issues. Read-only: read files, search, run `git log`, `git show`, `git blame`,
   and `gh issue view N --json title,body,comments` (files tracker: read the ticket file). No
   edits, no commits, no tracker writes (no `gh issue comment`, `gh issue edit`, `gh issue close`,
   `gh issue create`, no `gh label`), and no `sandcastle run`, `preflight` or anything else that
   spends model allowance.
   Issues: <the batch's numbers>
   For each issue read: the issue and its comments, the code it names, recent history, the repo's
   decision records and label vocabulary, and any earlier decision or `PARKED:` comment.
   Classify each issue as exactly one of: ready, needs a decision, human-only, blocked by another
   issue, already fixed or false, epic or too big, parked.
   Return per issue: the number, the category, and the evidence with file:line. For a decision, add
   one self-contained question with 2-4 options, recommended first. For blocked, name the blocking
   issue. For too big, list the proposed child issues.
   ```

   | Category | Action |
   |---|---|
   | Ready - spec closed, provable by the gates | label now; add a short triage note if the issue is stale or half-fixed |
   | Needs a decision | ask (step 3) |
   | Human-only - console, device, secret, production, legal | `needs-human` (the kit's human label: a run never takes a ticket carrying it), with a comment saying why |
   | Blocked by another issue | label it, with a `Blocked by #N` line in the issue *body* (`gh issue edit`): a run skips it until #N is closed. A comment is not read. If the blocker is a Linear issue or an in-repo task file, name it (`Blocked by ENG-42`, `Blocked by tasks/0042-auth.md`) once the project's config has `blockers` for it (README -> Blockers); otherwise the line is ignored |
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
   same checkout). Show the user the queue (`sandcastle queue`), the models, whether it is a dry run, and `sandcastle status 0`'s
   machine line (other projects' runs share the limits). Say that a red gate gets a repair pass
   (`repair.attempts`, default 1), and a repair that turns it green a second review - more
   allowance, fewer red branches - and offer `USAGE_CHECK=1`
   if the plan is close to its limit. Say that the run first gates the base commit and stops if a
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
4. **Close the run - required, even mid-way through another request.** Relaying the report is not
   the job; a hand-back the user can act on is. The run ends with a closing summary (`## 🏁 Run
   finished` down to `## 👉 Next step`); `sandcastle report` prints it again at any time, from the
   project root, with the blockers re-read and the local git state as it is now. Run it from the
   project root and take the summary from its own stdout, not from a pane scrape. Then write your
   closing message with **all seven sections, in this order, with these headings**, each one
   present and saying "none" when empty. Copy each `## ` heading **verbatim from what `sandcastle
   report` printed, emoji included** - retyping a heading is how the emoji get lost; the
   headings below are the ones it prints:

   1. `## 🏁 Run finished` - times, attempted, merged, need you, not started, tokens, and whether the
      merged base re-gated green. If it is **RED TOGETHER**, say so first and plainly: do not push.
   2. `## ✅ Done` - merged and closed, listed short. Next to the count, say that the issues are
      closed in the tracker but the code is only on the local base branch until pushed - the pair of
      facts operators most often misread.
   3. `## 🙋 Needs you` - each held branch: what it does in one line (read its diff), why it was
      held, its size, the review and merge commands, and anything that needs a decision.
   4. `## ❌ Needs fixing` - each red, conflicted, crashed or unlanded branch: the cause in one line,
      the file or test, whether it shares a cause with another, and the concrete fix path. The
      summary's `Same failing test` lines are likely one cause; its `Same file` lines are only a
      place to look - read both branches' failures before calling it one cause. For a red gate, read the gate log
      (`.sandcastle/logs/agent-issue-<n>-gates-<n>.log`) and the repair log's last lines; a gate
      run with `-x` shows only its first failure.
   5. `## ▶️ Runnable now / ⏳ Still blocked` - the unblocked list is computed after landing; for
      each still blocked, what it waits for and whether that blocker is itself held or red.
   6. `## 📤 Local state` - commits ahead of the upstream, branches left standing, kept worktrees,
      and the push that fits the repo's own shipping rules (read its AGENTS.md or CONTRIBUTING).
      Say plainly that Sandcastle pushed nothing.
   7. `## 👉 Next step` - **one** recommended action and why, then the short list after it, then
      **one** question where a human decision is needed (for example: "Three of the unmerged
      branches failed on the same test baseline. Raise it once (recommended), or trim the rules?").

   End by offering the natural follow-ups as things you can do next - fix a cause several branches share,
   requeue a failed issue with a note, start a run for the unblocked issues, `sandcastle clean`
   once branches are resolved, push under the repo's rules. Offer them; do none without a yes.

   Reading the summary: `held` branches were green but change hooks, CI or install scripts, or a
   person marked the ticket `needs-human` during the run; `held` with "no commits" is a ticket an
   agent handed back - it needs an answer, not a merge. `withdrawn` tickets were closed or
   unqueued during the run: someone's decision, nothing to fix. `not landed` means the branch moved
   after its gates or the merge failed for a reason other than a conflict. A run headed **Run
   STOPPED** merged nothing: it names what moved - for a moved base branch, show the user the
   commits it lists and ask whether they are theirs before offering a re-run; for a changed
   `.git/config` or `.git/info/`, stop and have them inspect it. A red gate whose repair made
   no commit usually means the repair agent judged the failure outside the branch - read the repair
   log and its issue comment, then check that gate with `sandcastle gates` before blaming the
   branch. A run that stops with "red on <base> before any agent ran" spent no allowance: the cause
   is the image, the setup, the lean plan or a hook test (`.sandcastle/logs/base-gates.log`). A dry
   run ends with `dry run held` or `DRY RUN BREACHED` - the latter means an agent wrote to the
   tracker; show the user what changed. Unmerged branches are cleared with `sandcastle clean
   --all` only after asking - their work is lost.

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
  works: `sandcastle clean` stops it); the activity says why. `withdrawn` (closed or unqueued
  during the run) is greyed with the leftovers.
- **`queued`** (next to start, or how many are ahead), **`blocked`** (what it waits for, and
  `(this run)` when the blocker is in this run - then the next run can start it), **`merged`**,
  **`no change`**, **`skipped`** (not started because the run stopped early).

After a run, or for a ticket outside it, the state is inferred from branches and logs: `left
over` is a branch from an earlier run, for `sandcastle clean`. Each ticket's agent and gate logs
are `.sandcastle/logs/agent-issue-<n>-*.log` (the `-gates-` one is the orchestrator's gate
output); the last lines of a failed run's log hold the real cause (a usage limit usually reads as
a "trust dialog" error). The live view fits its pane and summarises the rows that do not fit on
one line (`sandcastle status 10 all` shows them all). How long each step took, and each agent
pass's tokens, is in `.sandcastle/logs/timings.jsonl`.

## update - bring the kit and this project up to date

Every step is a check that is safe to repeat, so it does not matter which kit version the project
was set up with.

1. **The kit.** Its location is doctor's first line. If `git -C <kit> status --porcelain` shows
   local changes, stop and tell the user - never discard them. Otherwise
   `git -C <kit> pull --ff-only && pnpm -C <kit> install`, then `sandcastle doctor`. This skill is
   a link into the kit, so the pull may have changed it: re-read it before going on.
2. **What changed.** Read the kit's `CHANGELOG.md` - `[Unreleased]` and the releases since the
   last update, if the user knows when that was. Its **Upgrading** notes name what an existing
   project may act on.
3. **The project** (from its root, if it has `.sandcastle/config.ts`; otherwise stop after 2):
   1. `sandcastle build`, then `sandcastle lean` - new images, and the hook check against them.
      Fix a `HOOK FAIL` as in init step 4. Then `sandcastle gates` (no model calls): a new image
      can turn a gate red or green on base. Fix a red gate as in init step 6.
   2. **Config.** Compare `.sandcastle/config.ts` with the README's Configuration table. A field
      it leaves out takes the kit's default, so nothing breaks - but name every new default that
      changes what a run does or spends (the Upgrading notes list them) and ask whether to set it
      explicitly. Edit only what the user agrees to; never rewrite the config wholesale.
   3. **Gates.** Check they still match what CI runs; CI drifts. Run `sandcastle queue`: it names
      the tracker and queue label the kit chose (`docs/agents/` can change either). If that is not where this project's tickets live (a repo that
      moved to `.scratch/` files, or back), set `tracker` in the config.
   4. **Blocked issues recorded the old way.** Earlier triage left blocked issues with a "blocked
      by" comment, which runs do not read. Run `sandcastle blockers`: it lists open tickets - queued
      or not - whose comment names a blocker the body does not, and marks those whose blockers are
      all closed as stale. For each that is not stale, propose moving the line into the body as `Blocked by ...`
      (and, for an unlabelled issue, adding the queue label - only if its spec is otherwise closed,
      see queue). If the project tracks work in Linear or task files, check `blockers` in its
      config covers them. Apply after the user agrees.
   5. **Unproven guards.** If `sandcastle lean` warns that `PreToolUse` guards are kept with no
      `hookTests`, propose tests as in init step 4, then `sandcastle gates`.
   6. **Leftovers.** `git branch --list 'agent/*'` and `git worktree list`: if either holds
      entries no run is using, show them and offer `sandcastle clean` (never `--all` without a
      yes).
4. **Commit** any project file that changed, by the repo's own rules, and report: kit version
   before and after, what changed for this project, and what the user decided.
