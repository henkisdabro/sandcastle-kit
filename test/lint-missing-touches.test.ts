// `sandcastle queue --lint` lists the `Touches:` paths the base branch lacks: a plain path with no
// file, a glob matching nothing. A path the ticket's prose calls new is left out, an existing
// one is never listed. Ticket files in a temp repo (files tracker); no Docker, gh or network.
//
//   pnpm test:file test/lint-missing-touches.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const XDG = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = XDG;
delete process.env.LINEAR_API_KEY;
const { lintQueue } = await import("../src/lint.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const GIT = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const ticket = (title: string, touches: string, prose = "Do it.") => `# ${title}\n\nStatus: ready-for-agent\nTouches: ${touches}\n\n${prose}\n\n## Comments\n`;

const lint = async (tickets: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lint-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  mkdirSync(join(root, "src"));
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  writeFileSync(join(root, "src/app.ts"), "export {};\n");
  execFileSync("git", [...GIT, "add", "-A"], { cwd: root });
  execFileSync("git", [...GIT, "commit", "-qm", "t"], { cwd: root });
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const tracker = makeTracker(project);
  return (await lintQueue(project, tracker, tracker.queued(false))).join("\n");
};

test("a Touches path that is not on the base branch is listed under problems", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/app.ts, test/pool.test.ts") });
  assert.match(text, /problems:\n\s+shop-01 names paths not on main: test\/pool\.test\.ts - new files \(call each one new in the ticket's prose, e\.g\. under ## Fix\) or typos\?/);
  assert.ok(!/not on main: src\/app\.ts/.test(text), text);
});

test("a path the ticket calls new under ## Fix is not listed", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/app.ts, test/pool.test.ts", "## Fix\n\n- Add `test/pool.test.ts` (a new file).") });
  assert.match(text, /problems: none/);
});

test("a path named in prose with no 'new' beside it is still listed", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/gone.ts", "## Fix\n\nA new approach is wanted. It is described at length in the design notes, and the file src/gone.ts is mentioned.") });
  assert.match(text, /names paths not on main: src\/gone\.ts/);
});

test("a glob that matches nothing is listed, one that matches is not", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/*.ts, lib/**/*.ts") });
  assert.match(text, /Touches globs match no file on main: lib\/\*\*\/\*\.ts - /);
  assert.ok(!/src\/\*\.ts - /.test(text), text);
});

test("existing files and directories are not listed", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/app.ts, src/") });
  assert.match(text, /problems: none/);
});

test("a path with 'new' in its own name is not taken as called new", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/new-ui.ts", "## Fix\n\n- Edit src/new-ui.ts to fix it.") });
  assert.match(text, /names paths not on main: src\/new-ui\.ts - /);
});
