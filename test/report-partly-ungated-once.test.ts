// A ticket merged partly done whose reviewer also gave a check-by-hand note is one Needs you bullet, with
// the check on it, and one Next step: the two notes were often the same check in other words, and the
// summary listed the ticket twice (#662). A made-up run record; no Docker, gh, model calls or network.
//
//   pnpm test:file test/report-partly-ungated-once.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");

const section = (out: string, heading: string) => out.split(heading)[1]?.split("\n## ")[0] ?? "";

const facts = (tickets: Record<string, object>, partial: string[]) => ({
  base: "main",
  tracker: "github" as const,
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets,
  runnable: [],
  partial,
  holdLabel: "ready-for-human",
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
});

test("partly done with a check-by-hand note: one bullet carrying both, one next step", () => {
  const out = render(
    facts(
      {
        "7": { state: "merged", title: "Image", unmet: "needs a person: rebuild the image and run a project", ungated: "No image was built here: rebuild it and run a project" },
        "8": { state: "merged", title: "Other", ungated: "Drag the sheet on a phone" },
      },
      ["7"],
    ) as never,
    true,
  );
  const needs = section(out, "## Needs you");
  assert.equal(needs.split("\n").filter((l) => l.startsWith("- #7")).length, 1, needs);
  assert.match(needs, /- #7 .*merged, partly done: needs a person: rebuild the image and run a project; check by hand: No image was built here/);
  assert.match(needs, /- #8 .*merged - check by hand: Drag the sheet on a phone/);
  const next = section(out, "## Next step");
  assert.match(next, /Check #8 by hand/);
  assert.doesNotMatch(next, /Check #7/);
});
