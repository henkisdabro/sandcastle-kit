// `sandcastle queue --lint TICKET ...`: the lint of the tickets a run names, not of the whole
// queue. A run limited to some tickets (`sandcastle run 12 15`) must be linted as that run: the
// chain, the hot files and the estimate count only the named ones, and a blocker outside them is
// listed as the wait a run would make. Ticket files in a temp repo (files tracker); no Docker, gh,
// model calls or network.
//
//   pnpm test:file test/queue-lint-named.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { helpFor } from "../src/help.ts";

const XDG = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = XDG;
delete process.env.LINEAR_API_KEY;

const GIT = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const ticket = (title: string, head = "", status = "ready-for-agent") => `# ${title}\n\nStatus: ${status}\n${head}\nDo it.\n\n## Comments\n`;

// 01 <- 02 <- 03 is a chain of three; 04 and 05 are the run's two tickets, 05 waiting for 01.
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lint-named-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  const tickets: Record<string, string> = {
    "01-a.md": ticket("A", "Touches: src/hub.ts"),
    "02-b.md": ticket("B", "Blocked by: 01\nTouches: src/hub.ts"),
    "03-c.md": ticket("C", "Blocked by: 02\nTouches: src/hub.ts"),
    "04-d.md": ticket("D", "Touches: src/hub.ts"),
    "05-e.md": ticket("E", "Blocked by: 01\nTouches: src/other.ts"),
    "06-f.md": ticket("F", "", "done"),
  };
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", gates: [{ name: "g", command: "true" }], tracker: "files" };\n');
  execFileSync("git", [...GIT, "add", "-A"], { cwd: root });
  execFileSync("git", [...GIT, "commit", "-qm", "t"], { cwd: root });
  return root;
};

const lint = (root: string, ...args: string[]) =>
  runKit(["queue", "--lint", ...args], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: XDG, GIT_CEILING_DIRECTORIES: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

test("lint with no tickets still reads the whole queue", () => {
  const r = lint(project());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /5 ticket\(s\)/);
  assert.match(r.stdout, /blocker depth: 3 - shop-01 -> shop-02 -> shop-03/);
});

test("lint with named tickets counts only those: no chain, no hot file, and the outside wait is listed", () => {
  const r = lint(project(), "shop-04", "shop-05");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 named ticket\(s\)/);
  assert.match(r.stdout, /blocker depth: 1 - no queued ticket waits for another/);
  assert.match(r.stdout, /rough estimate: one run; no ticket waits for another \(blocker depth 1\)/);
  assert.match(r.stdout, /hot files \(declared by 4\+ tickets\): none/);
  assert.match(r.stdout, /waits for a blocker outside the named tickets[^\n]*:\n\s+shop-05 waits for shop-01/);
  assert.ok(!r.stdout.includes("shop-02"), r.stdout);
  assert.ok(!r.stdout.includes("shop-03"), r.stdout);
});

test("lint with named tickets keeps the chain among them", () => {
  const r = lint(project(), "shop-01", "shop-02", "shop-03");
  assert.match(r.stdout, /blocker depth: 3 - shop-01 -> shop-02 -> shop-03/);
  assert.match(r.stdout, /waits for a blocker outside the named tickets: none/);
  assert.match(r.stdout, /hot files \(declared by 4\+ tickets\): none/);
});

test("lint refuses a named ticket that is closed, as a run does", () => {
  const r = lint(project(), "shop-04", "shop-06");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /shop-06 is closed, so a run would not work on it/);
});

test("help says queue --lint takes the run's tickets", () => {
  const text = helpFor("queue");
  assert.match(text, /queue --lint \[TICKET \.\.\.\]/);
  assert.match(text, /given tickets, only those are linted/);
});
