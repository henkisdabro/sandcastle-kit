// Stop and verify-not-run reasons are strings in the run record, not boolean flags.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRecord } from "../mod/hooks/run-record.ts";
import { line, needing, parse, rows, summarise } from "../mod/hooks/run-state.ts";

const reasons: Partial<RunRecord>[] = [
  { stopped: "main moved" },
  { verify: { green: false, line: "not run", likelyLoad: true, notRun: "no sandbox" } },
];
for (const reason of reasons) {
  test(`the mod keeps needs-you tickets for ${JSON.stringify(reason)}`, () => {
    const record: RunRecord = {
      pid: 1,
      settings: { autonomy: "drain", turn: 2, cap: 20 },
      tickets: { "7": { state: "not landed" }, "8": { state: "conflict" }, "9": { state: "merged" } },
      ...reason,
    };
    const run = parse(JSON.stringify(record))!;
    assert.deepEqual(needing(run), ["#7 not landed", "#8 conflict"], JSON.stringify(reason));
    assert.equal(summarise(run).counts[1], 2);
    assert.match(line(run, true), /needs you 2/);
    assert.deepEqual(rows(run).map((row) => row.split(" ")[1]), ["#7", "#8", "#9"]);
  });
}
