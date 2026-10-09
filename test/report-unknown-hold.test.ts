// A hold the closing summary does not recognise as a conflict resolution keeps the hand-merge step:
// `sandcastle land` is only for a resolution the kit held by its own wording (`strayNote`).
//
//   pnpm test:file test/report-unknown-hold.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather } = await import("../src/report.ts");
const { strayNote } = await import("../src/resolution.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("a held outcome in wording the kit does not write today is merged by hand, a kit-worded resolution hold is landed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-unknown-hold-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  for (const id of ["7", "8"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    writeFileSync(join(root, `work-${id}.txt`), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", `work ${id}`);
  }
  git(root, "checkout", "-q", "main");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const started = "2026-10-02T08:00:00.000Z";
  writeFileSync(
    join(root, ".sandcastle/logs/outcomes.json"),
    JSON.stringify({
      "7": { run: started, kind: "held", text: "needs a human: held by an older kit's wording" },
      "8": { run: started, kind: "held", text: `needs a human: ${strayNote(["src/a.ts"])}` },
    }),
  );
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, stage: "report", tickets: {} }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const facts = await gather(project, () => undefined);
  assert.deepEqual(facts.heldResolutions, ["8"]);
});
