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
   implementer; offer it, and add it only on a yes.
5. **Report**: a table of what was labelled, what was decided, and what was left and why, built
   from the files in `.sandcastle/triage/`. Add the queue's shape from `sandcastle queue --lint`
   (read-only, no model calls): the longest `Blocked by` chain, edges that only order overlapping
   `Touches:`, wide tickets, hot and unmergeable files, and a rough turn count. It is advice, so
   quote it as a guess and offer to trim a chain or a `Blocked by` edge it flags.
   A ticket it lists under protected paths will always be held for a human merge: say so, and offer
   to unqueue it (or to leave the protected file to the user) rather than spend a pipeline on it.

## Writing a ticket body

Whenever this action or the audit writes or rewrites a ticket body, the run reads these lines
from it, and only in plain text: a line inside a code block or backticks is not read.

- **Blocker line.** GitHub: `Blocked by #12, #14` in the ticket *body* (`gh issue edit`), with the
  refs on the same line - a list under a `Blocked by:` heading is not read, nor is a comment.
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
