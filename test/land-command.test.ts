// `sandcastle land <ticket>`: merge one agent branch with the kit's message, gate the merge, close
// the ticket on green. A temp git repo, the ticket-file tracker and a host worktree for the
// sandbox - no Docker, no model, no network.
//
//   node --test test/land-command.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The files tracker commits the close on the host.
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@localhost" });
const { landTicket } = await import("../src/land.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-land-command-"));
const REGEN = "tr '\\n' ' ' < src.txt > out.txt";
const ID = "demo-01";
const BRANCH = `agent/issue-${ID}`;
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
const ticket = (status: string) => `# A thing\n\nStatus: ${status}\n\nDo it.\n`;

// main: tickets 01 (the branch below), 02 (no branch), 03 (done), 04 (a branch adding CI), 05 (a
// branch with nothing new). `mainChange` also edits src.txt on main and regenerates out.txt: line 3,
// where the branch edited it too (a source conflict), or line 1 (src.txt merges, out.txt conflicts).
const fixture = (o: { gate?: string; generated?: boolean; mainChange?: "same-line" | "other-line" } = {}) => {
  const root = join(tmp, `repo${n++}`);
  const marker = join(tmp, `setup-${n}.txt`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", ".sandcastle/\n");
  write(root, "src.txt", "a\nb\nc\n");
  spawnSync("sh", ["-c", REGEN], { cwd: root });
  for (const [num, status] of [["01", "ready-for-agent"], ["02", "ready-for-agent"], ["03", "done"], ["04", "ready-for-agent"], ["05", "ready-for-agent"]]) {
    write(root, `.scratch/demo/issues/${num}-thing.md`, ticket(status));
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "branch", "agent/issue-demo-05");
  git(root, "checkout", "-q", "-b", BRANCH);
  write(root, "src.txt", "a\nb\nC\n");
  spawnSync("sh", ["-c", REGEN], { cwd: root });
  write(root, "feature.txt", "the feature\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  git(root, "checkout", "-q", "-b", "agent/issue-demo-04", "main");
  write(root, ".github/workflows/x.yml", "on: push\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ci");
  git(root, "checkout", "-q", "main");
  if (o.mainChange) {
    write(root, "src.txt", o.mainChange === "same-line" ? "a\nb\nC2\n" : "A\nb\nc\n");
    spawnSync("sh", ["-c", REGEN], { cwd: root });
    git(root, "commit", "-q", "-am", "main moves");
  }
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    tracker: fakeTracker({ kind: "files" }),
    label: "ready-for-agent",
    gates: [{ name: "check", command: o.gate ?? "test -f feature.txt" }],
    setup: [`cat feature.txt >> ${marker} 2>/dev/null || true`],
    generated: o.generated ? [{ paths: ["out.txt"], regen: REGEN }] : [],
  } as unknown as Project;
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", branch, path, "main").status, 0);
    return {
      worktreePath: path,
      // execGate wraps commands in `timeout -k n n`, which macOS lacks.
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  const prepare = () => ({ open });
  // landTicket prints a red gate's FAIL lines to stdout; a green suite must not carry them.
  const land = async (arg: string | undefined = ID) => {
    const log = mock.method(console, "log", () => {});
    try {
      return await landTicket(project, makeTracker(project), arg, prepare);
    } finally {
      log.mock.restore();
    }
  };
  const ticketFile = (num = "01") => readFileSync(join(root, `.scratch/demo/issues/${num}-thing.md`), "utf8");
  return { root, project, marker, land, ticketFile, mainTip: git(root, "rev-parse", "main").out };
};

const scratchBranches = (root: string) => git(root, "branch", "--list", "sandcastle/land-*").out;

test("a clean, green branch is merged with the kit's message, then its ticket is closed", async () => {
  const f = fixture();
  const said = await f.land();
  assert.match(said, /^Landed demo-01: merged agent\/issue-demo-01 into main and closed it\./);
  // The close commit sits on top of the merge.
  assert.equal(git(f.root, "log", "-1", "--format=%s", "main~1").out, `Merge ${BRANCH} (closes ${ID})`);
  assert.equal(git(f.root, "rev-parse", "main~1^1").out, f.mainTip);
  const text = f.ticketFile();
  assert.match(text, /^Status: done$/m);
  assert.ok(text.includes("by `sandcastle land` from `agent/issue-demo-01` (1 commit(s))"), text);
  assert.ok(text.includes("check all green on the merge"), text);
  assert.ok(!text.includes("generated files"), text);
  // Setup ran again in the merged tree, so it saw feature.txt.
  assert.equal(readFileSync(f.marker, "utf8"), "the feature\n");
  assert.equal(scratchBranches(f.root), "");
  assert.equal(git(f.root, "status", "--porcelain").out, "");
  // Landed, so deleted as a squash's is: a merged branch left behind piles up until a clean.
  assert.equal(git(f.root, "branch", "--list", BRANCH).out, "");
});

test("a red gate merges nothing and leaves the ticket alone", async () => {
  const f = fixture({ gate: "false" });
  await assert.rejects(f.land(), /Gates red on the merge of agent\/issue-demo-01 into main: check/);
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
  assert.match(f.ticketFile(), /^Status: ready-for-agent$/m);
  assert.ok(!f.ticketFile().includes("sandcastle land"));
  assert.equal(scratchBranches(f.root), "");
});

test("a red gate that changes the shared .git config is reported as tampering", async () => {
  // The host worktree shares .git, as a sandbox does: `--local` writes the common config.
  const f = fixture({ gate: "git config --local sandcastle.planted yes; false" });
  await assert.rejects(f.land(), /STOPPED after landing agent\/issue-demo-01 in a sandbox: \.git\/config/);
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
  assert.match(f.ticketFile(), /^Status: ready-for-agent$/m);
});

test("a failing setup command is a red merge too", async () => {
  const f = fixture();
  f.project.setup = ["exit 4"];
  await assert.rejects(f.land(), /Gates red on the merge of agent\/issue-demo-01 into main: setup/);
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
  assert.equal(scratchBranches(f.root), "");
});

test("a conflict outside generated paths points at `generated` and merges nothing", async () => {
  const f = fixture({ mainChange: "same-line" });
  await assert.rejects(f.land(), (e: Error) => /`generated`/.test(e.message) && e.message.includes("src.txt") && /Nothing was merged/.test(e.message));
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
  assert.match(f.ticketFile(), /^Status: ready-for-agent$/m);
  assert.equal(scratchBranches(f.root), "");
});

test("a conflict only in a generated file is resolved by regenerating it", async () => {
  const f = fixture({ mainChange: "other-line", generated: true });
  const said = await f.land();
  assert.match(said, /^Landed demo-01/);
  assert.equal(readFileSync(join(f.root, "out.txt"), "utf8"), "A b C ");
  const text = f.ticketFile();
  assert.ok(text.includes("Conflicts in generated files (out.txt)"), text);
  assert.ok(text.includes(`were resolved by running \`${REGEN}\``), text);
  assert.equal(git(f.root, "log", "-1", "--format=%s", "main~1").out, `Merge ${BRANCH} (closes ${ID})`);
});

test('with land: "squash", the gated merge lands as one commit on the base tip and the branch is deleted', async () => {
  const f = fixture();
  (f.project as { land?: string }).land = "squash";
  const said = await f.land();
  assert.match(said, /^Landed demo-01: squashed agent\/issue-demo-01 into main and closed it\./);
  assert.equal(git(f.root, "log", "-1", "--format=%s%n%b", "main~1").out, `Merge ${BRANCH} (closes ${ID})\n- branch`);
  assert.equal(git(f.root, "rev-list", "--parents", "-n", "1", "main~1").out.split(" ").slice(1).join(" "), f.mainTip);
  assert.equal(git(f.root, "log", "-1", "--format=%cn", "main~1").out, "Sandcastle agent");
  assert.equal(readFileSync(join(f.root, "feature.txt"), "utf8"), "the feature\n");
  assert.equal(git(f.root, "branch", "--list", BRANCH).out, "");
  assert.match(f.ticketFile(), /Squashed locally, not yet pushed, by `sandcastle land`/);
  assert.equal(scratchBranches(f.root), "");
});

test('with land: "squash", a regenerated landing is squashed too', async () => {
  const f = fixture({ mainChange: "other-line", generated: true });
  (f.project as { land?: string }).land = "squash";
  assert.match(await f.land(), /^Landed demo-01: squashed/);
  assert.equal(readFileSync(join(f.root, "out.txt"), "utf8"), "A b C ");
  assert.equal(git(f.root, "rev-list", "--parents", "-n", "1", "main~1").out.split(" ").length, 2);
  assert.equal(git(f.root, "rev-parse", "main~2").out, f.mainTip);
  assert.equal(git(f.root, "branch", "--list", BRANCH).out, "");
});

test("refusals come before prepare, which would build an image", async () => {
  const f = fixture();
  const refuse = (arg: string | undefined, pattern: RegExp) =>
    assert.rejects(
      landTicket(f.project, makeTracker(f.project), arg, () => {
        throw new Error("prepare called");
      }),
      pattern,
    );
  await refuse(undefined, /Usage: sandcastle land/);
  await refuse("demo-03", /demo-03 is closed/);
  await refuse("demo-02", /No branch agent\/issue-demo-02/);
  await refuse("demo-05", /Every commit of agent\/issue-demo-05 is already on main/);
  await refuse("demo-04", /agent\/issue-demo-04 changes how the repo executes \(\.github\/workflows\/x\.yml\)/);
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
});

test("`sandcastle land` with no ticket prints the usage line, no stack trace", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-land-cli-"));
  git(root, "init", "-q", "-b", "main");
  write(root, ".sandcastle/config.ts", 'export default { name: "t", gates: [{ name: "g", command: "true" }], tracker: "files" };\n');
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const r = runKit(["land"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes("Usage: sandcastle land <ticket>"), r.stderr);
  assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${r.stderr}`);
  assert.ok(existsSync(root));
});
