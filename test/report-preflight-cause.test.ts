// A run its preflight refused keeps the cause in the run record (`preflightFailure`), and the closing summary's
// headline shows it, cut to three lines and without the message's own first line, which repeats the headline.
// burndown() needs Docker, so the record write is `recordPreflightFailure`, and its call site is held by a source match.
//
//   pnpm test:file test/report-preflight-cause.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
const { recordPreflightFailure } = await import("../src/run.ts");

const base = {
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:49:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: { "1": { state: "queued", order: 0, title: "t1" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "preflight",
  exitCode: 1,
};

test("a refused preflight's cause is in the run headline", () => {
  const out = render({ ...base, preflightFailure: "NOT STARTED: Preflight failed - no sandbox started:\n  claude-x: model not found" } as never);
  assert.match(out, /^## 🏁 Run NOT STARTED: preflight failed \(exit 1\) - no sandbox started:\n {2}claude-x: model not found$/m);
  assert.doesNotMatch(out, /its cause is the run's last lines/);
});

test("two model lines and the credential hint show in the headline, without the repeated NOT STARTED line", () => {
  const message = [
    "NOT STARTED: Preflight failed - no sandbox started:",
    "  model-a: 401 invalid authentication credentials",
    "  model-b: authentication failed",
    "  The credential was likely rejected: ANTHROPIC_API_KEY from /home/user/.env.",
    "  fourth cause line is omitted",
  ].join("\n");
  const out = render({ ...base, preflightFailure: message } as never);
  assert.match(out, /^## 🏁 Run NOT STARTED: preflight failed \(exit 1\) - no sandbox started:\n {2}model-a: 401 invalid authentication credentials\n {2}model-b: authentication failed\n {2}The credential was likely rejected: ANTHROPIC_API_KEY from \/home\/user\/\.env\.$/m);
  assert.doesNotMatch(out, /fourth cause line|its cause is the run's last lines/);
  assert.equal((out.match(/NOT STARTED/g) ?? []).length, 1);
});

test("a record without the field keeps the pointer to the run's last lines", () => {
  const out = render(base as never);
  assert.match(out, /NOT STARTED: preflight failed \(exit 1\) - no sandbox started; its cause is the run's last lines/);
});

test("the helper burndown calls leaves the message in the record", () => {
  const seen: Record<string, unknown>[] = [];
  recordPreflightFailure({ update: (fields) => seen.push(fields) }, new Error("NOT STARTED: Preflight failed - no sandbox started:\n  m: nope"));
  assert.deepEqual(seen, [{ preflightFailure: "NOT STARTED: Preflight failed - no sandbox started:\n  m: nope" }]);
});

test("burndown's preflight catch records the failure before rethrowing it", () => {
  const src = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
  assert.match(src, /await timed\("", "preflight", \(\) => preflight\(project, image, extraModels, [^\n]*\)\);\n\s+\} catch \(e\) \{\n(?:\s+\/\/.*\n)*\s+recordPreflightFailure\(run, e\);\n\s+throw e;/);
});
