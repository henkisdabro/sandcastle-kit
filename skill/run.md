# sandcastle run - start a burndown and close it

This continues SKILL.md: run its "Before every action" first.

1. **Check, tell, confirm.** Done when the user has said yes to the exact command, or holds it to
   run themselves.
   - **The tree.** `git status --porcelain` empty, the base branch checked out, and
     `git log --oneline -5` plus `git reflog -5` look as expected (another session may be using
     the same checkout).
   - **The base gates.** Every run gates the base commit first and stops if a gate is red there.
     If the project has never had a green `sandcastle gates`, run that first (no model calls)
     rather than finding out after the image build.
   - **Label lag.** After labelling tickets on GitHub (or a `sandcastle requeue`), give GitHub a
     few seconds before `sandcastle run`: its label search can lag, and a run started at once may
     miss them.

   Then tell the user, before asking:
   - **What runs.** The queue (`sandcastle queue`) and the models: a ticket whose label sets its
     own implementer shows `[implement <model>/<effort>]` after its title there ("Models and
     effort" below has the order). Whether it is a dry run: `DRY_RUN=1` merges and closes nothing,
     and its agents are told to write nothing to the tracker.
   - **What it writes.** A run comments on and closes tickets in the tracker (GitHub, or commits
     to ticket files) and merges into the base branch locally.
   - **The base is the run's.** Until the run ends, nobody commits, pulls or merges on the base
     branch in this checkout (use another worktree): the `.git` guard cannot tell a person's commit
     from a sandbox's, so a base that moves mid-run stops the run - pipelines in flight finish,
     nothing more lands, and the tokens they spent wait for a re-run. The run's start line says the
     same. Check `sandcastle status 0` (is a run live?) before any git write to the base in that
     checkout, yours included. Another worktree shares `.git/config`, which the guard reads by key:
     an upstream for your own branch there (`git worktree add ... origin/<x>`, `git push -u`,
     `git branch -u`, `gh pr create` from a local branch) is let through with one line, but any other
     change stops the run - a remote, a hook path, an `include`, a `rebase` or `pushRemote` setting,
     or an upstream on the base or an `agent/issue-*` branch.
   - **What it spends.** A red gate gets a repair pass (`repair.attempts`, default 1), and a
     repair that turns it green a second review - more allowance, fewer red branches. `sandcastle usage`
     prints the plan's usage now, read-only (never a script of your own against `src/usage.ts`). Offer
     `USAGE_CHECK=1` if the plan is close to its limit (it applies only when the sandboxes spend
     `CLAUDE_CODE_OAUTH_TOKEN`, and with `ANTHROPIC_API_KEY`, alone or beside it, it says it does not apply; it reads usage
     with the host's Claude Code login, read-only, else that token; a `claude setup-token` token gets
     HTTP 403 and cannot use the guard, and `sandcastle doctor --verify` shows which credential it
     would use and whose plan that is). Or `USAGE_PAUSE=90`, which has the run pause itself when a
     plan window reaches that percent and resume by itself after the window's reset (a pause a person can
     end with `sandcastle resume`); it reads the agents' own readings, so it needs no credential.
   - **API credits.** If `sandcastle doctor` prints a `warn API credits` line, an
     `ANTHROPIC_API_KEY` (in the personal or the project `.env`) reaches the sandboxes, and Claude
     Code spends it before any `CLAUDE_CODE_OAUTH_TOKEN`: the run bills API credits, not the plan.
     Say so, naming the file the line names, before asking for the yes, and offer the other way:
     removing the key. The run itself asks, or with no terminal refuses without `--api-key`; add
     `--api-key` (or `SANDCASTLE_API_KEY=1`) only when the user has said yes to billing API credits
     in so many words - a yes to the run is not that yes. `sandcastle preflight` and
     `sandcastle lean --measure` ask the same.
   - **The machine.** `sandcastle status 0`'s machine line: other projects' runs share the limits.
     When it shows another run live (its slots in use), say that the start prints a line on how
     the machine is split - the other run's slots and demand, this run's share and a rough wait
     for its first slot (an older kit's run is named as one that ignores shares). The split
     applies by itself and asks nothing; quote that line once the run has printed it.
   - **Turns.** If the config sets `autonomy` (or the user asks for `AUTONOMY_LEVEL`), say how
     many further turns the run may take by itself. Tickets shown `[waits for ...]` form a chain,
     and a chain whose links are all queued drains in one run: each ticket starts once its last
     blocker lands with its work done (a close the tracker refuses holds nothing back). With no autonomy set, recommend `AUTONOMY_LEVEL=drain` (or
     `autonomy: "drain"`) when the queue may need further turns - a ticket that conflicts twice
     in one run, and the tickets waiting on it. Each later turn runs only the tickets the turn
     before left conflicted, released or partly done (still queued); a red ticket is not run again, and a ticket queued after
     the run started waits for the next `sandcastle run`. A drain stops when no ticket is left to
     run again or a stop holds: no progress, the same ticket conflicting or left partly done in two
     turns running, a red merged base, a usage limit or a stopped run, 20 turns at most.
   - **How long.** Once the project has run before, the run prints a rough estimate at its start
     (detached: in `.sandcastle/logs/run-output.log`). After `--detach` returns (step 2), read the
     log once for the line starting `Estimate` and quote it, as the only estimate you give. Do not
     poll for it or sleep and grep: if it is not there yet (the run is still setting up, or the
     project has no history to estimate from), tell the user so, give no estimate of your own, and
     carry on with step 3; the status view's bottom shows the log's last lines, and a later
     question can read the log again.
2. **Start it detached.** It takes hours, and a command run as your own background task has a time
   cap, dies with your session and has no terminal - so from the project root run
   `<env vars> sandcastle run --detach` (the same arguments as `sandcastle run`), never in a pane
   or tab of your own. It checks what a run checks (clean tree, no other run, autonomy level),
   starts the run as a process of its own that outlives this session, and returns once the run is
   going. A detached run cannot ask a question, so it refuses autonomy level 1: use 2, 3 or
   `drain`, or run it attached (below); and it refuses a run that would bill API credits unless
   given `--api-key`, which only the user's own yes to that (step 1) allows. Inside Herdr the run opens a tab of its own holding only
   the status view (or reuses the status pane an earlier run left, wherever it now is), which is the one status view; expect no pane per sandbox unless the config
   sets `herdr.panes: "all"` (the sidebar carries the run). It prints:

   ```
   Run started detached (pid <pid>). Status view: pane <id> (tab <id>). Output: .sandcastle/logs/run-output.log. ...
   ```

   **Confirm that line.** Outside Herdr it says ``Status view: run `sandcastle status` ``. If the
   command refuses, prints `The run ended at once`, or names no status view where Herdr is in use,
   tell the user plainly that there is no run to watch. Otherwise tell them the pid, and the tab
   and status pane ids. `.sandcastle/logs/run-output.log` is the run's own output; the status
   view's bottom shows its last lines while the run is live.

   For a user who wants the run in their own terminal, give them the attached command to run
   there (`sandcastle run`, plus `sandcastle status` in a second terminal); started from a
   person's terminal alone in a Herdr tab it adopts that tab.
3. **Arrange to hear when it ends.** In Claude Code with the kit's mod loaded - the mod appends a
   note saying so to the end of the sandcastle skill's own text (SKILL.md), not to this file, so
   look for it there; a note seen earlier in the session still holds after the conversation is
   compacted, even when it is no longer in view - skip this step: the mod submits a prompt when
   the run's process is gone, and that prompt is your cue for step 4. It follows the run this session started
   wherever its project lives (a second clone, a package of a monorepo), by the session id the
   run records; a run that `--detach` refused gets no prompt, so step 2's check still matters. A
   paused run (pause.md) is still live, so the mod sends no end prompt until the run ends: silence
   during a pause is not a sign it has stopped.

   With no such note in SKILL.md's text (and none seen earlier in the session), the detached run
   is not your own process, so your harness never tells you it finished. Right after starting it, run `sandcastle wait` as a background command your
   harness reports back on when it exits (`run_in_background` in Claude Code): it blocks while the
   run is live, then prints the closing summary and exits with the run's exit code (1 when the merged base ended red: do not push it). A harness caps
   a background command (Claude Code: 30 minutes by default, 2 hours at most - pass
   `timeout: 7200000`), so give it a timeout under that cap, `sandcastle wait 6600`: at the
   timeout it exits 124 with the run untouched, which is no result - start the same
   `sandcastle wait` again. N is how long `sandcastle wait N` waits for the run to end; once it
   has ended, `wait` reads the tracker again to print the closing summary, which takes longer with
   many blocked tickets, so the harness's own timeout needs room above N. `sandcastle stop` stops the run as Ctrl-C does; use it only when the
   user asks, and `sandcastle wait` then shows how it ended. To hold the run without losing work
   (the user needs the machine or their plan allowance), `sandcastle pause` stops new tickets and
   agent passes at the next safe juncture and `sandcastle resume` carries on in the same run; only
   when the user asks (pause.md), and `sandcastle wait` keeps waiting through a pause.
4. **Close the run - required, even mid-way through another request.** Relaying the report is not
   the job; a **hand-back** the user can act on is. Read "How landing reads" and "Reading the
   summary" below before writing it.

   The run ends with a closing summary (`## 🏁 Run finished` down to `## 👉 Next step`);
   `sandcastle report` prints it again at any time, with the blockers re-read and the local git
   state as it is now. Run it from the project root and take the summary from its own stdout, not
   from a pane scrape. The mod's end prompt names the run that ended by its pid and start time
   (`pid 4242, started 14:05`). When the report prints a run that started at another time, or says
   `still running`, the named run was replaced by a later one in the same project, which the
   report now shows: do not close that one. Close the named run from its own closing summary - the
   newest `.sandcastle/logs/archive/run-output-*.log` for a detached run (the file is renamed there
   when the next detached run starts), or its line in `.sandcastle/logs/history.jsonl` - say in the
   hand-back that it was replaced, and leave the live run to the end prompt of its own. With `autonomy` set, one `sandcastle run` can hold several turns, each
   printing its own closing summary, and `sandcastle report` (like `sandcastle wait`) shows the
   last one's, which carries what the earlier turns left for a person: their held branches,
   partly done remainders, checks by hand, gaps and follow-ups, each line ending `(turn N)`, with
   their steps under Next step and in the headline's counts (a ticket a later turn ran again shows
   only its latest ending). A turn the loop goes on from says so in one line instead of its steps.
   The earlier turns' other lines (what they merged, the `Autonomy level` lines) are in the run's
   output only (`.sandcastle/logs/run-output.log` for a detached run). At level `drain`, near its end is
   `Drain: <N> turns, <landed> landed, stopped because <cause>`, then a line for each ticket
   queued after the run started: quote the cause and name those tickets in the hand-back.

   **A shorter hand-back, when the user asked for one.** If the user has asked for a short or plain
   hand-back - in this conversation, or as a standing preference in their own memory or
   instructions - that request wins over the seven sections below. Write the short form: it keeps,
   in this order, (1) anything the `## 🏁 Run finished` section says must come first - RED TOGETHER
   and "do not push", a red merged base, a run that ended early, was stopped or was killed; (2) one
   line for each item that needs the person, from Needs you and Needs fixing; (3) that nothing was
   pushed; (4) the one recommended next step and the one question. It ends with one line offering
   the full seven sections. The seven sections stay the default when nothing was asked.

   Otherwise write your closing message with **all seven sections, in this order, with these
   headings**, each one present and saying "none" when empty. Copy each `## ` heading **verbatim
   from what `sandcastle report` printed, emoji included** - retyping a heading is how the emoji
   get lost; the headings below are the ones it prints (without the emoji when NO_COLOR is set):

   1. `## 🏁 Run finished` - times, attempted, merged, need you, not started, tokens, and whether the
      merged base re-gated green, and on which image (or that it was green at that commit already, with the
      ticket or check whose gates proved it, so the end-of-run gates were not run again). If it is **RED TOGETHER**, say so first and plainly: do not push. If the line instead says it is red on the tree a ticket's own gates passed, the sandbox differs (git identity, environment), not the merge; if it says the tree's landing gates passed in a clean sandbox, a test is likely flaky or order-dependent: say which, and still do not push.
      If the line says the re-gate ran on the run's starting image because a merged ticket changed a
      Dockerfile, relay that: the new image is untested until it is rebuilt and `sandcastle gates` is green.
      If it reads `ended early`, `ended without a clean exit` (a crash, a killed process) or
      `stopped by` (`sandcastle stop`, Ctrl-C: a person ended it), say that first: the summary is partial, and the tickets it cut short are listed
      under Runnable now for the next `sandcastle run` to pick up.
      Under it, the `Settings:` line names the run's settings, a `Plan usage at the end:` line
      (a run on a subscription) gives the plan's 5-hour and weekly usage as the last agent
      reported it, a `Codex plan usage at the end:` line (a cross-review run on a ChatGPT plan)
      gives Codex's the same way, and a line after them may name the switch that would have helped
      (`AUTONOMY_LEVEL=2` for a level-0 run that left tickets it could run again; a usage guard
      that had no reading, so the run was not guarded): relay them unchanged, and name only the
      switch the report names.
   2. `## ✅ Done` - merged and closed, listed short. Next to the count, say that the tickets are
      closed in the tracker but the code is only on the local base branch until pushed - the pair of
      facts operators most often misread. When it lists `Changelog lines the agents suggested`
      (the project has `changelog: true`), carry those lines into your message, grouped Added,
      Changed, Fixed: the project keeps agents out of its changelog, so the user writes the entries from
      them. A block headed `Upgrading notes` is what an existing project must act on: keep it apart,
      never among the changes. The summary shows only the last run's lines: for a release's changelog, `sandcastle report
      --changelog [--since <ref>]` lists the lines of every ticket that landed since a ref (default: the
      latest tag) across runs, and the landed tickets that have none. A `Landed on a second attempt` line names the tickets the run sent back
      once after a conflict (at landing, or found before its review or gates) or a red gate at landing and then merged: say so, as it is the reason a
      ticket's work took two passes.
   3. `## 🙋 Needs you` - each held branch: what it does in one line (read its diff), why it was
      held, its size, the review and merge commands, the criterion an agent left unmet if the line
      names one (`sandcastle land` leaves that ticket open), and anything that needs a decision.
      Each ticket listed `merged - check by hand`: what the reviewer said to check, and offer to
      check it if you can (open the page, rebuild the file) - the gates did not. Each ticket listed
      `merged, partly done`: the criterion an agent left undone (the ticket is still open, and the
      next run picks up the remainder - unless the line says the remainder needs a person (a decision, a deploy, access),
      when the summary suggests moving the ticket to the hold label instead). Each ticket listed `the reviewer named a gap it did not file`: a sentence the reviewer left in prose, with no
      `<followup>` or `<unmet>` line, so nothing was filed - file it as a ticket (offer to), or say it needs nothing. A follow-up the summary says to file by hand is one the kit
      could not file, after a stop or a failed filing: file it, or offer to. The rest are under a `### To triage`
      sub-heading, after the run's own items, and the headline's `to triage` counts them (`need you` counts the items
      above it): each follow-up `filed for triage` (the kit filed it from an agent's `<followup>` line) and each
      `needs-triage` issue opened during the run. One line on what it asks, and offer the `queue` action for it.
   4. `## ❌ Needs fixing (failed or conflicted)` - each red, conflicted, crashed or unlanded branch: the cause in one line,
      the file or test, whether it shares a cause with another, and the concrete fix path. The
      summary's `Same failing test` lines are likely one cause; its `Same file` lines are only a
      place to look - read both branches' failures before calling it one cause. For a red gate, read the gate log
      (`.sandcastle/logs/agent-issue-<n>-gates-<n>.log`) and the repair log's last lines; a gate
      run with `-x` shows only its first failure. Once a person has fixed a red or conflicted branch
      (on the branch itself), land it with `sandcastle land <n>`, never with a hand-written
      `git merge`, so the merge message and the close comment are the kit's. With several branches
      unlanded, `sandcastle preview` shows which of them conflict before anything is merged.
   5. `## ▶️ Runnable now / ⏳ Still blocked` - the unblocked list is computed after landing; for
      each still blocked, what it waits for and whether that blocker is itself held or red; and
      after a run that ended early, the tickets it cut short (with the phase each was in) and the
      ones it never started - all still queued.
   6. `## 📤 Local state` - commits ahead of the upstream, branches left standing, kept worktrees,
      and the push that fits the repo's own shipping rules (read its AGENTS.md or CONTRIBUTING).
      Say plainly that Sandcastle pushed nothing.
   7. `## 👉 Next step` - **one** recommended action and why, then the short list after it, then
      **one** question where a human decision is needed (for example: "Three of the unmerged
      branches failed on the same test baseline. Raise it once (recommended), or trim the rules?").

   End by offering the natural follow-ups as things you can do next - fix a cause several branches
   share, requeue a failed ticket with a note (`sandcastle requeue <n> --note "..."`), start a run
   for the unblocked tickets, `sandcastle clean` once branches are resolved, push under the repo's
   rules - and do each only on a yes.

## How landing reads

Tickets land **while others still run**, one at a time on the landing worker, as each goes green -
not in a batch after the last one. So the summary's merged count includes tickets that landed
mid-run, `Merged <base> re-gated` is still the one check at the end (it runs when one or more
tickets merged, unless a clean gate-only sandbox already proved that very commit - the last landing's merge gated in its landing sandbox, or the base check - which the line says; a fast-forward's gates ran in the ticket's own sandbox and never skip it), and a ticket's gates passing on its own branch says nothing about the base it
lands on. Two cases follow from that:

- **`red together with #N`** (under Needs fixing) is a branch green alone but red once merged with
  ticket(s) that had already landed: nothing was merged for it, and the fix is in how the two meet
  (usually a shared test or file), not in the red ticket's own tests - read both diffs and the
  gate log before blaming either.
- **`requeued`** (under Runnable now) is a ticket the run put back in the queue itself: it needs
  no action from the user and runs again on the next `sandcastle run`.

In the status view, a landing ticket holds no sandbox slot, and the run cell's estimate reads
`ends ~HH:MM` (when the last pipeline should finish, or when the landing gates, one after another on the one worker, should, if later) rather than `lands ~HH:MM`.

## Reading the summary

- **`held`** branches were green but not landed automatically - the line says why: they change
  hooks, CI, install scripts or a `protectedPaths` path, add a file over 50 MB, carry repair
  commits no review passed or a conflict resolution that dropped merged lines - or a person marked
  the ticket `ready-for-human` during the run. `held` with "no commits" is a ticket an agent
  handed back: it needs an answer, not a merge. A held branch a person has since merged by hand
  reads "merged by hand; closes on push" under Done: nothing is left for them but the push (once the
  ticket is closed it reads "merged by hand, and closed"). A merge worded "part of" the ticket reads
  "merged by hand, partly done: stays open", with its unmet criterion: the push does not close it. That holds after `sandcastle clean` has
  deleted the branch, if the merge's own subject (`Merge agent/issue-<n> (closes|part of ...)`) is on
  the base; a held branch that is gone with no such subject is listed with no merge command.
- **`withdrawn`** tickets were closed or unqueued during the run: someone's decision, nothing to
  fix.
- **`not landed`** means the branch moved after its gates or the merge failed for a reason other
  than a conflict.
- **Run STOPPED** in the heading: the run landed nothing after the stop (the heading says how many
  merged before it), and it names what moved. For a moved base branch, show the user the commits
  it lists and ask whether they are theirs before offering a re-run; for a changed `.git/config`
  or `.git/info/`, stop and have them inspect it (the stop names the keys that changed, and for
  a key that neither runs a program nor carries a credential, the old and new values: a branch of their own tells at once).
- **A red gate whose repair made no commit** usually means the repair agent judged the failure
  outside the branch: read the repair log and its ticket comment, then check that gate with
  `sandcastle gates` (once the run has ended: it refuses while one is live) before blaming the branch.
- **"red on <base> before any agent ran"**: the run spent no allowance, and the cause is the
  image, the setup, the lean plan or a hook test (`.sandcastle/logs/base-gates.log`).
- **A dry run** ends with `dry run held` or `DRY RUN BREACHED` - the latter means an agent wrote
  to the tracker; show the user what changed.
- Unmerged branches are cleared with `sandcastle clean --all` only after asking - their work is
  lost.

## Models and effort

The kit's defaults are in its README ("Environment variables"). To change them for a project, set
`model` or `effort` under `implement` or `review` in the project's `.sandcastle/config.ts` and
commit it - for example `review: { effort: "medium" }`. For one run only, prefix the command with
`IMPL_MODEL`, `IMPL_EFFORT`, `REVIEW_MODEL` or `REVIEW_EFFORT`; these win over the config. For the
implementer the order is: the ticket's own `model:` or `effort:` label, then `IMPL_MODEL` /
`IMPL_EFFORT`, then the config, then the kit's default - so `IMPL_MODEL` leaves a ticket with a
`model:` label as it is; to override a label for one run, remove the label. Repair uses the
implementer's model and effort. A run that is already going keeps its models; the change applies
from the next one, and it never needs a change to the kit.
