// `sandcastle queue --lint` takes a `Touches:` path as new when "new" stands in its sentence, and
// when a ticket it waits for (directly or through the chain) calls the path new. Ticket files in
// a temp repo (files tracker); no Docker, gh or network.
//
//   pnpm test:file test/lint-new-in-sentence.test.ts

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
const ticket = (title: string, touches: string, prose = "Do it.", blockedBy = "") =>
  `# ${title}\n\nStatus: ready-for-agent\n${blockedBy ? `Blocked by: ${blockedBy}\n` : ""}Touches: ${touches}\n\n${prose}\n\n## Comments\n`;

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

const THREE = "mod/hooks/keep-warm.ts, mod/tests/keep-warm.test.ts, test/keep-warm.test.ts";

test("a list of new files in one sentence leaves none missing when 'new' opens the sentence", async () => {
  const text = await lint({ "01-a.md": ticket("A", THREE, "## Fix\n\nNew files: mod/hooks/keep-warm.ts, mod/tests/keep-warm.test.ts and test/keep-warm.test.ts.") });
  assert.match(text, /problems: none/);
});

test("a list of new files in one sentence leaves none missing when 'new' closes the sentence", async () => {
  const text = await lint({ "01-a.md": ticket("A", THREE, "## Fix\n\nmod/hooks/keep-warm.ts, mod/tests/keep-warm.test.ts and test/keep-warm.test.ts are new files.") });
  assert.match(text, /problems: none/);
});

test("a path in one sentence and 'new' only in the next is still missing", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/gone.ts", "## Fix\n\nEdit src/gone.ts. The other change is a new approach.") });
  assert.match(text, /names paths not on main: src\/gone\.ts/);
});

test("a path with 'new' in its name is still missing, and does not make its neighbour new", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/new-ui.ts, src/other.ts", "## Fix\n\nEdit src/new-ui.ts and src/other.ts.") });
  assert.match(text, /names paths not on main: src\/new-ui\.ts, src\/other\.ts - /);
});

test("a Touches line saying new still counts for nothing", async () => {
  const text = await lint({ "01-a.md": ticket("A", "src/gone.ts (new)") });
  assert.match(text, /names paths not on main: src\/gone\.ts \(new\) - /);
});

test("a file a blocking ticket calls new is not reported for the ticket that waits for it", async () => {
  const text = await lint({
    "01-a.md": ticket("A", "src/x.ts", "## Fix\n\nAdd src/x.ts (a new file)."),
    "02-b.md": ticket("B", "src/x.ts, src/y.ts", "Edit them.", "01"),
  });
  assert.match(text, /shop-02 names paths not on main: src\/y\.ts - /);
  assert.ok(!/not on main: [^\n]*src\/x\.ts/.test(text.split("\n").filter((l) => l.includes("shop-02 names")).join("\n")), text);
});

test("a file called new by a ticket two links up the chain is not reported", async () => {
  const text = await lint({
    "01-a.md": ticket("A", "src/x.ts", "## Fix\n\nAdd src/x.ts (a new file)."),
    "02-b.md": ticket("B", "src/app.ts", "Edit it.", "01"),
    "03-c.md": ticket("C", "src/x.ts", "Edit it.", "02"),
  });
  assert.ok(!/shop-03 names paths/.test(text), text);
});

test("a file called new by a ticket that is not in the chain is still reported", async () => {
  const text = await lint({
    "01-a.md": ticket("A", "src/x.ts", "## Fix\n\nAdd src/x.ts (a new file)."),
    "02-b.md": ticket("B", "src/x.ts", "Edit it."),
  });
  assert.match(text, /shop-02 names paths not on main: src\/x\.ts - /);
});
