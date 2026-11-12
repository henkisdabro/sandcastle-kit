// The drain's end line gives the whole run - its span, the tickets landed and the tokens - not only the turn count:
// `drainLine` words the figures, `drainTotals` sums them over the run's turns (the record and the earlier turns in
// history.jsonl, never an older run's), and `sandcastle report` renders the record's line with the last finish as its end.
// No gh, Docker or network. The zone is UTC so the HH:MM figures are the same on every machine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.TZ = "UTC";
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { drainLine } = await import("../src/autonomy.ts");
const { drainTotals, gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");

const CAUSE = "no ticket is left to run again";
const FOURTEEN = ["920", "921", "922", "923", "924", "925", "926", "927", "928", "929", "932", "933", "934", "935"];
const tokens = { input: 1_000_000, cacheWrite: 1_800_000, cacheRead: 50_000_000, output: 406_000 };

test("the drain line gives the run's span, the tickets landed and the tokens", () => {
  assert.equal(
    drainLine(4, 14, CAUSE, { started: "2026-01-01T14:32:00Z", ended: "2026-01-01T16:54:00Z", ids: FOURTEEN, tokens }),
    "Drain: 4 turns, 14:32 to 16:54 (2h 22m), 14 landed (#920 #921 #922 #923 #924 #925 #926 #927 #928 #929 #932 #933 #934 #935), tokens 52.8M in / 406k out, stopped because no ticket is left to run again",
  );
});

test("the drain line writes out 20 tickets and counts the rest", () => {
  const ids = Array.from({ length: 22 }, (_, i) => String(i + 1));
  const line = drainLine(2, 22, CAUSE, { ids });
  const refs = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(" ");
  assert.equal(line, `Drain: 2 turns, 22 landed (${refs} and 2 more), stopped because ${CAUSE}`);
});

test("a record without the run's figures keeps the short drain line", () => {
  assert.equal(drainLine(4, 14, CAUSE), `Drain: 4 turns, 14 landed, stopped because ${CAUSE}`);
});

const turn = (n: number, startedAt: string, merged: string[], pid = 50) => ({
  startedAt,
  pid,
  orchestrator: "sandcastle-kit",
  settings: { autonomy: "drain", turn: n },
  tickets: Object.fromEntries(merged.map((id) => [id, { state: id.startsWith("x") ? "red" : "merged", title: id }])),
});
const timing = (run: string, input: number, output: number) => JSON.stringify({ run, tokens: { input, cacheWrite: 0, cacheRead: 0, output }, model: "m" });

/** A project whose history holds an older run's turn 1 and this run's turns 1 and 2, with this run's turn 3 in run.json. */
const project = (extra: object = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const old = turn(1, "2026-01-01T08:00:00Z", ["1", "2"]);
  const t1 = turn(1, "2026-01-01T10:00:00Z", ["10", "11", "x12"]);
  const t2 = turn(2, "2026-01-01T11:00:00Z", ["11", "13"]);
  const t3 = { ...turn(3, "2026-01-01T12:00:00Z", ["14", "10"]), finishedAt: "2026-01-01T12:40:00Z", stage: "report", exitCode: 0, verify: { green: true, line: "ok" }, ...extra };
  writeFileSync(join(root, ".sandcastle/logs/history.jsonl"), [old, t1, t2].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(t3));
  writeFileSync(
    join(root, ".sandcastle/logs/timings.jsonl"),
    [timing(old.startedAt, 900, 90), timing(t1.startedAt, 100, 10), timing(t2.startedAt, 200, 20), timing(t3.startedAt, 300, 30), timing(t3.startedAt, 5, 1)].join("\n") + "\n",
  );
  return { root, run: t3 };
};

test("the run's totals cover its own turns only, not an older run's", () => {
  const { root, run } = project();
  const totals = drainTotals(root, run, "2026-01-01T12:41:00Z");
  assert.equal(totals.started, "2026-01-01T10:00:00Z");
  assert.equal(totals.ended, "2026-01-01T12:41:00Z");
  // Turn by turn in each record's key order, once each; a ticket that was not merged is out.
  assert.deepEqual(totals.ids, ["10", "11", "13", "14"]);
  assert.deepEqual(totals.tokens, { input: 100 + 200 + 300 + 5, cacheWrite: 0, cacheRead: 0, output: 10 + 20 + 30 + 1 });
});

test("sandcastle report ends the drain line at the last turn's finish", async () => {
  const drain = { turns: 3, landed: 4, cause: CAUSE, started: "2026-01-01T10:00:00Z", ended: "2026-01-01T12:59:00Z", ids: ["10", "11", "13", "14"], tokens: { input: 635, cacheWrite: 0, cacheRead: 0, output: 61 } };
  const { root } = project({ drain });
  const text = render(await gather({ root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any, () => undefined), true);
  assert.ok(
    text.split("\n").includes(`Drain: 3 turns, 10:00 to 12:40 (2h 40m), 4 landed (#10 #11 #13 #14), tokens 635 in / 61 out, stopped because ${CAUSE}`),
    text,
  );
});
