// Landing one green branch on the base branch, in the order burndown.ts decides: the tracker's
// word (withdrawn, taken back), the head the gates vouched for, what a person must merge, then
// the merge and the closing comment. A branch that already holds the base lands as it is; any
// other is merged and gated in a sandbox first (the tree no gate has seen). `landOne` returns
// what happened and writes the ticket's state to the run record; the caller keeps the lists the
// closing report is built from.
//
// A ticket that conflicts or goes red at landing goes back to the pipelines once, in the same run
// (the scheduler's requeue-once rule, schedule.ts); a second one holds it for the next run.
//
// Landing runs on one worker beside the pipelines (schedule.ts), and every write to the
// host's git goes through `HostGit.write`: the merge, the tracker's commits on the base, the
// branch delete. The worker moves the run's expected base with each write, so the `.git` check
// the pipelines make after their sandbox closes still catches any other movement of the base.

import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { type GateRun, failingTests } from "./gates.ts";
import { assertGitUnchanged, backupBranch, dropBackup, type Fingerprint, largeFiles, largeFilesNote, protectedChanges, tipOf } from "./guard.ts";
import { type Box, landInSandbox, type Opener, squashBody } from "./land.ts";
import { withSlot } from "./pool.ts";
import type { TicketRecord, TicketState } from "../mod/hooks/run-record.ts";
import { dirtyFiles } from "./run.ts";
import { AGENT_COMMITTER, errorLine, sh } from "./sandbox.ts";
import { overrunLine } from "./report.ts";
import type { Again, Ending, LandPorts } from "./schedule.ts";
import { refOf, type Tracker } from "./tracker.ts";
import { expandTouches, parseTouches } from "./touches.ts";

// "with #12" names the branches merged before it that changed the same files.
export const conflictLine = (c: { files: string[]; with: string[] }) =>
  (c.with.length ? `with ${c.with.map(refOf).join(", ")}: ` : "") +
  `${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? ` and ${c.files.length - 3} more` : ""}`;

/**
 * The paths the branch changed that its ticket's `Touches:` line did not declare; `[]` for a ticket
 * with no line. The line is agent-written, so this only ever warns. A glob names the files a ref
 * has, so it is read against the branch head (a new file the glob covers) as well as the base (a
 * file the branch deleted): either side declares a path. `--no-renames` lists both ends of a rename.
 */
export const touchesOverrun = (root: string, base: string, head: string, body: string): string[] => {
  const patterns = parseTouches(body);
  if (!patterns.length) return [];
  const declared = new Set([...expandTouches(root, base, patterns), ...expandTouches(root, head, patterns)]);
  return sh("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], root)
    .split("\0")
    .filter((f) => f && !declared.has(f));
};

// The ticket closes on the local merge, so the comment says the work is not on
// the remote yet: a repo that deploys on push has nothing live when this reads "done".
export const closeComment = (
  o: { branch: string; commits: number; repairs: number; regenerated?: { files: string[]; regen: string[] }; overrun?: string[] },
  gateNames: string,
  report?: string,
): string =>
  `Merged locally, not yet pushed, by the Sandcastle loop from \`${o.branch}\` (${o.commits} commit(s)` +
  (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
  `); ${gateNames} all green before merge.` +
  (o.regenerated
    ? ` Conflicts in generated files (${o.regenerated.files.join(", ")}) were resolved by running ${o.regenerated.regen.map((c) => `\`${c}\``).join(", ")}.`
    : "") +
  (o.overrun?.length ? `\n\n${overrunLine(o.overrun)}` : "") +
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


/**
 * The one writer of host git. `exclusive` runs its steps one after another, so the `.git` check a
 * pipeline makes never runs between a landing's merge and the update of the expected base.
 * `write` is a step that changes the repo: it first refuses a base that moved under it (a person's
 * commit must not be merged over), then accepts what the write made the base - synchronously, with
 * the write itself - only if `made` vouches for it. A sandbox can move the base while a write runs
 * (a `gh` call takes seconds); taking whatever the base names afterwards would adopt that as the
 * kit's own, and every later check would pass.
 */
export type HostGit = {
  readonly expected: Fingerprint;
  exclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * Without `made`, the write must leave the base where it was. With it, a moved base is accepted
   * when `made(previous, tip)` returns nothing; a returned reason stops the run.
   */
  write<T>(fn: () => T, made?: (prev: string, tip: string) => string | undefined): Promise<T>;
  /** The check a pipeline makes once its sandbox is closed, and the worker before each landing. */
  check(when: string): Promise<void>;
  /** A ticket's pipeline starts: its branch may now move (the agent commits), and has only to exist. */
  begin(branch: string): void;
  /**
   * A ticket's pipeline ended and its sandbox is closed: the `.git` check, then the branch's tip is
   * the one the run expects and, if it holds commits, is copied to the backup repo (guard.ts).
   */
  settle(branch: string, when: string): Promise<void>;
  /** The branch has landed (or the kit deleted it): the run stops expecting it and drops its copy. */
  forget(branch: string): void;
  /**
   * The `LandingStop` a refused `write` threw, kept: a caller that reads a failed write as a
   * failed close or branch delete still must not land, or run git on the host, after it.
   */
  readonly failed: LandingStop | undefined;
};

const parentsOf = (root: string, c: string) => sh("git", ["rev-list", "--parents", "-n", "1", c], root).split(" ").slice(1);
const treeOf = (root: string, c: string) => sh("git", ["rev-parse", `${c}^{tree}`], root);

/** A landing merge or squash of `head`: on the previous tip, with exactly the gated head's tree. */
export const landingMade =
  (root: string, head: string, mode: "merge" | "squash") =>
  (prev: string, tip: string): string | undefined => {
    const parents = parentsOf(root, tip);
    const want = mode === "merge" ? [prev, head] : [prev];
    if (parents.join(" ") !== want.join(" ")) return `${tip.slice(0, 12)} is not a ${mode} of ${head.slice(0, 12)} on ${prev.slice(0, 12)}`;
    if (treeOf(root, tip) !== treeOf(root, head)) return `${tip.slice(0, 12)} does not hold the gated tree of ${head.slice(0, 12)}`;
    return undefined;
  };

/**
 * A tracker write: nothing (GitHub), or the files tracker's one commit of one ticket file, on the
 * previous tip, whose content is what the host just wrote to that file.
 */
export const trackerMade =
  (root: string) =>
  (prev: string, tip: string): string | undefined => {
    if (parentsOf(root, tip).join(" ") !== prev) return `${tip.slice(0, 12)} is not one commit on ${prev.slice(0, 12)}`;
    const files = sh("git", ["diff", "--no-renames", "--name-only", "-z", prev, tip], root).split("\0").filter(Boolean);
    if (files.length !== 1) return `${tip.slice(0, 12)} changes ${files.length} files, not one ticket file`;
    try {
      sh("git", ["diff", "--quiet", tip, "--", files[0]], root);
    } catch {
      return `${tip.slice(0, 12)} commits a ${files[0]} that is not the one the host wrote`;
    }
    return undefined;
  };

export const createHostGit = (project: Project, expected: Fingerprint): HostGit => {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const done = tail.then(fn);
    tail = done.catch(() => {});
    return done;
  };
  const check = (when: string) => assertGitUnchanged(project, expected, when);
  let failed: LandingStop | undefined;
  const base = project.baseBranch;
  return {
    expected,
    exclusive,
    check: (when) => exclusive(() => check(when)),
    begin: (branch) => void expected.flying.add(branch),
    settle: (branch, when) =>
      exclusive(() => {
        // Checked while the ticket still counts as in flight: its own commits are not a moved tip.
        check(when);
        expected.flying.delete(branch);
        const tip = tipOf(project.root, `refs/heads/${branch}`);
        if (!tip) {
          delete expected.branches[branch];
          return;
        }
        expected.branches[branch] = tip;
        // Only commits the base lacks: a branch with none has nothing to lose.
        if (!sh("git", ["rev-list", "-n", "1", `refs/heads/${base}..${tip}`], project.root)) return;
        try {
          backupBranch(project, branch);
        } catch (error) {
          console.log(`${branch}: could not copy it to .sandcastle/backup.git (${errorLine(error)}); a deleted branch could not be restored.`);
        }
      }),
    forget: (branch) => {
      delete expected.branches[branch];
      expected.flying.delete(branch);
      dropBackup(project, branch);
    },
    get failed() {
      return failed;
    },
    write: (fn, made) =>
      exclusive(() => {
        try {
          check("before writing to the base branch");
        } catch (error) {
          if (!(error instanceof OperatorError)) throw error;
          failed ??= new LandingStop(error.message, { cause: error });
          throw failed;
        }
        const prev = expected.base;
        try {
          return fn();
        } finally {
          const tip = sh("git", ["rev-parse", `refs/heads/${base}`], project.root);
          if (tip !== prev) {
            const why = made ? made(prev, tip) : "this write commits nothing";
            if (why) {
              // `expected` stays where it was, so every later check stops too.
              failed ??= new LandingStop(
                `${base} moved to ${tip.slice(0, 12)} while the kit wrote to it, and not by that write: ${why}. ` +
                  `Nothing more lands. Check \`git log ${prev.slice(0, 12)}..${base}\` before running again.`,
              );
              // Thrown from `finally` on purpose: the stop wins over the write's own result or error.
              throw failed;
            }
            expected.base = tip;
          }
        }
      }),
  };
};

/** What `landOne` needs of a green branch's outcome. */
export type Landable = { issue: string; branch: string; status: string; commits: number; repairs: number; head?: string; unreviewed?: boolean };

/** What the run record takes from landing: a ticket's state, note and the odd extra field. */
export type LandingRecord = { ticket(id: string, fields: TicketRecord): void };

export type LandContext = {
  project: Project;
  tracker: Tracker;
  base: string;
  gateNames: string;
  /** What the agents reported, by ticket, for the closing comment and a hold. */
  reports: Map<string, string>;
  run: LandingRecord;
  dryRun: boolean;
  /** Opens a sandbox on a branch, for redoing a conflict confined to generated files. */
  opener: Opener;
  /** The tracker's word since the run began: closed, taken out of the queue, sent to a human. */
  withdrawal: (id: string) => { held: boolean; reason: string } | undefined;
  /** Where every write to the host's git goes. */
  host: HostGit;
  /** Gates a merged tree in the sandbox `opener` opened: the gates of the run, on a tree no pipeline gated. */
  gate: (box: Box, id: string) => Promise<GateRun>;
  /**
   * The tickets landed so far in this run, with the files each one changed on the base and the
   * commit that landed it. A conflict, or a merged tree that is red, is attributed to these
   * rather than to branches, which a squash deletes.
   */
  landed: Map<string, { files: string[]; commit: string }>;
  /** Landings waiting for a sandbox slot: while any wait, pipelines start no new sandbox (`slotTurn`). */
  slotWanted?: { n: number };
};

/**
 * Before a pipeline takes a sandbox slot: wait while a landing wants one. Slots are polled every
 * 5 s, so with a pool of one a finishing pipeline worker took the freed slot straight back, and
 * landings that need a sandbox waited until every pipeline had ended.
 */
export const slotTurn = async (wanted: { n: number }, pause = 1000) => {
  while (wanted.n > 0) await new Promise((r) => setTimeout(r, pause));
};

export type Landed =
  | { kind: "merged"; regenerated?: { files: string[]; regen: string[] }; squashed?: boolean }
  | { kind: "conflict"; files: string[]; with: string[] }
  /** The branch was green alone; its merge with the base, which holds `with` landed since it forked, was red. Not landed. */
  | { kind: "red"; with: string[]; gates: string[] }
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

const isAncestor = (root: string, ancestor: string, of: string) => {
  try {
    sh("git", ["merge-base", "--is-ancestor", ancestor, of], root);
    return true;
  } catch {
    // Exit 1 is "not an ancestor"; any other failure is read the same way, the way that gates the merge.
    return false;
  }
};

export const landOne = async (ctx: LandContext, o: Landable): Promise<Landed> => {
  const { project, tracker, base, gateNames, reports, run, dryRun, opener, withdrawal, host, landed } = ctx;
  const ref = tracker.ref;
  const root = project.root;
  const squash = project.land === "squash";
  const tip = () => sh("git", ["rev-parse", `refs/heads/${base}`], root);
  // Each ticket's state as landing decides it, so the view counts landing
  // down rather than showing one opaque stage for minutes.
  const land = (id: string, state: TicketState, note: string) => run.ticket(id, { state, note });
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
      await host.write(() => tracker.close(o.issue, `Merged into \`${base}\` by an earlier Sandcastle run (${o.head}); closing.`), trackerMade(root));
      land(o.issue, "merged", `closed, merged earlier (${o.head})`);
      return { kind: "closed-earlier" };
    }
  } catch (error) {
    if (error instanceof LandingStop) throw error;
    land(o.issue, "not landed", errorLine(error));
    return { kind: "not-landed", reason: errorLine(error) };
  }
  // The gates vouched for one commit. Anything added after it is ungated.
  if (sh("git", ["rev-parse", o.branch], root) !== o.head) {
    const reason = `${o.branch} moved after its gates passed`;
    land(o.issue, "not landed", reason);
    return { kind: "skipped", reason };
  }
  // A warning, never a hold: the Touches line is written by an agent. A tracker or git failure
  // costs the warning only.
  let overrun: string[] = [];
  try {
    overrun = touchesOverrun(root, base, o.head!, tracker.get(o.issue).body ?? "");
    if (overrun.length) run.ticket(o.issue, { overrun });
  } catch {
    overrun = [];
  }
  const touched = protectedChanges(project, o.branch);
  if (touched.length) {
    const reason = `${dryRun ? "dry run: would hold" : "human merge"}: ${touched.join(", ")}`;
    land(o.issue, "held", reason);
    run.ticket(o.issue, { files: touched });
    if (!dryRun) {
      await host.write(() =>
        tracker.hold(
          o.issue,
          `Gated green on \`${o.branch}\` (${gateNames}), but not merged automatically: it changes how the repo ` +
            `executes (${touched.join(", ")}), which its own gates cannot vouch for. Review and merge by hand.` +
            (reports.get(o.issue) ? `\n\n${reports.get(o.issue)}` : ""),
        ),
        trackerMade(root),
      );
    }
    return { kind: "held", paths: touched, reason };
  }
  const large = largeFiles(project, o.branch);
  if (large.length) {
    const reason = `${dryRun ? "dry run: would hold" : "human merge"}: ${large.join(", ")}`;
    land(o.issue, "held", reason);
    run.ticket(o.issue, { files: large });
    if (!dryRun) {
      await host.write(() =>
        tracker.hold(o.issue, `Gated green on \`${o.branch}\` (${gateNames}), but not merged automatically: it ${largeFilesNote(large)}.` + (reports.get(o.issue) ? `\n\n${reports.get(o.issue)}` : "")),
        trackerMade(root),
      );
    }
    return { kind: "held", paths: large, reason };
  }
  if (o.unreviewed) {
    const why = "repair commits not reviewed: the review after repair failed";
    const reason = `${dryRun ? "dry run: would hold" : "human merge"}: ${why}`;
    land(o.issue, "held", reason);
    if (!dryRun) await host.write(() => tracker.hold(o.issue, `Gated green on \`${o.branch}\` after a repair, but not merged: ${why}. Review the repair commits and merge by hand.`), trackerMade(root));
    return { kind: "held", paths: [], reason };
  }
  if (dryRun) {
    console.log(`[dry run] would merge ${o.branch} and close ${ref(o.issue)}`);
    land(o.issue, "ready", "dry run: would merge");
    return { kind: "dry-run" };
  }

  // The landed tickets this branch has never seen: the base gained them after it forked.
  const since = () => [...landed].filter(([, r]) => !isAncestor(root, r.commit, o.head!));
  // Recorded as the landing happens, while the files and the commit are at hand.
  const record = (before: string, after: string) => {
    try {
      landed.set(o.issue, { commit: after, files: sh("git", ["diff", "--name-only", before, after], root).split("\n").filter(Boolean) });
    } catch {
      landed.set(o.issue, { commit: after, files: [] });
    }
  };
  const before = tip();
  let regenerated: { files: string[]; regen: string[] } | undefined;
  // A branch that holds the base's tip merges to exactly its own tree, which its gates ran. Any
  // other merge makes a tree no gate has seen, so it is made and gated in a sandbox, and the base
  // moves only when that is green.
  if (isAncestor(root, before, o.head!)) {
    try {
      // The commit the gates passed on, not whatever the branch names now.
      await host.write(() => mergeBranch(root, o.branch, o.head!, ref(o.issue), project.land), landingMade(root, o.head!, project.land));
    } catch (error) {
      // The write was refused before it ran: nothing to abort, and no git may run on the host now.
      if (error instanceof LandingStop) throw error;
      // git's own last line ("Merge with strategy ort failed.") names no file, and
      // its wording varies by version, so the reason comes from the working tree. A branch
      // that holds the base cannot conflict: this is a dirty index, a full disk. Both are host
      // git calls (`git status` can run an fsmonitor), so they are a write: checked first.
      const dirty = await host.write(() => {
        try {
          abortLanding(root, project.land);
        } catch {
          /* nothing to abort */
        }
        try {
          return dirtyFiles(root);
        } catch {
          return [];
        }
      });
      const reason =
        dirty.length > 0
          ? `working tree dirty: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ""} - commit or stash, then run again`
          : errorLine(error);
      land(o.issue, "not landed", reason);
      return { kind: "not-landed", reason };
    }
    record(before, tip());
  } else {
    let result: Awaited<ReturnType<typeof landInSandbox>>;
    try {
      const wanted = ctx.slotWanted ?? { n: 0 };
      let waiting = true;
      wanted.n++;
      try {
        result = await withSlot("sandboxes", `${project.name} ${ref(o.issue)} land`, () => {
          wanted.n--;
          waiting = false;
          return landInSandbox(
            project,
            { branch: o.branch, head: o.head!, message: `Merge ${o.branch} (closes ${ref(o.issue)})`, squash },
            opener,
            (box) => ctx.gate(box, o.issue),
            host.expected,
          );
        });
      } finally {
        if (waiting) wanted.n--;
      }
    } catch (error) {
      // The .git check stops the run, as before landing.
      if (error instanceof OperatorError) throw new LandingStop(error.message, { cause: error });
      const reason = `could not land it in a sandbox: ${errorLine(error)}`;
      console.log(`${ref(o.issue)}: ${reason}.`);
      land(o.issue, "not landed", reason);
      return { kind: "not-landed", reason };
    }
    if (result.kind === "red") {
      const gates = [...new Set([...result.run.failures.map((f) => f.name), ...result.run.gates.filter((g) => !g.pass).map((g) => g.name)])];
      const earlier = since().map(([id]) => id);
      // The pair, named: which tickets this one is red with.
      land(o.issue, "red", earlier.length ? `red with ${earlier.map(refOf).join(", ")}` : "red on the merged tree");
      const failing = result.run.failure ? failingTests(result.run.failure.output) : [];
      if (failing.length) run.ticket(o.issue, { failing });
      return { kind: "red", with: earlier, gates };
    }
    if (result.kind === "merged") {
      record(before, result.commit);
      if (result.files.length) {
        regenerated = { files: result.files, regen: result.regen };
        console.log(
          `${ref(o.issue)}: conflicted only in generated files (${result.files.join(", ")}); merged by regenerating them with ${result.regen.map((c) => `\`${c}\``).join(", ")}.`,
        );
      }
    } else {
      if (result.kind === "regen-failed") console.log(`${ref(o.issue)}: regenerating ${result.files.join(", ")} failed (${result.reason}); left as a conflict.`);
      else if (result.note) console.log(`${ref(o.issue)}: ${result.note}; left as a conflict.`);
      if (!result.files.length) {
        // Refused outright, with no unmerged file: not a conflict, and calling it one sent us looking for conflicts that were not there.
        const reason = result.kind === "conflict" && result.note ? result.note : "the merge was refused in the sandbox";
        land(o.issue, "not landed", reason);
        return { kind: "not-landed", reason };
      }
      // Named, with the landed ticket it collides with: "merge conflict" alone left a human to find both.
      const files = result.files;
      const other = since().filter(([, r]) => files.some((f) => r.files.includes(f))).map(([id]) => id);
      land(o.issue, "conflict", conflictLine({ files, with: other }));
      run.ticket(o.issue, { files });
      return { kind: "conflict", files, with: other };
    }
  }
  // Landed: the run stops expecting the branch, so a squash's delete below is not a branch to
  // restore, and a person deleting a merged branch is no alarm.
  host.forget(o.branch);
  // A squash's commits are not ancestors of the base, so a kept branch would read as unmerged
  // work in `sandcastle clean`, the closing summary and the status view. Nothing needs the branch
  // now: a conflict is attributed to the landing record, not to branches.
  if (squash) {
    try {
      await host.write(() => sh("git", ["branch", "-D", o.branch], root));
    } catch {
      console.log(`${o.branch}: squashed into ${base}, but the branch could not be deleted (a kept worktree holds it?) - \`sandcastle clean --all\` removes it.`);
    }
  }
  // The merge stands whatever the tracker says next: a failed close is a
  // merged ticket still open, not one that failed to land - calling it "not
  // landed" sent a human to merge work already on the base branch.
  const merged = { ...(regenerated && { regenerated }), ...(squash && { squashed: true }) };
  try {
    await host.write(() => tracker.close(o.issue, closeComment({ ...o, regenerated, overrun }, gateNames, reports.get(o.issue))), trackerMade(root));
    land(o.issue, "merged", regenerated ? "merged and closed (generated files regenerated)" : "merged and closed");
    return { kind: "merged", ...merged };
  } catch (error) {
    run.ticket(o.issue, { state: "merged", note: "merged; closing the ticket failed", closeFailed: errorLine(error) });
    return { kind: "close-failed", ...merged };
  }
};

/**
 * Pipelines at once. A landing that gates its merge in a sandbox takes a machine-wide sandbox
 * slot (pool.ts polls every 5 s), so with the pool full of pipelines the worker would wait for
 * one to end. While landing runs in the run, the pipelines leave one slot - never fewer than one.
 */
export const pipelineWorkers = (concurrency: number, tickets: number, pool: number, landing: boolean) =>
  Math.min(concurrency, tickets, landing ? Math.max(1, pool - 1) : Infinity);

/** A green outcome waiting to land; a carried branch (one with work from an earlier run) goes first. */
export type Waiting = Landable & { carried?: boolean };

/**
 * The scheduler's land and host ports over one `LandContext`: `landOne`, and the `.git` check
 * before it. A refused write or a failed check still throws, and stops the run; anything else (a
 * tracker call that failed, a full disk, a branch gone) costs this ticket only. Thrown on, it ended
 * the process while pipelines still ran: no summary, and tickets already landed went unreported.
 */
export const landingWork = (ctx: LandContext): LandPorts<Waiting> => ({
  land: async (o) => {
    try {
      return await landOne(ctx, o);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      const reason = errorLine(error);
      try {
        ctx.run.ticket(o.issue, { state: "not landed", note: reason });
      } catch {
        /* the record is what failed; the outcome below still stands */
      }
      return { kind: "not-landed", reason };
    }
  },
  host: {
    check: (id) => ctx.host.check(`before landing ${ctx.tracker.ref(id)}`),
    get failed() {
      return ctx.host.failed;
    },
  },
});

/** "conflicted again with #1, #3 after a requeue": what a second conflict or red at landing is held as. */
export const againLine = (kind: "conflict" | "red", tickets: string[]) =>
  `${kind === "conflict" ? "conflicted" : "red"} again${tickets.length ? ` with ${tickets.map(refOf).join(", ")}` : ""} after a requeue`;

/** "requeued after conflict with #1": the second attempt, as the status view and run.json say it. */
export const requeuedLine = (kind: "conflict" | "red", tickets: string[]) =>
  `requeued after ${kind === "conflict" ? "conflict" : "red"}${tickets.length ? ` with ${tickets.map(refOf).join(", ")}` : ""}`;

/** What the closing report is built from: where each landing ending put its ticket. `burndown()` builds the lists from the endings. */
export type Landings = {
  merged: string[];
  /** Merged by regenerating generated files in a sandbox: for the close comment, and a tree no gate has seen. */
  regenerated: Map<string, { files: string[]; regen: string[] }>;
  conflicted: { issue: string; branch: string; files: string[]; with: string[] }[];
  /** Green alone, red once merged: the pair is named, and nothing is landed. */
  redMerged: { issue: string; branch: string; with: string[]; gates: string[] }[];
  heldBack: { issue: string; paths: string[] }[];
  failedToLand: { issue: string; reason: string }[];
  skipped: { issue: string; reason: string }[];
  withdrawn: { issue: string; reason: string }[];
  /** Marked for a human by a person during the run: theirs now, not a merge to make. */
  takenBack: string[];
  closedEarlier: string[];
  closeFailed: string[];
};

export const newLandings = (): Landings => ({
  merged: [],
  regenerated: new Map(),
  conflicted: [],
  redMerged: [],
  heldBack: [],
  failedToLand: [],
  skipped: [],
  withdrawn: [],
  takenBack: [],
  closedEarlier: [],
  closeFailed: [],
});

/** Puts one landing ending in the list the closing report reads it from. */
export const accountLanding = (lists: Landings, o: { issue: string; branch: string }, landed: Landed) => {
  switch (landed.kind) {
    case "merged":
    case "close-failed":
      lists.merged.push(o.issue);
      if (landed.regenerated) lists.regenerated.set(o.issue, landed.regenerated);
      if (landed.kind === "close-failed") lists.closeFailed.push(o.issue);
      break;
    case "conflict":
      lists.conflicted.push({ issue: o.issue, branch: o.branch, files: landed.files, with: landed.with });
      break;
    case "red":
      lists.redMerged.push({ issue: o.issue, branch: o.branch, with: landed.with, gates: landed.gates });
      break;
    case "held":
      lists.heldBack.push({ issue: o.issue, paths: landed.paths });
      break;
    case "withdrawn":
      lists.withdrawn.push({ issue: o.issue, reason: landed.reason });
      break;
    case "taken-back":
      lists.takenBack.push(o.issue);
      break;
    case "closed-earlier":
      lists.closedEarlier.push(o.issue);
      break;
    case "skipped":
      lists.skipped.push({ issue: o.issue, reason: landed.reason });
      break;
    case "not-landed":
      lists.failedToLand.push({ issue: o.issue, reason: landed.reason });
      break;
    case "dry-run":
      break;
  }
};

/** Each landed ticket's outcome line for the status view; `againNote` is what a second conflict or red was held as. */
export const landingLines = (lists: Landings, againNote: Map<string, string>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const n of lists.merged) out.set(n, "merged");
  for (const n of lists.closeFailed) out.set(n, "merged (ticket not closed)");
  for (const c of lists.conflicted) out.set(c.issue, `merge conflict: ${againNote.get(c.issue) ?? conflictLine(c)}`);
  for (const r of lists.redMerged) {
    out.set(r.issue, againNote.get(r.issue) ?? `red when merged${r.with.length ? ` with ${r.with.map(refOf).join(", ")}` : ""}`);
  }
  for (const f of lists.failedToLand) out.set(f.issue, "failed to land");
  for (const k of lists.skipped) out.set(k.issue, `not merged: ${k.reason}`);
  for (const w of lists.withdrawn) out.set(w.issue, `withdrawn: ${w.reason}`);
  for (const h of lists.heldBack) out.set(h.issue, "needs a human merge");
  for (const id of lists.takenBack) out.set(id, "needs a human: marked for a human during the run");
  return out;
};

/** What a second conflict or red is held as, its `with` naming the tickets of both attempts; the conflict keeps its files. */
export const againNoteOf = (landed: Extract<Landed, { kind: "conflict" | "red" }>) => {
  const line = againLine(landed.kind, landed.with);
  return landed.kind === "conflict" ? `${line}: ${conflictLine({ files: landed.files, with: [] })}` : line;
};

/** The record of a requeued ticket whose second attempt never began: the state it had before, and no longer "requeued". */
export const restoredRecord = (was: TicketRecord | undefined): TicketRecord => ({ ...(was?.state ? { state: was.state } : {}), note: was?.note ?? null, requeued: null });

/** The record of a ticket the tracker withdrew before its attempt began. */
export const withdrawnRecord = (reason: string): TicketRecord => ({ state: "withdrawn", note: `${reason.replace(" during the run", "")} - not started` });

/**
 * Green before the base moved: finished, and landing on a later run like the ones whose own check
 * failed - not "ready", which says this run lands it. `outcome` is its line for the status view.
 */
export const STOPPED_GREEN = { record: { state: "stopped", note: "finished before the run stopped - lands on a later run" } satisfies TicketRecord, outcome: "stopped: the run stopped before landing" };

/** The run record as the requeue's record uses it: a ticket's fields, and what is written so far. */
export type RequeueRecordRun = { ticket(id: string, fields: TicketRecord): void; tickets(): Record<string, TicketRecord> };

/**
 * The run record's side of the requeue-once rule, which the scheduler decides (schedule.ts):
 * `burndown()` hands it what the scheduler tells. A requeue is written as queued, with the line its
 * second attempt's setup carries (`requeuedAs`), as it is told - before the ticket is pushed back.
 * A second conflict or red is noted with the tickets of both attempts (`againNote`, for the outcome
 * line). A requeued ticket whose second attempt never began ends with its first landing: its record
 * goes back to what it was, or to withdrawn when the tracker took it back meanwhile, and `dropFirst`
 * removes its first pipeline's entry from the per-issue lines.
 */
export const createRequeueRecord = (d: {
  run: RequeueRecordRun;
  /** A write that throws (a git call, a full disk) must not cost the ticket its ending. */
  bookkeep(id: string, fn: () => void): void;
  dropFirst(id: string): void;
  ref(id: string): string;
  say(line: string): void;
}) => {
  const requeuedAs = new Map<string, string>();
  // A requeued ticket's record before it was sent back: put back if its second attempt never begins.
  const before = new Map<string, TicketRecord | undefined>();
  const againNote = new Map<string, string>();
  return {
    requeuedAs,
    againNote,
    requeued(id: string, again: Again) {
      const line = requeuedLine(again.kind, again.with);
      requeuedAs.set(id, line);
      d.bookkeep(id, () => {
        before.set(id, d.run.tickets()[id]);
        d.run.ticket(id, { state: "queued", note: line, requeued: line });
      });
      d.say(`${d.ref(id)}: ${line}; its pipeline runs again in this run.`);
    },
    ended(id: string, e: Ending<unknown, unknown>) {
      if (e.kind !== "landing") return;
      const { landed } = e;
      if (e.attempts === 1 && before.has(id)) {
        // Sent back, and its second attempt never began: the first landing stands, or, withdrawn
        // since, that - recorded as withdrawn, never as the green the first pipeline left.
        requeuedAs.delete(id);
        d.bookkeep(id, () => d.run.ticket(id, restoredRecord(before.get(id))));
        if (landed.kind === "withdrawn") {
          d.dropFirst(id);
          d.bookkeep(id, () => d.run.ticket(id, withdrawnRecord(landed.reason)));
        }
      }
      if (e.again && (landed.kind === "conflict" || landed.kind === "red")) {
        // Held for the next run, with the tickets of both attempts named - in the outcome and in the comment.
        const note = againNoteOf(landed);
        againNote.set(id, note);
        d.bookkeep(id, () => d.run.ticket(id, { note }));
      }
    },
  };
};
