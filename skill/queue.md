# sandcastle queue - triage every open ticket into the queue

This continues SKILL.md: run its "Before every action" first.

The queue is the config's `label` (default `ready-for-agent`). A ticket gets it only when its
spec is **closed**: an unattended agent with no chat context can finish it from the ticket and its
comments, and the gates can prove it.

0. **Which tracker?** `sandcastle queue` names it and why. `github`: use `gh` as below. `files`:
   tickets are `<dir>/<feature>/issues/<NN>-<slug>.md` (`dir` is the tracker's, default
   `.scratch`); list them, write each decision under `## Comments`, and queue by setting
   `Status: <label>` (commit it). If the repo has `docs/agents/issue-tracker.md`, its conventions
   win. The kit reads that file (Matt Pocock's setup skill writes it) but does not need it.
1. **List every open ticket**: `gh issue list --state open --limit 500 --json
   number,title,labels,updatedAt` (files: every ticket whose `Status:` is not done). If exactly 500
   come back, the list was cut off: raise `--limit` and list again. Already-queued tickets get a
   quick sanity check only.
2. **Facts first.** Fan out read-only subagents, about seven tickets each (without subagents, work
   through them in the same batches), with the brief below. Ask the user only what the code and
   history cannot answer: a recorded decision or `PARKED:` revival condition is checked, not
   re-asked.

   Each subagent persists its results to `.sandcastle/triage/<id>.json` in the project (`<id>` is
   the ticket number, or the ticket id for the files tracker; the directory is gitignored), so
   they survive the chat being compacted. A ticket whose file is newer than its last update is
   not triaged again. Write the batch's ticket numbers into the `Tickets:` line before sending;
   never send a brief with a placeholder left in it.

   ```text
   Brief for each subagent
   You are triaging tickets. Read-only: read files, search, run `git log`, `git show`, `git blame`,
   and `gh issue view N --json title,body,comments,updatedAt` (files tracker: read the ticket
   file). No edits (bar the triage file below), no commits, no tracker writes (no `gh issue
   comment`, `gh issue edit`, `gh issue close`, `gh issue create`, no `gh label`), and no
   `sandcastle run`, `preflight` or anything else that spends model allowance.
   Tickets: <the batch's numbers>
   For each ticket read: the ticket and its comments, the code it names, recent history, decision
   records (`docs/adr/`), label vocabulary, and any earlier decision or `PARKED:` comment.
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
   | Blocked by another ticket | label it, with a blocker line in the ticket body (see "Writing a ticket body"): a run skips it until the blocker is closed |
   | Already fixed or false | comment the evidence; ask before closing |
   | Epic or too big for one agent run | propose child tickets; ask before creating them. A spec split into child tickets is not queued itself - a run would implement the whole spec as one ticket beside its children - and a spec published by `/to-spec` comes already labelled, so take the label off (`sandcastle queue` and `queue --lint` warn about a queued parent that a queued child names under `## Parent`) |
   | Parked | retitle `PARKED: ...` with the revival condition in a comment, after asking |

3. **Ask in batched rounds**, from the files in `.sandcastle/triage/`, with the harness's
   question tool (`AskUserQuestion` in Claude Code): up to four questions a round, grouped by
   theme. Each question stands alone - enough context to decide without opening GitHub, the ticket
   link, the recommended option first. Continue until every decision is answered. A ticket the
   user says needs a design discussion stays unlabelled, with that noted.
4. **Close the spec.** Take each decision from its file, and record the user's answer in it as
   `answer`. Then comment the decision on the ticket - the implementing agent reads the ticket and
   its comments, never this chat - and put it in the body where the body states the requirement.
5. **Cold read.** A ticket that step 2 called ready, or that a decision just made ready, and whose
   body was written or changed in this session (by this action or by the audit), gets one cold read
   after step 4 and before the queue label goes on. Step 2's subagent has read the code and the
   history, so it fills a ticket's gaps from what it learned; the implementer will not have that.
   A ticket already queued, or not updated since its cold read, is not read again: the file's
   `coldRead.at` is later than the ticket's `updatedAt`, as in step 2.
   - **Who.** A fresh read-only subagent given only the final ticket body and comments (paste
     them in) - not step 2's notes, the evidence found, or any explanation. It may read the repo,
     as the implementer will. Without subagents, do the step yourself and say plainly that it is
     not an independent read: the context you hold is the context the implementer lacks.
   - **What it returns.** Only readings of the ticket that differ materially and that its
     acceptance checks would not tell apart, each with the check that would. It flags a missing
     decision, a contradiction, or a prerequisite the agent could not reach (a secret, a service,
     a file that is not in the repo). Ordinary code discovery - where a function lives, how a test
     is written - is the implementer's job, not a gap. It never picks the requirement itself.
   - **What happens next.** Each ambiguity goes back through step 3 as a decision question with
     the readings as its options, and the answer through step 4. Read once: do not read the
     answers cold again. A contradiction or an unreachable prerequisite the user cannot settle is
     not ready: the hold label, as in step 2's table.
   - **Measuring the trial.** Write the read into the ticket's triage file as `coldRead`: `at`
     (ISO 8601 now), `by` (`subagent` or `harness`), `finds` (each with its `kind`: `decision`,
     `contradiction` or `prerequisite`) and, per find, what the user did (`answered`, `dismissed`
     as a false alarm, or `held`). A later review weighs the real catches against the false
     alarms and the time. Set `at` again after the label goes on: the label is an update to the
     ticket, and must not make the read look stale.

   ```text
   Brief for the cold reader
   You are the agent that will implement this ticket alone, with no chat and no one to ask. Read-only:
   no edits, no commits, no tracker writes, and no `sandcastle run`, `preflight` or anything else
   that spends model allowance. The ticket and its comments follow; you have been told nothing else.
   Find where two reasonable implementations would meet different readings of it: outcomes that
   differ materially and that the ticket's acceptance checks would not tell apart. For each, say
   what the two outcomes are and the check that would tell them apart.
   Flag only: a missing decision, a contradiction, or a prerequisite you could not reach. Where
   something is in the code, find it - that is not a gap. Never choose the requirement yourself.
   Return the list, or "none".
   <the final ticket body and comments>
   ```
6. **Label.** Add the queue label. Create a missing label with
   `gh label create`. This holds for every label this action applies, not the queue label alone:
   before applying a role's label (`needs-info`, the hold label, `wontfix`, or what
   `docs/agents/triage-labels.md` maps it to), check it exists (`gh label list --search <name>`)
   and create a missing one with `gh label create`, using the mapping's meaning for that role as its
   description - `gh issue edit --add-label` fails on a label GitHub does not have. The files
   tracker has no labels to create: a status is just text. A hard ticket can carry
   `model:`/`effort:` labels (GitHub) for a stronger implementer; offer it, and add it only on a
   yes.
7. **Report**: a table of what was labelled, what was decided, and what was left and why, built
   from the files in `.sandcastle/triage/`. Add the queue's shape from `sandcastle queue --lint`
   (read-only, no model calls; give it the ticket numbers the run will name, if it is limited to some,
   and it lints those alone): the longest `Blocked by` chain, edges that only order overlapping
   `Touches:`, wide tickets, tickets to consider splitting (large by the estimate's size rule),
   hot and unmergeable files, `Touches:` paths missing from the base
   branch (a plain path: a new file said to be new under `## Fix`, or a typo; a glob matching no file
   orders nothing, so name the new files themselves or fix the glob), and a rough turn count. It is advice, so
   quote it as a guess and offer to trim a chain or a `Blocked by` edge it flags.
   A ticket it lists under protected paths will always be held for a human merge: say so, and offer
   to unqueue it (or to leave the protected file to the user) rather than spend a pipeline on it.
   A ticket it suggests splitting is one pass the estimate prices as large: offer child tickets, as
   in the triage table above, and ask before creating them.

## Writing a ticket body

Whenever this action or the audit writes or rewrites a ticket body, the run reads these lines
from it, and only in plain text: a line inside a code block or backticks is not read.

- **Blocker line.** GitHub: a native "blocked by" edge holds a ticket as a body line does, so either is enough; otherwise `Blocked by #12, #14` in the ticket *body* (`gh issue edit`), with the
  refs on the same line (a colon after `Blocked by` is read too: `Blocked by: #12, #14` works) - a
  list under a "Blocked by" heading (`## Blocked by`, then `- #12`) is not read, nor is a comment.
  Files tracker: a `Blocked by: NN, NN` line in the ticket's header block, next to `Status:`,
  naming tickets in the same feature by number. A Linear issue or an in-repo task file can be
  named (`Blocked by ENG-42`, `Blocked by tasks/0042-auth.md`) once the project's config has
  `blockers` for it (README -> Blockers); otherwise the line is ignored.
- **`Touches:` line.** One line, `Touches: <path or glob>, <path or glob>, ...`, with
  repo-relative paths and `*` (within a directory) or `**` (across directories) globs. A
  directory path covers everything under it. Name only files an agent may edit under the
  project's rules: a file the rules forbid (a changelog the maintainer writes, say) is no ticket's,
  and listing it makes a false overlap line at the run's start. Write an existing file's path as
  it is. Name a file the fix will create too, and list a lockfile or generated file if the fix
  will rewrite it. Mark a new file as new in the ticket's prose (under `## Fix`), never on the
  `Touches:` line, where "(new)" would be read as part of the path. A second `Touches:` line is
  merged into the first. It goes in the body as a bare line, without the backticks shown here.
  Example: `Touches: src/pages/pricing.tsx, src/components/**/*.tsx, public/pricing.css`. The kit
  reads it as a scheduling hint and a warning of tickets that will meet at landing, never as a
  limit on what the agent may change.
- **Evidence.** A run opens no pull request: ask for evidence (a failing test's output, say) in
  the agent's final message or a ticket comment, never "in the PR description".
- **Seams.** For a behaviour change whose test boundary is not obvious, add a `## Seams` section
  naming the caller-visible interface a test should drive; prefer an existing one. Ask the user
  only when two interfaces would give materially different tests. The run does not read it; its
  agents do.
