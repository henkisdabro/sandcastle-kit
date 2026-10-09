// Landing a branch whose merge conflicts only in generated files (`generated` in
// .sandcastle/config.ts). The host never runs project code, so `regen` cannot run there:
// the merge is redone in a throwaway sandbox from the base tip, resolved by regenerating,
// committed with the landing message, and the host's base branch is fast-forwarded to it.

import { createSandbox } from "@ai-hero/sandcastle";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { clip, type GateRun, gateResultLines, runGates } from "./gates.ts";
import { type Exec, type Generated, covers, hostIdentity, regensFor, resolveGenerated, shq } from "./generated.ts";
import { assertGitUnchanged, checkBeforeClose, dropBackup, openOrAbandon, type Fingerprint, gitFingerprint, largeFiles, largeFilesNote, protectedChanges, recordGitConfigEnd } from "./guard.ts";
import { remainderNote } from "./autonomy.ts";
import { recordHandLanding } from "./ledger.ts";
import { mergeSubject } from "./landing.ts";
import { withSlot } from "./pool.ts";
import { recordPeak } from "./peaks.ts";
import { mergeTree, mergeTreeSupported, noteMissingObjects } from "./resolution.ts";
import { gatesLog, markLog, readHeads } from "./run.ts";
import { AGENT_COMMITTER, errorLine, ownCommits, sandboxConfig, sh } from "./sandbox.ts";
import type { Tracker } from "./tracker.ts";
import { execGate, lockWorktree, unlockWorktree } from "./worktree-lock.ts";

export type Box = { worktreePath: string; exec: Exec["exec"]; close(): Promise<unknown> };
export type Opener = (branch: string) => Promise<Box>;
export type LandResult =
  | { kind: "merged"; commit: string; files: string[]; regen: string[] }
  | { kind: "conflict"; files: string[]; note?: string }
  | { kind: "regen-failed"; files: string[]; reason: string }
  /** `base`: the base tip the merge was made on and gated, which a requeue compares with its own (`repairFromRed`, landing.ts). */
  | { kind: "red"; run: GateRun; base: string };

/**
 * What the host checks on the sandbox's landing commit `c` before fast-forwarding to it: `b`
 * is the base tip the sandbox started from, `h` the gated branch head. `regen` and `setup` are
 * the branch's own code and run with the worktree's index, so a `git add -A` or a committing
 * build could put changes outside `generated` into the merge; those appear in neither parent's
 * diff, so `protectedChanges` never saw them. `c` must merge exactly `b` and `h`, and what it
 * changes beyond a plain merge of them must be under `generated`. Returns the note for the
 * conflict report, or `undefined` when the commit is fine.
 */
export const checkLandingMerge = (root: string, c: string, b: string, h: string, generated: Generated[]): string | undefined => {
  const notAMerge = "landing merge is not a merge of base and the gated head";
  const git = (...args: string[]) => sh("git", args, root);
  // With rename detection a path list names only a rename's target: a stray deletion paired
  // with a file one side added would hide behind that side's path.
  const paths = (...args: string[]) => git("diff", "--no-renames", "--name-only", "-z", ...args).split("\0").filter(Boolean);
  let base: string, head: string, mergeBase: string;
  try {
    base = git("rev-parse", "--verify", `${b}^{commit}`);
    head = git("rev-parse", "--verify", `${h}^{commit}`);
    const parents = git("rev-list", "--parents", "-n", "1", c).split(" ").slice(1);
    if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) return notAMerge;
    mergeBase = git("merge-base", base, head);
  } catch {
    return notAMerge;
  }
  const inGenerated = (f: string) => generated.some((g) => g.paths.some((p) => covers(p, f)));
  const byBranch = new Set(paths(mergeBase, head));
  const onBase = new Set(paths(mergeBase, base));
  const stray = [
    ...paths(base, c).filter((f) => !byBranch.has(f) && !inGenerated(f)),
    ...paths(head, c).filter((f) => !onBase.has(f) && !inGenerated(f)),
  ];
  if (!stray.length) return undefined;
  return `landing merge changed paths outside generated: ${[...new Set(stray)].slice(0, 5).join(", ")}`;
};

/**
 * A merge that needed no regenerating must hold exactly the tree the host's own merge of `b` and
 * `h` makes. `checkLandingMerge` vouches only for which paths changed, so a commit with the right
 * parents and other content inside the branch's own files would pass it. Needs `git merge-tree
 * --write-tree` (git 2.38); older git says so once and keeps the path check alone.
 */
let mergeTreeNoticed = false;
export const plainMergeNote = (root: string, c: string, b: string, h: string): string | undefined => {
  // Asked of git's version, not read from a failure: the failure's message names the command, `--write-tree`
  // included, so every conflict read as an old git and the check stepped aside.
  if (!mergeTreeSupported(root)) {
    if (!mergeTreeNoticed) console.log("git on this machine has no `merge-tree --write-tree` (2.38+): a landing merge is checked by its changed paths only.");
    mergeTreeNoticed = true;
    return undefined;
  }
  let merge: ReturnType<typeof mergeTree>;
  try {
    // The shared runner: in a throwaway git directory, so a merge driver the sandbox left in the shared `.git` does not run.
    merge = mergeTree(root, b, h);
  } catch (error) {
    // A partial clone's missing objects are no conflict: said once, and the path check alone stands.
    if (noteMissingObjects(root, error)) return undefined;
    // A git call that failed is no verdict on the merge, but nothing vouches for the commit either: held, and said so.
    return `the host's own merge of base and the gated head could not be run (${errorLine(error)})`;
  }
  if (merge.conflicted.size) return "the host's own merge of base and the gated head conflicts, but the sandbox's did not";
  return sh("git", ["rev-parse", `${c}^{tree}`], root) === merge.tree ? undefined : "landing merge does not hold the tree the host's own merge makes";
};

/** A squash landing's commit body: the branch's own subjects, without the kit's merges of the base into it. */
export const squashBody = (root: string, base: string, head: string) =>
  sh("git", ["log", "--reverse", "--no-merges", "--format=%s", `${base}..${head}`], root)
    .split("\n")
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join("\n");

/**
 * Merge `t.head` into the base branch in a sandbox and, when the conflict is confined to
 * generated paths, resolve it there. `merged` means the host base is already fast-forwarded
 * to `commit`; the others leave the host untouched. A landing commit that is not a merge of
 * the base tip and `head` plus `generated` changes (`checkLandingMerge`) is a `conflict` with
 * a `note`, and nothing is fast-forwarded. With `squash`, the checked merge's tree is committed
 * on the base tip with that one parent instead, as a run's squash landing would. With `gate`, the merge is gated in the
 * box first and a red one is `red`: nothing is fast-forwarded. A changed shared `.git`, or a
 * changed record of the box's worktree, throws `OperatorError`: checked before the box closes,
 * whose close is then never called (`checkBeforeClose`), and again after. `expected` (a run's fingerprint, or the one
 * `sandcastle land` took as it started) is checked before the box opens, and its base
 * moves to the new tip in the same synchronous step as the fast-forward, so a check made by
 * another pipeline never sees the base moved and the expectation not. The sandbox's peak memory
 * is filed under `run` (a run's start time; `sandcastle land` has none, so its own) before it closes.
 */
export const landInSandbox = async (
  project: Project,
  t: { branch: string; head: string; message: string; squash?: boolean; run?: string },
  open: Opener,
  gate?: (box: Box) => Promise<GateRun>,
  expected?: Fingerprint,
): Promise<LandResult> => {
  // A run's base must still be the one it expects: a person's commit made while this waited for a
  // sandbox slot is not merged over, and taken as expected, by the fresh fingerprint below. The last
  // `.git` check before the open, too: Sandcastle's open runs host git in the project, and a filter
  // another sandbox planted since the last check would run there. The calls up to the open are synchronous.
  if (expected) assertGitUnchanged(project, expected, `before landing ${t.branch} in a sandbox`);
  // Before any container starts: it runs with the shared .git mounted.
  // The run's branches and in-flight tickets are shared: pipelines run on while this lands.
  const before = gitFingerprint(project, expected);
  const baseTip = sh("git", ["rev-parse", project.baseBranch], project.root);
  // The `sandcastle/` prefix is what `sandcastle clean` already treats as scratch.
  const scratch = `sandcastle/land-${t.branch.replace(/\W+/g, "-")}-${Date.now()}`;
  let made = "";
  try {
    let result: LandResult;
    const box = await open(scratch);
    try {
      const identity = hostIdentity(project.root);
      const merge = await box.exec(`git ${identity} merge --no-ff --no-verify -m ${shq(t.message)} ${shq(t.head)}`);
      if (merge.exitCode === 0) {
        result = { kind: "merged", commit: "", files: [], regen: [] };
      } else {
        const files = (await box.exec("git diff --name-only --diff-filter=U")).stdout.split("\n").filter(Boolean);
        if (!files.length || !regensFor(files, project.generated)) {
          // No unmerged file: the merge was refused outright. Otherwise a conflict that is not ours to resolve.
          await box.exec("git merge --abort");
          result = { kind: "conflict", files };
        } else {
          const r = await resolveGenerated(box, { files, generated: project.generated, setup: project.setup, message: t.message, identity });
          result = r.ok ? { kind: "merged", commit: "", files, regen: r.regen } : { kind: "regen-failed", files, reason: r.reason };
        }
      }
      // The commit the merge made, read before the gates run the branch's code: other sandboxes
      // share this .git and could repoint the scratch ref while they do.
      if (result.kind === "merged") made = (await box.exec("git rev-parse HEAD")).stdout.trim();
      if (gate && result.kind === "merged") {
        let red: GateRun | undefined;
        // Setup ran on the base tip before the merge: a branch that adds a dependency would be
        // gated without it. A resolved conflict already re-ran setup.
        if (!result.files.length) {
          for (const command of project.setup) {
            const r = await execGate(box, command);
            if (r.exitCode === 0) continue;
            const failure = { name: "setup", command, exitCode: r.exitCode, output: clip([r.stdout, r.stderr].filter(Boolean).join("\n").trim()) };
            red = { gates: [{ name: "setup", pass: false }], failure, failures: [failure] };
            break;
          }
        }
        red ??= await gate(box);
        if (red.failures.length || red.gates.some((g) => !g.pass)) {
          // The merge's own first parent, not the host's read before the sandbox opened: it is the tip this
          // tree was gated on. Read from `made`, not HEAD: the gates ran the branch's code, which can move HEAD.
          result = { kind: "red", run: red, base: (await box.exec(`git rev-parse ${made}^1`)).stdout.trim() };
        }
      }
    } finally {
      // Sandcastle's close keeps a worktree that holds untracked files, and a build leaves them.
      try {
        await box.exec("git reset -q --hard && git clean -fdq");
      } catch {
        /* closing still has to happen */
      }
      // A landing gate can be the run's largest sandbox: `sandcastle size` must see it.
      await recordPeak(box, project.root, t.run);
      // Sandcastle's close runs `git status` on the host in the box's worktree: the container is stopped, and the
      // `.git` check and the worktree's records made, before it. A failure throws with the container removed and no
      // close - a stop, whatever the landing's own result or error.
      const when = `after landing ${t.branch} in a sandbox`;
      await checkBeforeClose(project, box.worktreePath, when, () => assertGitUnchanged(project, before, when));
      await box.close();
    }
    // A container ran with the shared .git mounted: the next host git call must not run what it may have planted.
    // A gated merge ran the branch's own code there, so a red one is checked too, as `sandcastle gates` is.
    if (result.kind === "merged" || gate) assertGitUnchanged(project, before, `after landing ${t.branch} in a sandbox`);
    if (result.kind !== "merged") return result;
    const commit = sh("git", ["rev-parse", scratch], project.root);
    if (commit !== made) return { kind: "conflict", files: result.files, note: `the landing merge's ref moved after the merge (${made.slice(0, 12)} -> ${commit.slice(0, 12)})` };
    const note = checkLandingMerge(project.root, commit, baseTip, t.head, project.generated) ?? (result.files.length ? undefined : plainMergeNote(project.root, commit, baseTip, t.head));
    if (note) return { kind: "conflict", files: result.files, note };
    // The merge is what the sandbox gated and the host checked; a squash keeps its tree exactly.
    const landed = t.squash
      ? (() => {
          const body = squashBody(project.root, baseTip, t.head);
          const message = ["-m", t.message, ...(body ? ["-m", body] : [])];
          return sh("git", ["commit-tree", `${commit}^{tree}`, "-p", baseTip, ...message], project.root, AGENT_COMMITTER);
        })()
      : commit;
    // The check above is followed by host git calls, and other tickets' sandboxes keep writing the shared .git
    // meanwhile: a `filter.<x>.smudge` and an `info/attributes` line planted since would run when the fast-forward
    // writes the files out, and the config pin only holds the filters that existed at the run's start. The calls
    // above are synchronous, so nothing of this run interleaves; this check is the last thing before the write.
    assertGitUnchanged(project, before, `before fast-forwarding ${t.branch}`);
    // `--no-overwrite-ignore`: the check above no longer watches `.git/info/exclude` (the host's own tools rewrite it),
    // so a sandbox that lists an operator's untracked file there would otherwise have this fast-forward replace it.
    sh("git", ["merge", "--ff-only", "--no-overwrite-ignore", landed], project.root);
    if (expected) {
      // Only what this fast-forward made: a base that names anything else is not ours to adopt.
      const now = sh("git", ["rev-parse", `refs/heads/${project.baseBranch}`], project.root);
      if (now !== landed) throw new OperatorError(`${project.baseBranch} names ${now.slice(0, 12)} after landing ${t.branch} at ${landed.slice(0, 12)}: something else moved it. Nothing more lands.`);
      expected.base = landed;
    }
    return { ...result, commit: landed };
  } finally {
    try {
      sh("git", ["branch", "-D", scratch], project.root);
    } catch {
      /* never created, or held by a kept worktree - `sandcastle clean` removes those */
    }
  }
};

// Set up as gateBase's sandbox is: the same image, lean plan and worktree lock.
export const sandboxOpener =
  (project: Project, image: string, planFile: string): Opener =>
  async (branch) => {
    const s = await openOrAbandon(project, branch, () => createSandbox({ branch, baseBranch: project.baseBranch, ...sandboxConfig(project, image, planFile) }));
    lockWorktree(s.worktreePath);
    return {
      worktreePath: s.worktreePath,
      exec: (c, o) => s.exec(c, o),
      close: async () => {
        unlockWorktree(s.worktreePath);
        return s.close();
      },
    };
  };

/**
 * The acceptance criterion a run recorded as unmet for the branch, so that landing it by hand does
 * what a run does: merge as "part of" the ticket and leave it open. The heads record is the one a
 * land-only run reads and is trusted only while the branch sits at the head it ended green on;
 * a branch a person moved on since is not judged by it. A branch with no green record (held before
 * it was recorded green) falls back to the last run record's `unmet` on the ticket. Neither: undefined.
 */
export const recordedUnmet = (project: Project, id: string, branch: string, head: string): string | undefined => {
  const record = readHeads(project.root)[id];
  if (record?.green && record.branch === branch) return record.green === head ? record.unmet || undefined : undefined;
  try {
    const run = JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8"));
    const unmet = run?.tickets?.[id]?.unmet;
    return typeof unmet === "string" && unmet ? unmet : undefined;
  } catch {
    return undefined; // no run record, or a half-written one: no criterion known
  }
};

/**
 * `sandcastle land <ticket>`: merge one agent branch the way a run does, gate the merge in a
 * sandbox, and close the ticket on green. Every refusal comes before `prepare()`, so it builds
 * no image and starts no container. Nothing is commented on a refusal or a red gate.
 */
export const landTicket = async (
  project: Project,
  tracker: Tracker,
  arg: string | undefined,
  prepare: () => { open: Opener } | Promise<{ open: Opener }>,
): Promise<string> => {
  if (!arg) throw new OperatorError("Usage: sandcastle land <ticket>");
  // The shared `.git` as the command starts, under the run lock its caller holds: the image build and the wait for a
  // sandbox slot come before the sandbox opens, and Sandcastle's open runs host git in the project (`git worktree add`
  // writes every file out through the filters `.git/config` names), so `landInSandbox` checks this before it opens.
  const expected = gitFingerprint(project);
  const id = arg.replace(/^#/, "");
  const ref = tracker.ref(id);
  const base = project.baseBranch;
  const branch = `agent/issue-${id}`;
  if (!tracker.get(id).open) throw new OperatorError(`${ref} is closed. Nothing to land.`);
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], project.root);
  } catch {
    throw new OperatorError(`No branch ${branch}. A run that worked on ${ref} leaves one; \`git branch --list 'agent/*'\` shows what there is.`);
  }
  if (sh("git", ["rev-list", "--count", `${base}..${branch}`], project.root) === "0") {
    throw new OperatorError(`Every commit of ${branch} is already on ${base}. Nothing to land.`);
  }
  const paths = protectedChanges(project, branch);
  if (paths.length) {
    throw new OperatorError(
      `${branch} changes how the repo executes (${paths.join(", ")}), which its own gates cannot vouch for. Review it and merge it by hand: \`git log -p ${base}..${branch}\`, then \`git merge --no-ff ${branch}\`.`,
    );
  }
  const large = largeFiles(project, branch);
  if (large.length) throw new OperatorError(`${branch} ${largeFilesNote(large)}: \`git merge --no-ff ${branch}\`.`);

  // Counted now: once merged, none of the branch's commits are ahead of the base.
  const commits = ownCommits(base, branch, project.root);
  const { open } = await prepare();
  const head = sh("git", ["rev-parse", branch], project.root);
  const log = gatesLog(project, id);
  // The section a hand landing's gates are: without it they read as part of the last run's.
  markLog(log, undefined, "sandcastle land gates on the merged tree");
  const unmet = recordedUnmet(project, id, branch, head);
  const result = await withSlot("sandboxes", `${project.name} ${ref} land`, () =>
    landInSandbox(
      project,
      { branch, head, message: mergeSubject(branch, ref, !!unmet), squash: project.land === "squash" },
      open,
      (box) => runGates(project, box, `${ref} land gates`, false, { log }, true),
      expected,
    ),
  );

  switch (result.kind) {
    case "merged": {
      const { files, regen } = result;
      const squash = project.land === "squash";
      const how = squash ? "squashed" : "merged";
      dropBackup(project, branch);
      recordHandLanding(project, id, !!unmet);
      // Deleted as a run deletes it: a squashed branch would read as unmerged work, a merged one is clutter.
      let kept = "";
      try {
        sh("git", ["branch", squash ? "-D" : "-d", branch], project.root);
      } catch (error) {
        kept = ` ${branch} could not be deleted (${errorLine(error)}) - \`sandcastle clean --all\` removes it.`;
      }
      const merged =
        `${squash ? "Squashed" : "Merged"} locally, not yet pushed, by \`sandcastle land\` from \`${branch}\` (${commits} commit(s)); ` +
        `${project.gates.map((g) => g.name).join(", ")} all green on the merge.`;
      const generated = files.length ? ` Conflicts in generated files (${files.join(", ")}) were resolved by running ${regen.map((c) => `\`${c}\``).join(", ")}.` : "";
      if (unmet) {
        // As a run lands a branch that says `<unmet>`: merged, the ticket left open with the criterion on it.
        const left = `${merged} **Left open: an acceptance criterion is unmet.** ${unmet}\n\n${remainderNote(unmet, "`sandcastle run`")}${generated}`;
        try {
          tracker.comment(id, left);
        } catch (error) {
          return `Landed ${ref} as partly done: ${how} ${branch} into ${base}, but commenting the unmet criterion failed (${errorLine(error)}). The ticket is still open; criterion: ${unmet}${kept}`;
        }
        return `Landed ${ref} as partly done: ${how} ${branch} into ${base} and left it open, an acceptance criterion being unmet: ${unmet} Not pushed - push under this repo's rules.${kept}`;
      }
      const comment = merged + generated;
      try {
        tracker.close(id, comment);
      } catch (error) {
        return `Landed ${ref}: ${how} ${branch} into ${base}, but closing it failed (${errorLine(error)}) - close it by hand.${kept}`;
      }
      return `Landed ${ref}: ${how} ${branch} into ${base} and closed it. Not pushed - push under this repo's rules.${kept}`;
    }
    case "conflict":
      throw new OperatorError(
        result.note
          ? `Refused to land ${branch} into ${base}: ${result.note}. Nothing was merged. Review what \`regen\` and \`setup\` write: only \`generated\` paths may differ from a plain merge.`
          : result.files.length
          ? `${branch} conflicts with ${base} in ${result.files.join(", ")}. Nothing was merged. If these files are written by a command (a build, a minifier), ` +
            `declare them under \`generated\` in .sandcastle/config.ts with that command and land again: the conflict is then resolved by regenerating them. ` +
            `Otherwise the ticket's next run merges ${base} into its branch first.`
          : `Could not merge ${branch} into ${base}; nothing was merged.`,
      );
    case "regen-failed":
      throw new OperatorError(
        `${branch} conflicts with ${base} only in generated files (${result.files.join(", ")}), but regenerating them failed: ${result.reason}. Nothing was merged.`,
      );
    case "red": {
      const { run } = result;
      // The gated landing was checked (`landInSandbox`) before this result came back, so a red landing ends cleanly:
      // the next start must not blame a sandbox for a change made since.
      recordGitConfigEnd(project);
      const setup = run.failure?.name === "setup" && project.setup.includes(run.failure.command);
      for (const line of setup ? [`  FAIL  setup  $ ${run.failure!.command}`] : gateResultLines(project.gates, run.gates)) console.log(line);
      if (run.failure) console.log(`\n--- ${run.failure.name} (exit ${run.failure.exitCode}), last lines:\n${run.failure.output.split("\n").slice(-15).join("\n")}`);
      throw new OperatorError(
        `Gates red on the merge of ${branch} into ${base}: ${run.failures.map((f) => f.name).join(", ")}. ` +
          `Nothing was merged; the gate output is in .sandcastle/logs/agent-issue-${id}-gates-${id}.log.`,
      );
    }
  }
};
