// The project's gates, run by the orchestrator in a sandbox - never
// self-reported by an agent - and the check that they are green on the base
// branch before any agent starts.
//
// A gate that is red on the base commit is red on every branch, whatever the
// agent writes: an image too old for a test, a hook lean.dropHooks removed
// that a test expects. A run on such a base spends allowance on every issue
// and merges nothing, and its repair passes cannot help. So a run first gates
// the base commit in the image, and stops if anything is red.

import { createHash } from "node:crypto";
import { createSandbox } from "@ai-hero/sandcastle";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { withSlot } from "./pool.ts";
import { sandboxConfig, sh } from "./sandbox.ts";
import { execGate, unlockWorktree } from "./worktree-lock.ts";

export type Gate = { name: string; pass: boolean };
type Failure = { name: string; command: string; exitCode: number; output: string };
export type GateRun = { gates: Gate[]; failure?: Failure; failures: Failure[] };

// Start and end of a gate's output: the first compiler error is at the top,
// the test summary at the bottom, and a whole log would swamp the prompt.
export const clip = (text: string, head = 8_000, tail = 24_000) =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n[... ${text.length - head - tail} characters cut ...]\n${text.slice(-tail)}`;

// In order. A branch stops at the first red gate - its repair pass is fed
// that one's output, and the rest would only cost time. `all` runs every
// gate, for a report that says which of them are red, not just the first.
export const runGates = (project: Project, sandbox: Parameters<typeof execGate>[0], label: string, all = false) =>
  withSlot("gates", label, async (): Promise<GateRun> => {
    const gates: Gate[] = [];
    const failures: Failure[] = [];
    for (const g of project.gates) {
      const r = await execGate(sandbox, g.command);
      gates.push({ name: g.name, pass: r.exitCode === 0 });
      if (r.exitCode === 0) continue;
      const output = clip([r.stdout, r.stderr].filter(Boolean).join("\n").trim());
      failures.push({ name: g.name, command: g.command, exitCode: r.exitCode, output });
      if (!all) break;
    }
    return { gates, failure: failures[0], failures };
  });

// Every gate on the tip of the base branch, in a throwaway sandbox set up
// exactly as an agent's is (image, setup, lean plan).
export const gateBase = (project: Project, image: string, planFile: string, label: string) =>
  withSlot("sandboxes", `${project.name} ${label}`, async () => {
    const branch = `sandcastle/${label.replace(/\W+/g, "-")}-${Date.now()}`;
    const sandbox = await createSandbox({ branch, baseBranch: project.baseBranch, ...sandboxConfig(project, image, planFile) });
    try {
      return await runGates(project, sandbox, `${project.name} ${label}`, true);
    } finally {
      unlockWorktree(sandbox.worktreePath);
      await sandbox.close();
      try {
        sh("git", ["branch", "-D", branch]);
      } catch {
        /* never created */
      }
    }
  });

export const gateLine = (gates: Gate[]) => gates.map((g) => `${g.name}=${g.pass ? "pass" : "FAIL"}`).join(" ");

// A green result holds for as long as nothing it depended on changes: the
// base commit, the image, and the config that shapes a sandbox.
const baseKey = (project: Project, image: string, planFile: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        sh("git", ["rev-parse", project.baseBranch]),
        image,
        project.gates,
        project.setup,
        project.mounts,
        readFileSync(planFile, "utf8"),
      ]),
    )
    .digest("hex");

/**
 * Gates the base branch and throws if any gate is red, with each red gate's
 * output in the log. `cached` skips the check when the same base, image and
 * config were green before.
 */
export const requireGreenBase = async (project: Project, image: string, planFile: string, cached = true) => {
  const record = join(project.root, ".sandcastle/.run/base-gates.json");
  const key = baseKey(project, image, planFile);
  const base = project.baseBranch;
  if (cached && existsSync(record) && JSON.parse(readFileSync(record, "utf8")).key === key) {
    console.log(`Gates on ${base}: green at this commit and image before - not re-run.`);
    return;
  }
  console.log(`Gates on ${base}: running every gate on the base commit in a sandbox, before any agent starts ...`);
  const run = await gateBase(project, image, planFile, "base-gates");
  console.log(`Gates on ${base}: ${gateLine(run.gates)}`);
  if (!run.failures.length) {
    writeFileSync(record, JSON.stringify({ key, at: new Date().toISOString() }) + "\n");
    return;
  }
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  const log = join(project.root, ".sandcastle/logs/base-gates.log");
  writeFileSync(log, run.failures.map((f) => `===== ${f.name}: ${f.command} (exit ${f.exitCode})\n${f.output}\n`).join("\n"));
  for (const f of run.failures) {
    console.log(`\n--- ${f.name} (exit ${f.exitCode}), last lines:\n${f.output.split("\n").slice(-15).join("\n")}`);
  }
  throw new Error(
    `Red on ${base} before any agent ran: ${run.failures.map((f) => f.name).join(", ")}. Every branch would fail the same way, ` +
      `so no sandbox started. The cause is the image, the setup or the lean plan, not an issue: full output in ` +
      `.sandcastle/logs/base-gates.log. Fix it, then \`sandcastle gates\` to check (SKIP_BASE_GATES=1 runs anyway).`,
  );
};
