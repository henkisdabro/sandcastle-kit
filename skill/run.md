# sandcastle run - closing the run

This continues the run steps 1-3 in SKILL.md.

4. **Close the run - required, even mid-way through another request.** Relaying the report is not
   the job; a hand-back the user can act on is. The run ends with a closing summary (`## 🏁 Run
   finished` down to `## 👉 Next step`); `sandcastle report` prints it again at any time, from the
   project root, with the blockers re-read and the local git state as it is now. Run it from the
   project root and take the summary from its own stdout, not from a pane scrape. With `autonomy` set, one
   `sandcastle run` can hold several turns, each printing its own closing summary; `sandcastle
   report` shows only the last turn, so read the earlier turns' `Autonomy level` lines and
   summaries from the run's output (`.sandcastle/logs/run-output.log` for a detached run;
   `sandcastle wait` prints only the last turn's summary) before writing the hand-back. At level
   `drain`, near its end is `Drain: <N> turns, <landed> landed, stopped because <cause>`, then a line
   for each ticket queued after the run started: quote the cause and name those tickets in the hand-back. Then write your
   closing message with **all seven sections, in this order, with these headings**, each one
   present and saying "none" when empty. Copy each `## ` heading **verbatim from what `sandcastle
   report` printed, emoji included** - retyping a heading is how the emoji get lost; the
   headings below are the ones it prints (without the emoji when NO_COLOR is set):

   1. `## 🏁 Run finished` - times, attempted, merged, need you, not started, tokens, and whether the
      merged base re-gated green. If it is **RED TOGETHER**, say so first and plainly: do not push.
      If it reads `ended early` or `ended without a clean exit` (Ctrl-C, a crash, a killed
      process), say that first: the summary is partial, and the tickets it cut short are listed
      under Runnable now for the next `sandcastle run` to pick up.
   2. `## ✅ Done` - merged and closed, listed short. Next to the count, say that the tickets are
      closed in the tracker but the code is only on the local base branch until pushed - the pair of
      facts operators most often misread.
   3. `## 🙋 Needs you` - each held branch: what it does in one line (read its diff), why it was
      held, its size, the review and merge commands, and anything that needs a decision - and each
      ticket listed `merged - check by hand`: what the reviewer said to check, and offer to check it
      if you can (open the page, rebuild the file) - the gates did not - and each follow-up ticket an
      agent filed (`needs-triage`): one line on what it asks, and offer the `queue` action for it.
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

   End by offering the natural follow-ups as things you can do next - fix a cause several branches share,
   requeue a failed ticket with a note (`sandcastle requeue <n> --note "..."`), start a run for the unblocked tickets, `sandcastle clean`
   once branches are resolved, push under the repo's rules. Offer them; do none without a yes.

   How landing reads: tickets land **while others still run**, one at a time on the landing worker,
   as each goes green - not in a batch after the last one. So the summary's merged count
   includes tickets that landed mid-run, `Merged <base> re-gated` is still the one check at the
   end (it runs when two or more tickets merged), and a ticket's gates passing on its own branch
   says nothing about the base it lands on. Two cases follow from that. **`red together with
   #N`** (under Needs fixing) is a branch green alone but red once merged with ticket(s) that had
   already landed: nothing was merged for it, and the fix is in how the two meet (usually a
   shared test or file), not in the red ticket's own tests - read both diffs and the gate log
   before blaming either. **`requeued`** (under Runnable now) is a ticket the run put back in the
   queue itself: it needs no action from the user and runs again on the next `sandcastle run`.
   In the status view, a landing ticket holds no sandbox slot, and the run cell's estimate reads
   `ends ~HH:MM` (when the last pipeline should finish) rather than `lands ~HH:MM`.

   Reading the summary: `held` branches were green but not landed automatically - the line says
   why: they change hooks, CI, install scripts or a `protectedPaths` path, add a file over 50 MB,
   carry repair commits no review passed or a conflict resolution that dropped merged lines - or a
   person marked the ticket `ready-for-human` during the run; `held` with "no commits" is a ticket an
   agent handed back - it needs an answer, not a merge. `withdrawn` tickets were closed or
   unqueued during the run: someone's decision, nothing to fix. `not landed` means the branch moved
   after its gates or the merge failed for a reason other than a conflict. A run headed **Run
   STOPPED** landed nothing after the stop (the heading says how many merged before it): it names
   what moved - for a moved base branch, show the user the
   commits it lists and ask whether they are theirs before offering a re-run; for a changed
   `.git/config` or `.git/info/`, stop and have them inspect it. A red gate whose repair made
   no commit usually means the repair agent judged the failure outside the branch - read the repair
   log and its ticket comment, then check that gate with `sandcastle gates` before blaming the
   branch. A run that stops with "red on <base> before any agent ran" spent no allowance: the cause
   is the image, the setup, the lean plan or a hook test (`.sandcastle/logs/base-gates.log`). A dry
   run ends with `dry run held` or `DRY RUN BREACHED` - the latter means an agent wrote to the
   tracker; show the user what changed. Unmerged branches are cleared with `sandcastle clean
   --all` only after asking - their work is lost.
