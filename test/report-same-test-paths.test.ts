// The closing summary's "Same failing test" line groups only tests that are the same test: two files with one
// basename in different directories are two tests. Made-up facts through render(); no git, Docker, model or network.
//
//   pnpm test:file test/report-same-test-paths.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunRecord } from "../mod/hooks/run-record.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;
type Tickets = NonNullable<RunRecord["tickets"]>;

const facts = (tickets: Tickets): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "1M in / 1k out",
  verify: { green: true, line: "ok" },
  gateCount: 1,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
});
const same = (tickets: Tickets) => render(facts(tickets)).split("\n").filter((l) => l.includes("Same failing test"));
const red = (...failing: string[]) => ({ state: "red" as const, failing });

test("two tickets failing one basename in different directories get no Same failing test line", () => {
  assert.deepEqual(same({ "1": red("pkg/a/index.test.ts > renders"), "2": red("pkg/b/index.test.ts > renders") }), []);
});

test("the same directory and title on two tickets is one Same failing test line", () => {
  assert.deepEqual(same({ "1": red("pkg/a/index.test.ts > renders"), "2": red("pkg/a/index.test.ts > renders") }), [
    "Same failing test: pkg/a/index.test.ts > renders - on #1 #2. Likely one cause: fix it once.",
  ]);
});

test("a name with the basename alone still matches a name with a directory", () => {
  assert.deepEqual(same({ "1": red("index.test.ts > renders"), "2": red("pkg/b/index.test.ts > renders") }), [
    "Same failing test: index.test.ts > renders - on #1 #2. Likely one cause: fix it once.",
  ]);
});

test("a ticket failing two directories' files groups with each ticket that fails the same directory only", () => {
  const out = same({
    "1": red("pkg/a/index.test.ts > renders", "pkg/b/index.test.ts > renders"),
    "2": red("pkg/a/index.test.ts > renders"),
    "3": red("pkg/c/index.test.ts > renders"),
  });
  assert.deepEqual(out, ["Same failing test: pkg/a/index.test.ts > renders - on #1 #2. Likely one cause: fix it once."]);
});

test("a basename-only name that leads two directories' groups on the same tickets is one line", () => {
  const out = render(
    facts({
      "1": red("index.test.ts > renders"),
      "2": red("index.test.ts > renders"),
      "3": red("pkg/a/index.test.ts > renders", "pkg/b/index.test.ts > renders"),
    }),
  ).split("\n");
  assert.deepEqual(out.filter((l) => l.includes("Same failing test")), [
    "Same failing test: index.test.ts > renders - on #1 #2 #3. Likely one cause: fix it once.",
  ]);
  assert.equal(out.filter((l) => l.includes("Fix index.test.ts > renders once")).length, 1);
  assert.ok(!out.some((l) => l.includes("renders, index.test.ts")), "the Next step names the test once");
});
