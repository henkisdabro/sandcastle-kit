// run-output.log carried a fifth of boilerplate in a 66-ticket run: the file-share block again at every release, and
// Sandcastle's `tail -f` line for every agent pass. A release says only the share lines not said yet, and a ticket
// keeps its first `tail -f` line. No Docker, model or network.
//
//   pnpm test:file test/run-output-trim.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { styleText } from "node:util";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createHoldRecord } = await import("../src/burndown.ts");
const { createTailFilter } = await import("../src/run.ts");

const ref = (id: string) => `#${id}`;
const HEADER = "tickets that share files; if they conflict at landing, the later one is sent back once and its merge resolved:";

const hold = () => {
  const said: string[] = [];
  const logged: string[] = [];
  const record = { ticket: () => {}, update: () => {} } as never;
  const h = createHoldRecord({ waiting: [], ref, say: (l) => void said.push(l.trim()), log: (l) => void logged.push(l) });
  const release = (id: string, files: string[]) => {
    said.length = 0;
    h.tell(record, { kind: "started", id, after: { kind: "file", freed: "1" }, shares: [{ with: "2", files }] } as never);
    return said.filter((l) => !l.includes("released:"));
  };
  return { h, said, logged, release };
};

test("a release says no share line the start already said, and a new line under a shorter header", () => {
  const { h, said, logged, release } = hold();
  h.start([{ ticket: { id: "3" }, shares: [{ with: "2", files: ["src/a.ts"] }] }] as never);
  assert.deepEqual(said, [HEADER, "src/a.ts: #2 #3"]);
  const loggedAtStart = logged.length;

  assert.deepEqual(release("3", ["src/a.ts"]), [], "all said at the start: no header, no line");
  assert.equal(logged.length, loggedAtStart + 1, "the pair line is still logged");

  assert.deepEqual(release("4", ["src/a.ts", "src/b.ts"]), ["more tickets that share files:", "src/a.ts: #2 #4", "src/b.ts: #2 #4"], "a line naming a new ticket is a new line");
  assert.deepEqual(release("4", ["src/b.ts"]), [], "the same line again is not said");
  assert.equal(logged.length, loggedAtStart + 3, "every pair is logged, every time");
});

test("the full header is said at a release when the start said nothing", () => {
  const { release } = hold();
  assert.deepEqual(release("3", ["src/a.ts"]), [HEADER, "src/a.ts: #2 #3"]);
});

const tail = (id: string, pass: string) => `  tail -f .sandcastle/logs/agent-issue-${id}-${pass}-${id}.log`;

test("a ticket's first tail line passes and its later passes' lines are dropped", () => {
  const keep = createTailFilter();
  assert.equal(keep(tail("12", "impl-12")), true);
  assert.equal(keep(tail("12", "review-12")), false);
  assert.equal(keep(tail("12", "repair-12")), false);
  assert.equal(keep(tail("13", "impl-13")), true, "another ticket keeps its own");
  assert.equal(keep(tail("13", "resolve-13")), false);
});

test("a dim-styled tail line is matched the same", () => {
  const keep = createTailFilter();
  assert.equal(keep(styleText("dim", tail("12", "impl-12"), { validateStream: false })), true);
  assert.equal(keep(styleText("dim", tail("12", "review-12"), { validateStream: false })), false);
  assert.equal(keep("\u001b[2m" + tail("12", "repair-12") + "\u001b[22m"), false);
});

test("a ticket id with hyphens is matched whole", () => {
  const keep = createTailFilter();
  assert.equal(keep(tail("code-review-01", "impl-code-review-01")), true);
  assert.equal(keep(tail("code-review-01", "review-code-review-01")), false);
});

test("a line that is not a tail line always passes", () => {
  const keep = createTailFilter();
  const lines = ["[impl-12] Started on branch agent/issue-12", "  tail -f somewhere/else.log", "tail -f .sandcastle/logs/agent-issue-12-impl-12.log", "plain", ""];
  for (const line of [...lines, ...lines]) assert.equal(keep(line), true, line);
});

test("burndown() installs the filter before the heartbeat and restores console.log where it stops", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /const consoleLog = console\.log;\s*const tailFilter = createTailFilter\(\);\s*console\.log = \(\.\.\.args: unknown\[\]\) => \{\s*if \(tailFilter\(format\(\.\.\.args\)\)\) consoleLog\(\.\.\.args\);/);
  assert.equal(src.split("clearInterval(heartbeat);").length - 1, 2);
  assert.equal(src.split(/clearInterval\(heartbeat\);\s*console\.log = consoleLog;/).length - 1, 2);
  assert.ok(src.indexOf("console.log = (...args") < src.indexOf("const heartbeat = setInterval"));
});
