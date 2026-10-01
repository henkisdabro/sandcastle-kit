// Landing a branch whose merge conflicts only in generated files (`generated` in
// .sandcastle/config.ts). The host never runs project code, so `regen` cannot run there:
// the merge is redone in a throwaway sandbox from the base tip, resolved by regenerating,
// committed with the landing message, and the host's base branch is fast-forwarded to it.

import { createSandbox } from "@ai-hero/sandcastle";
import type { Project } from "./config.ts";
import { type Exec, hostIdentity, regensFor, resolveGenerated, shq } from "./generated.ts";
import { assertGitUnchanged, gitFingerprint } from "./guard.ts";
import { sandboxConfig, sh } from "./sandbox.ts";
import { lockWorktree, unlockWorktree } from "./worktree-lock.ts";

export type Box = { worktreePath: string; exec: Exec["exec"]; close(): Promise<unknown> };
export type Opener = (branch: string) => Promise<Box>;
export type LandResult =
  | { kind: "merged"; commit: string; files: string[]; regen: string[] }
  | { kind: "conflict"; files: string[] }
  | { kind: "regen-failed"; files: string[]; reason: string };

/**
 * Merge `t.head` into the base branch in a sandbox and, when the conflict is confined to
 * generated paths, resolve it there. `merged` means the host base is already fast-forwarded
 * to `commit`; the other two leave the host untouched. A changed shared `.git` throws
 * `OperatorError`, as after any sandbox.
 */
export const landInSandbox = async (
  project: Project,
  t: { branch: string; head: string; message: string },
  open: Opener,
): Promise<LandResult> => {
  // Before any container starts: it runs with the shared .git mounted.
  const before = gitFingerprint(project);
  // The `sandcastle/` prefix is what `sandcastle clean` already treats as scratch.
  const scratch = `sandcastle/land-${t.branch.replace(/\W+/g, "-")}-${Date.now()}`;
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
    } finally {
      // Sandcastle's close keeps a worktree that holds untracked files, and a build leaves them.
      try {
        await box.exec("git reset -q --hard && git clean -fdq");
      } catch {
        /* closing still has to happen */
      }
      await box.close();
    }
    if (result.kind !== "merged") return result;
    // A container ran with the shared .git mounted: the next host git call must not run what it may have planted.
    assertGitUnchanged(project, before, `after landing ${t.branch} in a sandbox`);
    const commit = sh("git", ["rev-parse", scratch], project.root);
    sh("git", ["merge", "--ff-only", commit], project.root);
    return { ...result, commit };
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
    const s = await createSandbox({ branch, baseBranch: project.baseBranch, ...sandboxConfig(project, image, planFile) });
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
