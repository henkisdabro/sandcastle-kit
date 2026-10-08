---
name: sandcastle
description: "sandcastle-kit: unattended coding agents that burn down a repo's GitHub issues or ticket files in Docker sandboxes. Actions: init (set a project up - gates, lean sandbox, hooks), audit (review the repo with read-only agents and file what they find as tickets), queue (triage open tickets into the agent queue with the user), run (start a burndown and close it with a summary), status (what a run is doing, or how the last one ended), pause (hold a live run without losing work), resume (carry a paused run on), update (pull the latest kit and bring this project up to date). Use for sandcastle, burndown, AFK agents, pausing or resuming a run, auditing a repo to build a backlog, queueing tickets for agents, or upgrading sandcastle-kit."
argument-hint: "[init|audit|queue|run|status|pause|resume|update]"
arguments: [action]
---

# Sandcastle

Requested action: `$action`

| Action | Does | Done when |
|---|---|---|
| `init` | Sets up the current project: config, rules, lean sandbox, hook decisions | The user has approved the config and it is committed |
| `audit` | Reviews the repo with read-only agents, one per lens, and files what they find as tickets that meet the queue criteria, with the user | Every finding is filed, merged into another, or dropped with a stated reason, and the user has the table |
| `queue` | Triages every open ticket into the agent queue, with the user | Every open ticket is labelled, parked, or left with a stated reason |
| `run` | Starts a burndown detached, waits for it with `sandcastle wait`, and closes it with a summary | The run is live and its printed status view is confirmed, or the user holds the exact command; when it ends, the user has the closing summary: the seven sections, unless they asked for a short hand-back |
| `status` | Reports what a run is doing, or how the last one ended | The user has the snapshot and the cause of any failed row |
| `pause` | Holds the live run at the next safe juncture, so no new ticket or agent pass starts and no work is lost; a hold is a pause, never a `stop` | The user knows the run is paused, what is still finishing, and how to resume (or that no run is live) |
| `resume` | Carries a paused run on, in the same run | The status view no longer reads PAUSED (or the user knows why there was nothing to resume) |
| `update` | Pulls the latest kit and brings the current project up to date with it | The kit is current, the project's image and hook check are clean, and every change that affects it is reported or applied |

With no action (blank, or the literal `$action` in a harness that does not fill it in), take it
from the user's request; if that names none either, run `sandcastle status 0` and suggest the
action that fits what it shows. When it shows no runs and `sandcastle queue` is empty, name the
next step: the `audit` action to find work, or file tickets (GitHub issues or ticket files) and
then the `queue` action. A request to change a project's models or effort is answered by run.md's
"Models and effort".

## Before every action

1. Run `sandcastle doctor`. Its first line is the kit's location; that kit's `README.md` covers
   anything this skill does not. If `sandcastle` is not found, the kit is not installed: have the
   user clone it and run `./bin/sandcastle setup` in their own terminal (it asks for tokens).
2. Fix every `FIX` line doctor prints before going further, and mention each `warn` line to the
   user. Tokens are the user's to create. When a run or preflight fails on auth,
   `sandcastle doctor --verify` asks GitHub and Anthropic whether the tokens are accepted (no
   model call).

**Where things are written.** The kit is shared by all the user's projects and may be public, so
its files (this skill, the README, prompts) stay generic. Project facts go in the project's
`.sandcastle/`; the user's preferences go in their memory.

**Costs.** `sandcastle run`, `sandcastle preflight` and `sandcastle lean --measure` call the model
and spend the user's plan allowance or API credits. Say so and get a yes before running them.

## init - set up a project

Read init.md in this skill's directory (next to this file) and follow it.

## audit - find work and file it

Read audit.md in this skill's directory and follow it. It files tickets by the queue action's
categories and closed-spec test, so read queue.md as well.

## queue - triage every open ticket into the queue

Read queue.md in this skill's directory and follow it.

## run - start a burndown

Read run.md in this skill's directory and follow it, from the first step to closing the run.

## status - what a run is doing

Read status.md in this skill's directory and follow it.

## pause - hold a live run

Read pause.md in this skill's directory and follow its "pause" part. It also says which requests
mean a pause and which mean `sandcastle stop`: read "Pause, not stop" first.

## resume - carry a paused run on

Read pause.md in this skill's directory and follow its "resume" part.

## update - bring the kit and this project up to date

Read update.md in this skill's directory and follow it.
