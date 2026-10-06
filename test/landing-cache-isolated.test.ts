// test/landing.test.ts must not touch the machine-wide pool under the real XDG_CACHE_HOME: landOne
// takes a sandbox slot there, so while a live run held every slot the file waited with no bound,
// and the run saw it as another run asking for a share. Run with a cache directory it is handed,
// the file must leave that directory as it found it (its own temp cache took the slots instead).
//
//   node --test test/landing-cache-isolated.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { runNode } from "./cli-spawn.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));
const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
after(() => rmSync(cache, { recursive: true, force: true }));

test("landing.test.ts takes its slots from its own cache directory, not the environment's", () => {
  // Inside a test run, NODE_TEST_CONTEXT hands a nested run's output to the parent.
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cache };
  delete env.NODE_TEST_CONTEXT;
  const r = runNode(["--test", "--test-reporter=spec", "test/landing.test.ts"], { cwd: kit, env, encoding: "utf8", timeoutMs: 180_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(cache), [], "the file wrote into the cache it was given");
});
