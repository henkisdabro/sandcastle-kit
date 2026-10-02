// `startDetached` (src/detach.ts): a detached run starts its output log afresh, and the run
// before's output is moved to logs/archive/, not overwritten - it once was, and a person closing
// two runs in a row lost the first one's turn summaries. A plain-JS stand-in, no Docker, no model.
//
//   pnpm exec tsx --test test/detach-output-archive.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OUTPUT_LOG, startDetached } from "../src/detach.ts";

const dir = mkdtempSync(join(tmpdir(), "sandcastle-detach-archive-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fake = join(dir, "fake-run.mjs");
writeFileSync(fake, `console.log("the second run"); process.exit(3);\n`);

test("the run before's output is archived, and the new log holds this run alone", async () => {
  mkdirSync(join(dir, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(dir, OUTPUT_LOG), "the first run\n");
  await startDetached(dir, [], { entry: [fake], inHerdr: true, timeoutMs: 15_000 });
  assert.doesNotMatch(readFileSync(join(dir, OUTPUT_LOG), "utf8"), /the first run/);
  const archived = readdirSync(join(dir, ".sandcastle/logs/archive")).filter((f) => f.startsWith("run-output-"));
  assert.equal(archived.length, 1);
  assert.equal(readFileSync(join(dir, ".sandcastle/logs/archive", archived[0]!), "utf8"), "the first run\n");
});
