// The end-of-run verify is proof that the merged base is green, so it is skipped when the green-base record already
// names the base's tip on the same image and plan, and the summary says whose gates proved it. Only a proof from a
// gate-only sandbox counts (test/verify-skip-gate-only-proof.test.ts); a fast-forward's ticket gates do not. Run for
// real against a fake docker; no Docker or network.
//
//   pnpm test:file test/verify-skip-green-base.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-verify-skip-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$*" in
  *"sh -c git rev-parse HEAD") git -C "$SANDCASTLE_TEST_REPO" rev-parse main ;;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { greenProofOfBase, noteGreenCommit, requireGreenBase, verifyBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");
const { landOne, createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { render, verifySkippedLine } = await import("../src/report.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Facts = Parameters<typeof render>[0];

const IMAGE = "sandcastle-fixture:t";
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

let n = 0;
const makeProject = () => {
  const root = join(dir, `project${n++}`);
  process.env.SANDCASTLE_TEST_REPO = root;
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-red" }] };\n`);
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "agent/issue-427", "main");
  writeFileSync(join(root, "f.txt"), "1\n");
  git(root, "add", "f.txt");
  git(root, "commit", "-q", "-m", "work on 427");
  git(root, "checkout", "-q", "main");
  return root;
};

const inProject = async <T>(root: string, fn: (p: Awaited<ReturnType<typeof loadProject>>, plan: string) => Promise<T>) => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    return await fn(project, writePlan(project).file);
  } finally {
    process.chdir(cwd);
  }
};

const facts = (verify: Facts["verify"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 3,
  tickets: { "1": { state: "merged", title: "a" }, "2": { state: "merged", title: "b" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify,
});
const regated = (verify: Facts["verify"]) => render(facts(verify), true).split("\n").find((l) => l.startsWith("Merged main"));

test("a landing's record names the ticket's gates and where they ran, and a later commit is no proof", async () => {
  const root = makeProject();
  await inProject(root, async (project, plan) => {
    const head = git(root, "rev-parse", "agent/issue-427");
    // Wired as `burndown()` wires it: the landing says whose gates ran.
    const ctx: Ctx = {
      project,
      tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
      base: "main",
      gateNames: "test",
      reports: new Map(),
      run: { ticket: () => {} },
      dryRun: false,
      opener: async () => assert.fail("a fast-forward needs no sandbox"),
      withdrawal: () => undefined,
      host: createHostGit(project, gitFingerprint(project)),
      gate: async () => assert.fail("a fast-forward is not gated again at landing"),
      greenBase: (commit, by, kind) => noteGreenCommit(project, IMAGE, plan, commit, by, kind),
      landed: new Map(),
    };
    assert.equal(greenProofOfBase(project, IMAGE, plan), undefined, "no record yet: the verify runs");
    const landed = await quietly(() => landOne(ctx, { issue: "427", branch: "agent/issue-427", status: "green", commits: 1, repairs: 0, head }));
    assert.equal(landed.result.kind, "merged");
    const tip = git(root, "rev-parse", "main");
    // A fast-forward's gates ran in the ticket's own sandbox: the record names them, and the verify still runs.
    const record = JSON.parse(readFileSync(join(root, ".sandcastle/.run/base-gates.json"), "utf8"));
    assert.deepEqual([record.commit, record.by, record.kind], [tip, "#427", "ticket-sandbox"]);
    assert.equal(greenProofOfBase(project, IMAGE, plan), undefined);
    // From a landing sandbox the same record is a proof - but not on another image or plan.
    noteGreenCommit(project, IMAGE, plan, tip, "#427", "landing-sandbox");
    assert.deepEqual(greenProofOfBase(project, IMAGE, plan), { commit: tip, by: "#427", kind: "landing-sandbox" });
    assert.equal(greenProofOfBase(project, "sandcastle-fixture:other", plan), undefined);
    writeFileSync(join(root, "g.txt"), "g\n");
    git(root, "add", "g.txt");
    git(root, "commit", "-q", "-m", "a landing whose note failed");
    assert.equal(greenProofOfBase(project, IMAGE, plan), undefined, "the record names another commit: the verify runs");
  });
});

test("the verify and the base check record whose gates they were, and an older kit's record is no proof", async () => {
  const root = makeProject();
  await inProject(root, async (project, plan) => {
    const record = join(root, ".sandcastle/.run/base-gates.json");
    await quietly(() => requireGreenBase(project, IMAGE, plan, true, "run-1"));
    const tip = git(root, "rev-parse", "main");
    assert.deepEqual(greenProofOfBase(project, IMAGE, plan), { commit: tip, by: "the base check", kind: "base" });
    await quietly(() => verifyBase(project, IMAGE, plan, "run-1"));
    assert.deepEqual(greenProofOfBase(project, IMAGE, plan), { commit: tip, by: "verify", kind: "verify" });
    const { commit: _c, by: _b, kind: _k, ...old } = JSON.parse(readFileSync(record, "utf8"));
    writeFileSync(record, JSON.stringify(old) + "\n");
    assert.equal(greenProofOfBase(project, IMAGE, plan), undefined, "an older kit's record names no kind: the verify runs");
  });
});

test("the summary says whose gates proved a merged base the verify did not run again", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(
    regated({ green: true, line: "", image: IMAGE, skipped: { commit: sha, by: "#427", kind: "landing-sandbox" } }),
    `Merged main re-gated: green at 0123456 already on image ${IMAGE} (gated with #427 in its landing sandbox) - not run again.`,
  );
  assert.equal(verifySkippedLine("main", { commit: sha, by: "the base check" }), "Merged main re-gated: green at 0123456 already (gated by the base check) - not run again");
  assert.equal(verifySkippedLine("main", { commit: sha }), "Merged main re-gated: green at 0123456 already (gated before) - not run again");
  // A run record from before proof kinds: the ticket is named, the landing sandbox is not claimed.
  assert.equal(verifySkippedLine("main", { commit: sha, by: "#474" }), "Merged main re-gated: green at 0123456 already (gated with #474) - not run again");
});

test("burndown asks the record before the verify, and a landing tells it whose gates ran", () => {
  const burndown = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(burndown, /verifySkipped = greenProofOfBase\(gateProject, image, planFile\);\n[\s\S]{0,400}if \(verifySkipped\)[\s\S]{0,200}else \{[\s\S]{0,300}verifyBase\(gateProject, image, planFile, runId\)/);
  assert.match(burndown, /greenBase: \(commit, by, kind\) => noteGreenCommit\(gateProject, image, planFile, commit, by, kind\)/);
  const landing = readFileSync(join(import.meta.dirname, "../src/landing.ts"), "utf8");
  assert.equal([...landing.matchAll(/ctx\.greenBase\?\.\([^;]*ref\(o\.issue\), "ticket-sandbox"\);/g)].length, 1);
  assert.equal([...landing.matchAll(/ctx\.greenBase\?\.\([^;]*ref\(o\.issue\), "landing-sandbox"\);/g)].length, 1);
});
