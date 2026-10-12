// The status view judges "is this run live" by the rule of mod/hooks/run-live.ts, not by a copy: it imports the
// module's `liveness` and `isKit`, reads the command line with the same `ps` call as the mod, and answers as the
// rule does on a live, a recycled and a gone pid. No Docker, no model calls.
//
//   pnpm test:file test/run-live-contract.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { buildFixture } from "./status-fixture.ts";
import { drawFrame, readFacts } from "./status-run.ts";

const root = join(import.meta.dirname, "..");
const snapshot = readFileSync(join(root, "src/status-snapshot.ts"), "utf8");
const mod = readFileSync(join(root, "mod/hooks/register.tsx"), "utf8");

test("the status view takes the rule from the module and keeps no copy of its match string", () => {
  assert.match(snapshot, /import \{[^}]*\bisKit\b[^}]*\bliveness\b[^}]*\} from "\.\.\/mod\/hooks\/run-live\.ts"/);
  assert.ok(!snapshot.includes(JSON.stringify(RUN_COMMAND)), `src/status-snapshot.ts spells out ${RUN_COMMAND}`);
});

test("the status view and the mod read the command line with the same ps call", () => {
  assert.ok(snapshot.includes('["-p", String(pid), "-o", "command="]'), "the view's ps call");
  assert.ok(mod.includes('["ps", "-p", String(pid), "-o", "command="]'), "the mod's ps call");
});

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-run-live-"));
const fixture = buildFixture("live", TMP);
after(() => {
  fixture.stop();
  rmSync(TMP, { recursive: true, force: true });
});

/** The run state the view's header shows once the record names `pid` as the run's process. */
const stateOf = (pid: number) => {
  const record = join(fixture.root, ".sandcastle/logs/run.json");
  const original = readFileSync(record, "utf8");
  writeFileSync(record, JSON.stringify({ ...JSON.parse(original), pid }));
  try {
    const drawn = drawFrame(fixture, { cols: 200 });
    assert.equal(drawn.status, 0, drawn.stderr);
    return readFacts(drawn.raw, fixture.root).run.state;
  } finally {
    writeFileSync(record, original);
  }
};

test("the view shows the kit's process as running; a stranger holding the pid, and a gone pid, as killed", () => {
  const recorded = JSON.parse(readFileSync(join(fixture.root, ".sandcastle/logs/run.json"), "utf8")).pid;
  assert.match(stateOf(recorded), /^running/);
  assert.match(stateOf(process.pid), /^killed/, "a live process that is not the kit: a recycled pid");
  assert.match(stateOf(spawnSync("true").pid!), /^killed/);
});
