// `sandcastle queue --lint` suggests splitting a ticket the estimate's size rule (`sizeOf`,
// src/run.ts) puts in its large class: 6 or more `Touches:` paths, or a body of 2,500 characters
// or more. Ticket files in a temp repo (files tracker); no Docker, gh, model calls or network.
//
//   pnpm test:file test/queue-lint-split.test.ts

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
const ticket = (title: string, head = "", prose = "Do it.") => `# ${title}\n\nStatus: ready-for-agent\n${head}\n${prose}\n\n## Comments\n`;

const lint = async (tickets: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lint-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  execFileSync("git", [...GIT, "add", "-A"], { cwd: root });
  execFileSync("git", [...GIT, "commit", "-qm", "t"], { cwd: root });
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const tracker = makeTracker(project);
  return (await lintQueue(project, tracker, tracker.queued(false))).join("\n");
};

const paths = (n: number) => Array.from({ length: n }, (_, i) => `src/part${i}.ts`).join(", ");

test("a ticket with six Touches paths is suggested for splitting, with its paths and body length", async () => {
  const text = await lint({ "01-a.md": ticket("A", `Touches: ${paths(6)}`) });
  assert.match(text, /consider splitting .*:\n {4}shop-01: 6 Touches path\(s\), body of \d+ characters/);
});

test("a ticket with a body of 2,500 characters is suggested for splitting however few paths it names", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Touches: src/a.ts", "x".repeat(2600)) });
  assert.match(text, /consider splitting .*:\n {4}shop-01: 1 Touches path\(s\), body of 2,6\d\d characters/);
});

test("small and medium tickets get no splitting line", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Touches: src/a.ts"), "02-b.md": ticket("B", `Touches: ${paths(5)}`, "y".repeat(1500)) });
  assert.match(text, /consider splitting \(large by the estimate's size rule\): none/);
  assert.ok(!/shop-0[12]: \d+ Touches/.test(text), text);
});

test("only the large ticket among several is named", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Touches: src/a.ts"), "02-b.md": ticket("B", `Touches: ${paths(7)}`) });
  assert.match(text, /shop-02: 7 Touches path\(s\)/);
  assert.ok(!text.includes("shop-01: 1 Touches"), text);
});
