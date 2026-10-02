// Landing one green branch on the base branch, in the order burndown.ts decides: the tracker's
// word (withdrawn, taken back), the head the gates vouched for, what a person must merge, then
// the merge, a sandbox redo of a generated-files conflict, and the closing comment. `landOne`
// returns what happened and writes the ticket's state to the run record; the caller keeps the
// lists the closing report is built from.

import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { regensFor } from "./generated.ts";
import { largeFiles, largeFilesNote, protectedChanges } from "./guard.ts";
import { landInSandbox, type Opener, squashBody } from "./land.ts";
import { withSlot } from "./pool.ts";
import { dirtyFiles } from "./run.ts";
import { AGENT_COMMITTER, errorLine, sh } from "./sandbox.ts";
import { refOf, type Tracker } from "./tracker.ts";

// "with #12" names the branches merged before it that changed the same files.
export const conflictLine = (c: { files: string[]; with: string[] }) =>
  (c.with.length ? `with ${c.with.map(refOf).join(", ")}: ` : "") +
  `${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? ` and ${c.files.length - 3} more` : ""}`;

// The ticket closes on the local merge, so the comment says the work is not on
// the remote yet: a repo that deploys on push has nothing live when this reads "done".
export const closeComment = (
  o: { branch: string; commits: number; repairs: number; regenerated?: { files: string[]; regen: string[] } },
  gateNames: string,
  report?: string,
): string =>
  `Merged locally, not yet pushed, by the Sandcastle loop from \`${o.branch}\` (${o.commits} commit(s)` +
  (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
  `); ${gateNames} all green before merge.` +
  (o.regenerated
    ? ` Conflicts in generated files (${o.regenerated.files.join(", ")}) were resolved by running ${o.regenerated.regen.map((c) => `\`${c}\``).join(", ")}.`
    : "") +
  (report ? `\n\n${report}` : "");

// The landing merge. The subject must stay `Merge <branch> (closes <ticket>)`:
// `mergedEarlier` and status.sh's `requeued` find a landed branch by it. The committer is
// the agent's, the author the operator's (see AGENT_COMMITTER).
// --no-verify: a pre-commit hook re-running what the gates covered only adds a way for a
// green branch to fail to land. (Hooks are off for the whole host process anyway - see guard.ts.)
export const mergeBranch = (root: string, branch: string, head: string, ticket: string, mode: "merge" | "squash" = "merge") => {
  if (mode === "merge") {
    return sh("git", ["merge", "--no-ff", "--no-verify", "-m", `Merge ${branch} (closes ${ticket})`, head], root, AGENT_COMMITTER);
  }
  const body = squashBody(root, "HEAD", head);
  // Throws on a conflict or a refused merge, as the merge does, leaving the unmerged files for the caller.
  sh("git", ["merge", "--squash", "--no-verify", head], root, AGENT_COMMITTER);
  // --allow-empty: a green branch whose change is already on the base still gets its commit, so
  // `mergedEarlier` and status.sh find the ticket as landed.
  return sh(
    "git",
    [
      "commit",
      "--no-verify",
      "--allow-empty",
      "-m",
      `Merge ${branch} (closes ${ticket})`,
      ...(body ? ["-m", body] : []),
    ],
    root,
    AGENT_COMMITTER,
  );
};

// Every place that decides "landed", and why each works with a squash (whose commits are not
// ancestors of the base, and whose branch is deleted once the loop has landed everything):
// - `mergedEarlier`, burndown.ts: a subject `--grep` on the base - works unchanged.
// - carried / nochange, burndown.ts (`rev-list --count base..branch`): only for a branch that
//   exists; a squashed branch is deleted, so a reopened ticket starts fresh from the base, which
//   holds its work - correct.
// - `sandcastle clean`, cli.ts (`git cherry`): the deleted branch is not listed - correct.
// - the closing summary's "Agent branches with unmerged work", report.ts (`git cherry`): not listed.
// - the log archive, `archiveFinishedLogs` in run.ts: a deleted branch counts as finished, so its
//   log is archived - correct.
// - status.sh `requeued`: a subject `--grep` on the base - works unchanged.
// - status.sh section 3 (logs the record does not hold): a missing branch whose subject is on the
//   base reads `merged`, not `no branch`.
// - status.sh `merged_list` (`git branch --merged`) and the `git cherry` case: only reached when
//   the branch exists - unaffected.
// A squash leaves no MERGE_HEAD, so `git merge --abort` refuses it; `git reset --merge` undoes the
// staged squash and keeps unrelated local changes.
export const abortLanding = (root: string, mode: "merge" | "squash") =>
  sh("git", mode === "squash" ? ["reset", "--merge"] : ["merge", "--abort"], root);


/** What `landOne` needs of a green branch's outcome. */
export type Landable = { issue: string; branch: string; status: string; commits: number; repairs: number; head?: string; unreviewed?: boolean };

/** What the run record takes from landing: a ticket's state, note and the odd extra field. */
export type LandingRecord = { ticket(id: string, fields: Record<string, unknown>): void };

export type LandContext = {
  project: Project;
  tracker: Tracker;
  base: string;
  /** Where the branches forked, to tell which merged branch a conflict is with. */
  startBase: string;
  gateNames: string;
  /** What the agents reported, by ticket, for the closing comment and a hold. */
  reports: Map<string, string>;
  run: LandingRecord;
  dryRun: boolean;
  /** Opens a sandbox on a branch, for redoing a conflict confined to generated files. */
  opener: Opener;
  /** The tracker's word since the run began: closed, taken out of the queue, sent to a human. */
  withdrawal: (id: string) => { held: boolean; reason: string } | undefined;
  /** Tickets merged so far in this run, for naming the branch a conflict is with. Their branches must still exist. */
  merged: readonly string[];
};

export type Landed =
  | { kind: "merged"; regenerated?: { files: string[]; regen: string[] }; squashed?: boolean }
  | { kind: "conflict"; files: string[]; with: string[] }
  | { kind: "held"; paths: string[]; reason: string }
  | { kind: "withdrawn"; reason: string }
  | { kind: "taken-back" }
  | { kind: "closed-earlier" }
  | { kind: "skipped"; reason: string }
  | { kind: "not-landed"; reason: string }
  /** Merged, but the tracker would not close the ticket: still a merge, never a failure to land. */
  | { kind: "close-failed"; regenerated?: { files: string[]; regen: string[] }; squashed?: boolean }
  | { kind: "dry-run" };

/** The sandbox that redoes a landing could not start under the `.git` check: the run stops. */
export class LandingStop extends OperatorError {}

export const landOne = async (ctx: LandContext, o: Landable): Promise<Landed> => {
  const { project, tracker, base, startBase, gateNames, reports, run, dryRun, opener, withdrawal } = ctx;
  const ref = tracker.ref;
  const root = project.root;
  const squash = project.land === "squash";
  // Each ticket's state as landing decides it, so the view counts landing
  // down rather than showing one opaque stage for minutes.
  const land = (id: string, state: string, note: string) => run.ticket(id, { state, note });
  run.ticket(o.issue, { state: "landing" });
  // The issue can change during a long run: closed by hand, or sent to a
  // human. Merging then would land work nobody still wants. A gh error here
  // costs this issue, never the landing of every green branch after it.
  try {
    // Someone's decision, not a failure: reported as "not landed", it came
    // back as a branch to fix and merge. A ticket sent to a human is theirs
    // now, its branch there if it helps; one closed or unqueued is done with.
    const called = withdrawal(o.issue);
    if (called?.held) {
      land(o.issue, "held", called.reason);
      return { kind: "taken-back" };
    }
    if (called) {
      land(o.issue, "withdrawn", called.reason);
      return { kind: "withdrawn", reason: called.reason };
    }
    if (o.status === "merged-earlier") {
      if (dryRun) {
        console.log(`[dry run] would close ${ref(o.issue)} - merged by an earlier run (${o.head})`);
        land(o.issue, "ready", "dry run: would close");
        return { kind: "dry-run" };
      }
      tracker.close(o.issue, `Merged into \`${base}\` by an earlier Sandcastle run (${o.head}); closing.`);
      land(o.issue, "merged", `closed, merged earlier (${o.head})`);
      return { kind: "closed-earlier" };
    }
  } catch (error) {
    land(o.issue, "not landed", errorLine(error));
    return { kind: "not-landed", reason: errorLine(error) };
  }
  // The gates vouched for one commit. Anything added after it is ungated.
  if (sh("git", ["rev-parse", o.branch], root) !== o.head) {
    const reason = `${o.branch} moved after its gates passed`;
    land(o.issue, "not landed", reason);
    return { kind: "skipped", reason };
  }
  const touched = protectedChanges(project, o.branch);
  if (touched.length) {
    const reason = `${dryRun ? "dry run: would hold" : "human merge"}: ${touched.join(", ")}`;
    land(o.issue, "held", reason);
    run.ticket(o.issue, { files: touched });
    if (!dryRun) {
      tracker.hold(
        o.issue,
        `Gated green on \`${o.branch}\` (${gateNames}), but not merged automatically: it changes how the repo ` +
          `executes (${touched.join(", ")}), which its own gates cannot vouch for. Review and merge by hand.` +
          (reports.get(o.issue) ? `\n\n${reports.get(o.issue)}` : ""),
      );
    }
    return { kind: "held", paths: touched, reason };
  }
  const large = largeFiles(project, o.branch);
  if (large.length) {
    const reason = `${dryRun ? "dry run: would hold" : "human merge"}: ${large.join(", ")}`;
    land(o.issue, "held", reason);
    run.ticket(o.issue, { files: large });
    if (!dryRun) tracker.hold(o.issue, `Gated green on \`${o.branch}\` (${gateNames}), but not merged automatically: it ${largeFilesNote(large)}.` + (reports.get(o.issue) ? `\n\n${reports.get(o.issue)}` : ""));
    return { kind: "held", paths: large, reason };
  }
  if (o.unreviewed) {
    const why = "repair commits not reviewed: the review after repair failed";
    const reason = `${dryRun ? "dry run: would hold" : "human merge"}: ${why}`;
    land(o.issue, "held", reason);
    if (!dryRun) tracker.hold(o.issue, `Gated green on \`${o.branch}\` after a repair, but not merged: ${why}. Review the repair commits and merge by hand.`);
    return { kind: "held", paths: [], reason };
  }
  if (dryRun) {
    console.log(`[dry run] would merge ${o.branch} and close ${ref(o.issue)}`);
    land(o.issue, "ready", "dry run: would merge");
    return { kind: "dry-run" };
  }
  let regenerated: { files: string[]; regen: string[] } | undefined;
  try {
    // The commit the gates passed on, not whatever the branch names now.
    mergeBranch(root, o.branch, o.head!, ref(o.issue), project.land);
  } catch (error) {
    // A real conflict and a merge that failed for another reason (a dirty
    // index, a full disk) are reported apart - calling both "conflict" sent us
    // looking for conflicts that were not there.
    const unmerged = (() => {
      try {
        return sh("git", ["diff", "--name-only", "--diff-filter=U"], root);
      } catch {
        return "";
      }
    })();
    try {
      abortLanding(root, project.land);
    } catch {
      /* nothing to abort */
    }
    const files = unmerged.split("\n").filter(Boolean);
    // The host never runs project code, so a conflict confined to generated files is
    // redone in a sandbox, where `regen` can run.
    let sandboxed: Awaited<ReturnType<typeof landInSandbox>> | undefined;
    if (unmerged && regensFor(files, project.generated)) {
      try {
        sandboxed = await withSlot("sandboxes", `${project.name} ${ref(o.issue)} land`, () =>
          landInSandbox(project, { branch: o.branch, head: o.head!, message: `Merge ${o.branch} (closes ${ref(o.issue)})`, squash }, opener),
        );
      } catch (sandboxError) {
        // The .git check stops the run, as before landing; a sandbox that would not start is a conflict.
        if (sandboxError instanceof OperatorError) throw new LandingStop(sandboxError.message, { cause: sandboxError });
        console.log(`${ref(o.issue)}: could not land it in a sandbox (${errorLine(sandboxError)}); left as a conflict.`);
      }
    }
    if (sandboxed?.kind === "merged") {
      regenerated = { files: sandboxed.files, regen: sandboxed.regen };
      console.log(
        `${ref(o.issue)}: conflicted only in generated files (${sandboxed.files.join(", ")}); merged by regenerating them with ${sandboxed.regen.map((c) => `\`${c}\``).join(", ")}.`,
      );
    } else if (unmerged) {
      if (sandboxed?.kind === "conflict" && sandboxed.note) console.log(`${ref(o.issue)}: ${sandboxed.note}; left as a conflict.`);
      if (sandboxed?.kind === "regen-failed") {
        console.log(`${ref(o.issue)}: regenerating ${sandboxed.files.join(", ")} failed (${sandboxed.reason}); left as a conflict.`);
      }
      // Named, with the branch it collides with: "merge conflict" alone
      // left a human to find both.
      const other = ctx.merged.filter((m) => {
        const changed = sh("git", ["diff", "--name-only", `${startBase}...agent/issue-${m}`], root).split("\n");
        return files.some((f) => changed.includes(f));
      });
      land(o.issue, "conflict", conflictLine({ files, with: other }));
      run.ticket(o.issue, { files });
      return { kind: "conflict", files, with: other };
    } else {
      // git's own last line ("Merge with strategy ort failed.") names no file, and
      // its wording varies by version, so the reason comes from the working tree.
      const dirty = (() => {
        try {
          return dirtyFiles(root);
        } catch {
          return [];
        }
      })();
      const reason =
        dirty.length > 0
          ? `working tree dirty: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ""} - commit or stash, then run again`
          : errorLine(error);
      land(o.issue, "not landed", reason);
      return { kind: "not-landed", reason };
    }
  }
  // The merge stands whatever the tracker says next: a failed close is a
  // merged ticket still open, not one that failed to land - calling it "not
  // landed" sent a human to merge work already on the base branch.
  const merged = { ...(regenerated && { regenerated }), ...(squash && { squashed: true }) };
  try {
    tracker.close(o.issue, closeComment({ ...o, regenerated }, gateNames, reports.get(o.issue)));
    land(o.issue, "merged", regenerated ? "merged and closed (generated files regenerated)" : "merged and closed");
    return { kind: "merged", ...merged };
  } catch (error) {
    run.ticket(o.issue, { state: "merged", note: "merged; closing the ticket failed", closeFailed: errorLine(error) });
    return { kind: "close-failed", ...merged };
  }
};
