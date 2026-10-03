# sandcastle audit - find work and file it

This continues SKILL.md: run its "Before every action" first. The audit files tickets by the queue
action's categories and its closed-spec test, so keep queue.md to hand.

1. **Costs.** The lenses run as subagents in the user's own session on the host - no sandbox, no
   `sandcastle run` - so they spend the user's interactive allowance. Say how many subagents will
   run and get a yes first.
2. **Scope, with the user** (the harness's question tool, `AskUserQuestion` in Claude Code).
   Ask:
   - Which lenses. Offer the ones that fit this repo: correctness bugs, security, tests (what the
     gates do not cover), performance, docs and developer experience (including docs that still describe behaviour the
     code has since changed: check each claim in the README, docs and agent files against the
     code), and accessibility and SEO
     only for a web front end.
   - Which areas (directories) are in or out.
   - A cap per lens (default 10 findings) and on tickets filed in total (default 25).
   - Which tracker: `sandcastle queue` names it.
3. **Read what is there** before any subagent starts: open tickets and those closed recently
   (GitHub: `gh issue list --state all --limit 500 --json number,title,state,labels`; files: every
   ticket file), the repo's label vocabulary (`gh label list`, `docs/agents/triage-labels.md` or
   similar), decision records, `CLAUDE.md` / `AGENTS.md`, and the gates in
   `.sandcastle/config.ts`. A finding is only ready when those gates can prove its fix.
4. **Fan out**: one read-only subagent per lens, in parallel (split a lens by area for a large
   repo; without subagents, run the lenses one after another). Write the lens and areas into the
   brief before sending; never send a brief with a placeholder left in it. Give each subagent the
   ticket list from step 3 as well.

   ```text
   Brief for each subagent
   You are auditing a repository for small, well-evidenced problems. Read-only: read files,
   search, run `git log`, `git show`, `git blame` and `gh issue view N`. No edits (bar your
   findings file below), no commits, no tracker writes (no `gh issue create`, `gh issue comment`,
   `gh issue edit`, `gh issue close`, no `gh label`), and no `sandcastle run`, `preflight` or
   anything else that spends model allowance.
   Lens: <the lens, e.g. security>
   Areas: <the directories to cover>
   Report at most <the cap> findings, most important first. Each must be small enough for one
   agent run and provable by the project's gates. Evidence is file:line. No style nits, no
   speculative rewrites, nothing already in the ticket list you were given.
   Per finding: `title` (imperative), `lens`, `area`, `severity`, `evidence` (file:line),
   `problem`, `fix`, `doneWhen` (a check the gates can run), `touches` (paths), `dependsOn`
   (another finding's title, optional), `confidence` (`high` or `medium`).
   Write each finding as soon as you have it to `.sandcastle/triage/audit/<lens>.json` (the only
   file you may write), as a JSON array.
   ```

   The files sit under `.sandcastle/triage/`, which `sandcastle init` ignores (an older project
   gets the line from the update action), so the results survive the chat being compacted.
5. **Merge and de-duplicate** from those files. Findings with the same root cause or the same
   file:line become one. A finding that matches an existing ticket is dropped, noting the ticket.
   Two findings that contradict each other, or one that contradicts a decision record, become a
   decision question: filing both is how contradictory tickets reach a run.
6. **Classify each** with the queue action's seven categories: ready, needs a decision,
   human-only, blocked by another ticket, already fixed or false, epic or too big, parked. Before
   calling one ready, read its cited lines yourself: a subagent's claim is not evidence until
   checked. Split one that is too big into children that are each ready.
7. **Ask in batched rounds** as the queue action does: up to four questions a round, each
   standalone, the recommended option first. Ask the decisions, and keep-or-drop for
   `medium`-confidence findings.
8. **Cluster findings that touch the same files**, before the filing list. One ticket per finding
   born overlapping makes a queue whose tickets all want the same few files.
   - Group the findings by shared `touches` paths (a directory covers everything under it, a glob
     its matches).
   - Where three or more small findings share most of their files, propose **one ticket per file
     cluster** instead: the findings become its checklist, and its `doneWhen` is the checks of all
     of them. Name the findings each cluster merges.
   - Where findings must stay separate (too big together, or different gates prove them), say
     which edges are real dependencies - one cannot be done without the other - and which only
     order overlapping work. Only a real dependency becomes a blocker line. Write no
     order-only blocker line: a run lands overlapping branches in turn, and a blocker line makes
     the second wait until the first has landed.
   - Where the findings cannot share a ticket, keep their `touches` accurate: the kit reads them
     to warn of tickets that will meet at landing.
9. **Show the filing list** - title, lens, severity, touches, what it waits for, queued or not,
   with each cluster from step 8 shown as one row naming the findings it merges and the edges
   called real or order-only - and get the user's yes before filing anything: filing writes to the
   tracker. The user can split a cluster back into its findings.
10. **File in dependency order**, so a blocker exists (and has its number) before what waits on
    it. Write each body by queue.md's "Writing a ticket body" - its blocker line, `Touches:` line
    and evidence rules.
    - GitHub: `gh issue create --title ... --body-file <temp file>`. The body has `## Problem`,
      `## Evidence`, `## Fix` and `## Done when`, a `Touches:` line, and a blocker line.
    - Apply only labels that already exist in the repo's vocabulary (area, severity). Create none
      except the queue label (`gh label create`, as the queue action does).
    - A ready or decided finding gets the queue label. Human-only, parked and declined findings
      are filed only when the user asks.
    - Files tracker: write `<dir>/audit-<YYYYMMDD>/issues/<NN>-<slug>.md` (`<dir>` is the
      tracker's, default `.scratch`; take the date from your own context, not from a shell
      command) with a `# ` title, a `Status: <label>` line for queued ones, and a `Blocked by: NN`
      header line for a blocker in the same feature. Then commit them in one commit by the repo's
      rules.
    - Record each filed number or path in its finding's file (`filed`).
11. **Report**: a table of what was filed (number, title, queued or not), merged, and dropped with
    the reason. The next step is `/sandcastle run`, or `/sandcastle queue` for anything filed
    unqueued.
