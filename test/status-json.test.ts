// `sandcastle status --json`: one reading of the status view's ticket rows as JSON, for a view other than the
// terminal grid. Each test starts the view's entry as a child process over a status fixture (no Docker, no network)
// and compares what it prints with the `status 0 all` frame of the same fixture, never with `ticketRows` itself.
//
//   pnpm test:file test/status-json.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildFixture, type FixtureKind } from "./status-fixture.ts";
import { drawFrame, readFacts, spawnStatus, viewEnv } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-json-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const json = (fixture: ReturnType<typeof buildFixture>, args: string[]) =>
  spawnStatus(args, { encoding: "utf8", env: viewEnv(fixture), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

for (const kind of ["live", "legacy", "ended"] as FixtureKind[]) {
  test(`status --json of the ${kind} fixture is one escape-free document that agrees with the drawn frame`, () => {
    const fixture = buildFixture(kind, mkdtempSync(join(TMP, `${kind}-`)));
    try {
      const r = json(fixture, ["--json"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes("\u001b"), "an escape sequence in the JSON");
      assert.ok(r.stdout.endsWith("\n") && r.stdout.trim().split("\n").length === 1, "not one line of JSON and a newline");
      const doc = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(doc).sort(), ["counts", "later", "partly", "rows"]);
      assert.ok(Array.isArray(doc.rows) && doc.rows.length > 0, "no rows");

      const drawn = drawFrame(fixture);
      assert.equal(drawn.status, 0, drawn.stderr);
      const facts = readFacts(drawn.raw, fixture.root);
      const shown = doc.rows;
      assert.deepEqual(
        facts.tickets.map((t) => t.id),
        shown.map((row: { shown: string }) => row.shown),
      );
      assert.deepEqual(
        facts.tickets.map((t) => t.state),
        shown.map((row: { state: string }) => row.state),
      );
      // The footer's legend says "ready to land" for the group the rows call "ready".
      for (const [group, n] of Object.entries(facts.counts)) assert.equal(doc.counts[group === "ready to land" ? "ready" : group], n, `count of ${group}`);
      assert.ok(Object.keys(facts.counts).length >= 6, "the frame's legend was not read");
    } finally {
      fixture.stop();
    }
  });
}

test("status 10 --json prints once and exits, whatever else is given", () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "interval-")));
  try {
    for (const args of [["10", "--json"], ["--json", "all"], ["0", "--json", "10"]]) {
      const r = json(fixture, args);
      assert.equal(r.signal, null, `${args.join(" ")} had to be killed`);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(Object.keys(JSON.parse(r.stdout)).sort(), ["counts", "later", "partly", "rows"]);
    }
  } finally {
    fixture.stop();
  }
});

test("status --json with no .sandcastle directory exits 1 with the usual message", () => {
  const dir = mkdtempSync(join(TMP, "none-"));
  const r = spawnStatus(["--json"], { encoding: "utf8", env: { ...process.env, SANDCASTLE_PROJECT: dir }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /status: .*\.sandcastle: No such file or directory/);
});
