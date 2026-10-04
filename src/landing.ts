// Landing one green branch on the base branch, in the order burndown.ts decides: the tracker's
// word (withdrawn, taken back), the head the gates vouched for, what a person must merge, then
// the merge and the closing comment. A branch that already holds the base lands as it is; any
// other is merged and gated in a sandbox first (the tree no gate has seen). `landOne` returns
// what happened, with the facts the run record keeps (the files, the failing tests, the error of a
// failed close), and writes no verdict: the ledger (ledger.ts) records the ending the scheduler
// makes of it. What the tracker is told at landing, `landOne` takes from the ledger too.
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
import { assertGitUnchanged, backupBranch, dropBackup, type Fingerprint, largeFiles, protectedChanges, tipOf } from "./guard.ts";
import { type Box, landInSandbox, type Opener, squashBody } from "./land.ts";
import { withSlot } from "./pool.ts";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import { describe, UNREVIEWED } from "./ledger.ts";
import { dirtyFiles } from "./run.ts";
import { AGENT_COMMITTER, errorLine, sh } from "./sandbox.ts";
import type { LandPorts } from "./schedule.ts";
import { refOf, type Tracker } from "./tracker.ts";
import { expandTouches, isAgentDoc, isTestPath, parseTouches } from "./touches.ts";

// "with #12" names the branches merged before it that changed the same files.
export const conflictLine = (c: { files: string[]; with: string[] }) =>
  (c.with.length ? `with ${c.with.map(refOf).join(", ")}: ` : "") +
  `${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? ` and ${c.files.length - 3} more` : ""}`;

/**
 * The paths the branch changed that its ticket's `Touches:` line did not declare; `[]` for a ticket
 * with no line. The line is agent-written, so this only ever warns. A glob names the files a ref
 * has, so it is read against the branch head (a new file the glob covers) as well as the base (a
 * file the branch deleted): either side declares a path. `--no-renames` lists both ends of a rename.
 * A file the branch adds under a conventional test path is never an overrun (`isTestPath`): its name
 * cannot be known when the ticket is written. A modified test file, or an added file elsewhere, is
 * returned here; `overrunPaths` folds the test and docs paths into counts when the overrun is reported.
 * Nor is a change to an agent-instructions file (`isAgentDoc`) when the branch adds any file: the
 * new module's row in the layout table is expected. On a branch that adds nothing it still counts.
 */
export const touchesOverrun = (root: string, base: string, head: string, body: string): string[] => {
  const patterns = parseTouches(body);
  if (!patterns.length) return [];
  const declared = new Set([...expandTouches(root, base, patterns), ...expandTouches(root, head, patterns)]);
  // `-z --name-status` alternates a status letter and a path; "A" is a file absent at the merge base.
  const fields = sh("git", ["diff", "--no-renames", "--name-status", "-z", `${base}...${head}`], root).split("\0");
  const changes: { status: string; file: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i].trim(), file: fields[i + 1] });
  const adds = changes.some((c) => c.status === "A");
  return changes
    .filter(({ status, file }) => file && !declared.has(file) && !(status === "A" && isTestPath(file)) && !(adds && isAgentDoc(file)))
    .map((c) => c.file);
};

// The landing merge. The subject must stay `Merge <branch> (closes <ticket>)`:
// `mergedEarlier` and status.sh's `requeued` find a landed branch by it. The committer is
// the agent's, the author the operator's (see AGENT_COMMITTER).
// --no-verify: a pre-commit hook re-running what the gates covered only adds a way for a
// green branch to fail to land. (Hooks are off for the whole host process anyway - see guard.ts.)
// A branch that leaves a criterion unmet is merged as "part of" its ticket: the ticket stays open, and
// "closes" would have the next run find the merge and close it as merged earlier (`mergedEarlier`).
export const mergeSubject = (branch: string, ticket: string, partly = false) => `Merge ${branch} (${partly ? "part of" : "closes"} ${ticket})`;

export const mergeBranch = (root: string, branch: string, head: string, ticket: string, mode: "merge" | "squash" = "merge", partly = false) => {
  if (mode === "merge") {
    return sh("git", ["merge", "--no-ff", "--no-verify", "-m", mergeSubject(branch, ticket, partly), head], root, AGENT_COMMITTER);
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
      mergeSubject(branch, ticket, partly),
      ...(body ? ["-m", body] : []),
    ],
    root,
    AGENT_COMMITTER,
  );
};

// Every place that decides "landed", and why each works with a landed branch deleted (a squash's
// commits are not ancestors of the base; a merge's branch is deleted too, so both read alike):
// - `mergedEarlier`, burndown.ts: a subject `--grep` on the base - works unchanged.
// - carried / nochange, burndown.ts (`rev-list --count base..branch`): only for a branch that
//   exists; a landed branch is deleted, so a reopened ticket starts fresh from the base, which
//   holds its work - correct.
// - `sandcastle clean`, cli.ts (`git cherry`): the deleted branch is not listed - correct.
// - the closing summary's "Agent branches with unmerged work", report.ts (`git cherry`): not listed.
// - the log archive, `archiveFinishedLogs` in run.ts: a deleted branch counts as finished, so its
//   log is archived - correct.
// - status.sh `requeued`: a subject `--grep` on the base - works unchanged.
// - status.sh section 3 (logs the record does not hold): a missing branch whose subject is on the
//   base reads `merged`, not `no branch` (a "part of" subject, `mergeSubject`, counts too).
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
export type Landable = {
  issue: string;
  branch: string;
  status: string;
  commits: number;
  repairs: number;
  head?: string;
  unreviewed?: boolean;
  /** An acceptance criterion an agent knowingly left undone: the branch lands, the ticket stays open. */
  unmet?: string;
};

/** What landing writes to the run record itself: its progress (the `landing` stage), never a verdict. */
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
  /** `overrun`: the paths it changed beyond its ticket's `Touches:` line, which the close comment names. */
  | { kind: "merged"; regenerated?: { files: string[]; regen: string[] }; squashed?: boolean; overrun?: string[] }
  | { kind: "conflict"; files: string[]; with: string[] }
  /**
   * The branch was green alone; its merge with the base was red. Not landed. `with`: the tickets landed since it
   * forked that changed a file this branch changed (none: red on the merged tree). `failing`: the test ids the red gate named.
   */
  | { kind: "red"; with: string[]; gates: string[]; failing?: string[] }
  /** `by`: what held it - a protected path, a large file, or a repair no review passed. */
  | { kind: "held"; paths: string[]; reason: string; by: "protected" | "large" | "unreviewed" }
  | { kind: "withdrawn"; reason: string }
  | { kind: "taken-back" }
  | { kind: "closed-earlier" }
  | { kind: "skipped"; reason: string }
  | { kind: "not-landed"; reason: string }
  /** Merged, but the tracker would not close the ticket (`error`, short): still a merge, never a failure to land. */
  | { kind: "close-failed"; error: string; regenerated?: { files: string[]; regen: string[] }; squashed?: boolean; overrun?: string[] }
  /** Merged, with an acceptance criterion left undone (`unmet`): the ticket stays open, and the next run picks up the remainder. */
  | { kind: "partly-done"; unmet: string; regenerated?: { files: string[]; regen: string[] }; squashed?: boolean; overrun?: string[] }
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
  // What the tracker is told of this landing: the ledger's words, posted here as it happens.
  const words = (said: Landed) => describe({ kind: "landing", green: o, landed: said, attempts: 1 }, { base, gateNames, report: reports.get(o.issue) }).tracker!.text;
  // Progress only: the ledger writes the state the landing ends on, as the scheduler tells it.
  run.ticket(o.issue, { state: "landing" });
  // The issue can change during a long run: closed by hand, or sent to a
  // human. Merging then would land work nobody still wants. A gh error here
  // costs this issue, never the landing of every green branch after it.
  try {
    // Someone's decision, not a failure: reported as "not landed", it came
    // back as a branch to fix and merge. A ticket sent to a human is theirs
    // now, its branch there if it helps; one closed or unqueued is done with.
    const called = withdrawal(o.issue);
    if (called?.held) return { kind: "taken-back" };
    if (called) return { kind: "withdrawn", reason: called.reason };
    if (o.status === "merged-earlier") {
      if (dryRun) {
        console.log(`[dry run] would close ${ref(o.issue)} - merged by an earlier run (${o.head})`);
        return { kind: "dry-run" };
      }
      await host.write(() => tracker.close(o.issue, words({ kind: "closed-earlier" })), trackerMade(root));
      return { kind: "closed-earlier" };
    }
  } catch (error) {
    if (error instanceof LandingStop) throw error;
    return { kind: "not-landed", reason: errorLine(error) };
  }
  // The gates vouched for one commit. Anything added after it is ungated.
  if (sh("git", ["rev-parse", o.branch], root) !== o.head) return { kind: "skipped", reason: `${o.branch} moved after its gates passed` };
  // A warning, never a hold: the Touches line is written by an agent. A tracker or git failure
  // costs the warning only.
  let overrun: string[] = [];
  try {
    overrun = touchesOverrun(root, base, o.head!, tracker.get(o.issue).body ?? "");
  } catch {
    overrun = [];
  }
  const touched = protectedChanges(project, o.branch);
  if (touched.length) {
    const held: Landed = { kind: "held", paths: touched, reason: `${dryRun ? "dry run: would hold" : "human merge"}: ${touched.join(", ")}`, by: "protected" };
    if (!dryRun) await host.write(() => tracker.hold(o.issue, words(held)), trackerMade(root));
    return held;
  }
  const large = largeFiles(project, o.branch);
  if (large.length) {
    const held: Landed = { kind: "held", paths: large, reason: `${dryRun ? "dry run: would hold" : "human merge"}: ${large.join(", ")}`, by: "large" };
    if (!dryRun) await host.write(() => tracker.hold(o.issue, words(held)), trackerMade(root));
    return held;
  }
  if (o.unreviewed) {
    const held: Landed = { kind: "held", paths: [], reason: `${dryRun ? "dry run: would hold" : "human merge"}: ${UNREVIEWED}`, by: "unreviewed" };
    if (!dryRun) await host.write(() => tracker.hold(o.issue, words(held)), trackerMade(root));
    return held;
  }
  if (dryRun) {
    console.log(`[dry run] would merge ${o.branch} and ${o.unmet ? "leave" : "close"} ${ref(o.issue)}${o.unmet ? " open (a criterion is unmet)" : ""}`);
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
      await host.write(() => mergeBranch(root, o.branch, o.head!, ref(o.issue), project.land, !!o.unmet), landingMade(root, o.head!, project.land));
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
            { branch: o.branch, head: o.head!, message: mergeSubject(o.branch, ref(o.issue), !!o.unmet), squash },
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
      return { kind: "not-landed", reason };
    }
    if (result.kind === "red") {
      const gates = [...new Set([...result.run.failures.map((f) => f.name), ...result.run.gates.filter((g) => !g.pass).map((g) => g.name)])];
      // Named only when it could be the cause: a landed ticket that changed a file this branch changed.
      // The rest of what landed since the fork is no suspect, and listing it sent people through every diff.
      let mine: string[] = [];
      try {
        mine = sh("git", ["diff", "--name-only", `${before}...${o.head!}`], root).split("\n").filter(Boolean);
      } catch {
        // Unknown files name nobody: "red on the merged tree" claims no more than is known.
      }
      const earlier = since().filter(([, r]) => r.files.some((f) => mine.includes(f))).map(([id]) => id);
      const failing = result.run.failure ? failingTests(result.run.failure.output) : [];
      return { kind: "red", with: earlier, gates, ...(failing.length ? { failing } : {}) };
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
        return { kind: "not-landed", reason };
      }
      // Named, with the landed ticket it collides with: "merge conflict" alone left a human to find both.
      const files = result.files;
      const other = since().filter(([, r]) => files.some((f) => r.files.includes(f))).map(([id]) => id);
      return { kind: "conflict", files, with: other };
    }
  }
  // Landed: the run stops expecting the branch, so a squash's delete below is not a branch to
  // restore, and a person deleting a merged branch is no alarm.
  host.forget(o.branch);
  // A squash's commits are not ancestors of the base, so a kept branch would read as unmerged
  // work in `sandcastle clean`, the closing summary and the status view; a merged branch is only
  // clutter, piling up in `git branch` until a clean. Nothing needs the branch now: a conflict is
  // attributed to the landing record, not to branches. A merge's delete is `-d`, which refuses a
  // branch holding a commit the base lacks, where a squash's `-D` is the only delete that works.
  try {
    await host.write(() => sh("git", ["branch", squash ? "-D" : "-d", o.branch], root));
  } catch {
    console.log(`${o.branch}: ${squash ? "squashed" : "merged"} into ${base}, but the branch could not be deleted (a kept worktree holds it?) - \`sandcastle clean --all\` removes it.`);
  }
  // The merge stands whatever the tracker says next: a failed close is a
  // merged ticket still open, not one that failed to land - calling it "not
  // landed" sent a human to merge work already on the base branch.
  const merged = { ...(regenerated && { regenerated }), ...(squash && { squashed: true }), ...(overrun.length ? { overrun } : {}) };
  // Left open on purpose: the ledger's comment (posted after the schedule) names the criterion.
  if (o.unmet) return { kind: "partly-done", unmet: o.unmet, ...merged };
  try {
    await host.write(() => tracker.close(o.issue, words({ kind: "merged", ...merged })), trackerMade(root));
    return { kind: "merged", ...merged };
  } catch (error) {
    return { kind: "close-failed", error: errorLine(error), ...merged };
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
      return { kind: "not-landed", reason: errorLine(error) };
    }
  },
  host: {
    check: (id) => ctx.host.check(`before landing ${ctx.tracker.ref(id)}`),
    get failed() {
      return ctx.host.failed;
    },
  },
});

/** The red gate and the failing tests it named: " (gate test; failing a.test.ts, b.test.ts)", or "" when no gate is known. */
export const redDetail = (red?: { gates?: string[]; failing?: string[] }) => {
  const parts = [red?.gates?.length ? `${red.gates.length > 1 ? "gates" : "gate"} ${red.gates.join(", ")}` : "", red?.failing?.length ? `failing ${red.failing.join(", ")}` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
};

/** What a red merge is red with: the landed tickets that changed a file the branch did, else "on the merged tree". */
const redWith = (tickets: string[]) => (tickets.length ? `with ${tickets.map(refOf).join(", ")}` : "on the merged tree");

/** "conflicted again with #1, #3 after a requeue", "red again on the merged tree after a requeue (gate test)": what a second conflict or red at landing is held as. */
export const againLine = (kind: "conflict" | "red", tickets: string[], red?: { gates?: string[]; failing?: string[] }) =>
  kind === "conflict"
    ? `conflicted again${tickets.length ? ` with ${tickets.map(refOf).join(", ")}` : ""} after a requeue`
    : `red again ${redWith(tickets)} after a requeue${redDetail(red)}`;

/** "requeued after conflict with #1", "requeued after red on the merged tree (gate test; failing a.test.ts)": the second attempt, as the status view and run.json say it. */
export const requeuedLine = (kind: "conflict" | "red", tickets: string[], red?: { gates?: string[]; failing?: string[] }) =>
  kind === "conflict"
    ? `requeued after conflict${tickets.length ? ` with ${tickets.map(refOf).join(", ")}` : ""}`
    : `requeued after red ${redWith(tickets)}${redDetail(red)}`;

/** The note a first red lands on: "red with #1 (gate test; failing a.test.ts)" or "red on the merged tree (gate test)". */
export const redNote = (red: { with: string[]; gates?: string[]; failing?: string[] }) => `red ${redWith(red.with)}${redDetail(red)}`;

/**
 * Where a carried branch's work came from: the ticket's first attempt when this run requeued it
 * (the scheduler's requeue-once rule, which the ledger's `requeuedAs` records), otherwise a branch kept from an
 * earlier `sandcastle run`. Saying "earlier run" of this run's own first attempt sent operators
 * looking for a run that never existed.
 */
export const carriedFrom = (requeued: boolean) => (requeued ? "its first attempt" : "an earlier run");

/** `who` is the tracker's own ref for the ticket. The line for a branch at the head it was reviewed and gated green on, or past it by merge commits only. */
export const greenCarriedLine = (who: string, head: string, requeued: boolean) =>
  `${who}: reviewed and green at ${head.slice(0, 7)} in ${carriedFrom(requeued)} - no implement or review; the gates decide.`;

/** The line for the base merged into a carried branch, cleanly or with its generated files regenerated. */
export const carriedMergeLine = (who: string, base: string, behind: number, requeued: boolean, regenerated?: { files: string[]; regen: string[] }) =>
  `${who}: merged ${base} (${behind} commit(s)) into its branch from ${carriedFrom(requeued)}` +
  (regenerated ? `; regenerated ${regenerated.files.join(", ")} with ${regenerated.regen.map((c) => `\`${c}\``).join(", ")}.` : ".");

/**
 * The review commits a requeued ticket's first attempt made, which stay on its branch when the
 * second attempt lands it: `commits` is the branch's total, so `reviewCommits` must keep them or the
 * two disagree about one branch. Review commits carry no marker, so a branch kept from an
 * earlier `sandcastle run` has no record here and counts 0.
 */
export const firstAttemptReviewCommits = (results: readonly PromiseSettledResult<{ issue: string; reviewCommits: number }>[], id: string) => {
  const first = results.find((r) => r.status === "fulfilled" && r.value.issue === id);
  return first?.status === "fulfilled" ? first.value.reviewCommits : 0;
};

/**
 * The repair passes a requeued ticket's first attempt made. The count is per attempt, so the second
 * attempt starts from this one: its outcome line reports every repair the ticket had in the run.
 */
export const firstAttemptRepairs = (results: readonly PromiseSettledResult<{ issue: string; repairs: number }>[], id: string) => {
  const first = results.find((r) => r.status === "fulfilled" && r.value.issue === id);
  return first?.status === "fulfilled" ? first.value.repairs : 0;
};

/** What a carried branch is called in a line about its conflict with the base: "its green branch", "its branch from ...". */
export const carriedBranch = (landOnly: boolean, requeued: boolean) => (landOnly ? "its green branch" : `its branch from ${carriedFrom(requeued)}`);

/** What a second conflict or red is held as, its `with` naming the tickets of both attempts; the conflict keeps its files. */
export const againNoteOf = (landed: Extract<Landed, { kind: "conflict" | "red" }>) => {
  const line = againLine(landed.kind, landed.with, landed.kind === "red" ? landed : undefined);
  return landed.kind === "conflict" ? `${line}: ${conflictLine({ files: landed.files, with: [] })}` : line;
};
