// test/weights-reporter.ts, the reporter behind `pnpm test:weights`: run over a made-up suite, it
// prints a WEIGHTS block in test/shard.ts's own format, with each file's top-level test durations
// summed and the files under 2.5 s left out.
//
//   node --test test/weights-reporter.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";

const root = mkdtempSync(join(tmpdir(), "weights-reporter-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "test"));

// Each top-level test waits the given milliseconds inside a nested test: the nested test's time is
// already part of its parent's, so a reporter that counted it too would double the file.
const fixture = (name: string, ...waits: number[]) =>
  writeFileSync(
    join(root, "test", name),
    `import { test } from "node:test";\n` +
      waits.map((ms, i) => `test("t${i}", async (t) => { await t.test("inner", () => new Promise((r) => setTimeout(r, ${ms}))); });\n`).join(""),
  );
fixture("slow.test.ts", 900, 900, 900, 900);
fixture("fast.test.ts", 50);
writeFileSync(join(root, "test", "failing.test.ts"), `import { test } from "node:test";\ntest("slow and red", async () => { await new Promise((r) => setTimeout(r, 2600)); throw new Error("red"); });\n`);

test("it prints a WEIGHTS block of the files at 2.5 s or more, heaviest first, in shard.ts's format", () => {
  const reporter = join(KIT, "test/weights-reporter.ts");
  const r = runNode(["--test", "--test-concurrency=3", `--test-reporter=${reporter}`, "test/slow.test.ts", "test/fast.test.ts", "test/failing.test.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(r.stderr.includes("Error"), false, r.stderr);
  assert.equal(
    r.stdout,
    [
      "const WEIGHTS: Record<string, number> = {",
      '  "test/slow.test.ts": 4,', // four tests of 0.9 s: 3.6 s, to the nearest second, and not 7
      '  "test/failing.test.ts": 3,', // a failing test counts as much as a passing one
      "};",
      "",
    ].join("\n"),
  );
});
