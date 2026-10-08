// A ticket whose Touches line names a protected path (or whose kept branch changed one) always
// ends held, so `queue --lint` and `requeue` warn about it - and only warn. Ticket files in a temp
// git repo; no Docker, gh, model calls or network. The CLI case starts the kit with `runKit`.
//
//   pnpm test:file test/protected-touches.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const XDG = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = XDG;
delete process.env.LINEAR_API_KEY;
const { lintQueue } = await import("../src/lint.ts");
const { protectedForTicket } = await import("../src/guard.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const GIT = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const git = (root: string, ...a: string[]) => execFileSync("git", [...GIT, ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ticket = (title: string, touches = "", status = "ready-for-agent") => `# ${title}\n\nStatus: ${status}\n${touches}\nDo it.\n\n## Comments\n`;

const repo = (tickets: Record<string, string>, protectedPaths: string[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-protected-touches-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  writeFileSync(join(root, ".sandcastle/rules.md"), "rules\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", gates: [{ name: "g", command: "true" }], tracker: "files", protectedPaths: ${JSON.stringify(protectedPaths)} };\n`);
  writeFileSync(join(root, "app.ts"), "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "t");
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", protectedPaths, tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  return { root, project, tracker: makeTracker(project) };
};

test("queue --lint names a ticket whose Touches line names a protected path", async () => {
  const { project, tracker } = repo({
    "01-a.md": ticket("A", "Touches: .sandcastle/rules.md, app.ts"),
    "02-b.md": ticket("B", "Touches: app.ts"),
    "03-c.md": ticket("C", "Touches: docs/policy.md"),
  }, ["docs/"]);
  const text = (await lintQueue(project, tracker, tracker.queued(false))).join("\n");
  assert.match(text, /protected paths .*:\n\s+shop-01 will always be held; merge by hand: \.sandcastle\/rules\.md is protected/);
  assert.match(text, /shop-03 will always be held; merge by hand: docs\/policy\.md/);
  assert.ok(!/shop-02 will always/.test(text), text);
});

test("queue --lint says none when no ticket names a protected path", async () => {
  const { project, tracker } = repo({ "01-a.md": ticket("A", "Touches: app.ts") });
  assert.match((await lintQueue(project, tracker, tracker.queued(false))).join("\n"), /protected paths: none/);
});

test("a directory on the Touches line expands to the protected files under it", () => {
  const { project } = repo({ "01-a.md": ticket("A") });
  assert.deepEqual(protectedForTicket(project, "shop-01", "Touches: .sandcastle/"), [".sandcastle/config.ts", ".sandcastle/rules.md"]);
  assert.deepEqual(protectedForTicket(project, "shop-01", "Touches: app.ts"), []);
});

test("a kept branch that changed a protected path counts, though the Touches line never named it", () => {
  const { root, project } = repo({ "01-a.md": ticket("A", "Touches: app.ts") });
  git(root, "checkout", "-q", "-b", "agent/issue-shop-01");
  writeFileSync(join(root, ".sandcastle/rules.md"), "changed\n");
  git(root, "commit", "-qam", "edit rules");
  git(root, "checkout", "-q", "main");
  assert.deepEqual(protectedForTicket(project, "shop-01", "Touches: app.ts"), [".sandcastle/rules.md"]);
});

test("requeue warns about a protected path and still requeues", () => {
  const { root } = repo({ "01-a.md": ticket("A", "Touches: .sandcastle/rules.md", "ready-for-human") });
  // The requeue commit needs an identity; a machine with no global git config (a sandbox) has none.
  const run = (id: string) =>
    runKit(["requeue", id], { cwd: root, env: { ...process.env, XDG_CONFIG_HOME: XDG, GIT_CEILING_DIRECTORIES: tmpdir(), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const r = run("shop-01");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shop-01 is back in the queue/);
  assert.match(r.stdout, /shop-01 will always be held; merge by hand: \.sandcastle\/rules\.md/);
  assert.match(git(root, "show", "HEAD:.scratch/shop/issues/01-a.md"), /Status: ready-for-agent/);
});
