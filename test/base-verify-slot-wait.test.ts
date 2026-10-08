// The verify's and the base check's wait for a machine-wide sandbox slot is `waitMs` in their timings
// line, not run time: a verify that queued behind another run's sandboxes once recorded the queue as
// `ms`, and the start estimate added it to every later run. Every sandboxes slot is held, the gates
// run for real against a fake docker whose every call succeeds, and the slots are freed a moment
// after the call starts. No Docker or network.
//
//   pnpm test:file test/base-verify-slot-wait.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { quietly } from "./quiet.ts";
import { cache, cleanup, sleep, tix, until } from "./pool-sim.ts";

// pool-sim has pointed the cache and config directories at temp ones; the fake docker and the credentials go there.
const config = process.env.XDG_CONFIG_HOME!;
const bin = join(cache, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
// Made-up credentials: a sandbox's environment needs them, and the fake docker never reads them.
mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
writeFileSync(join(config, "sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
const { requireGreenBase, stepTimes, verifyBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");

afterEach(cleanup);

const root = join(cache, "project");
mkdirSync(join(root, ".sandcastle"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "lint", command: "true" }] };\n`);
git("add", ".gitignore");
git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");

// Held this long before the slots free; the pool looks again every 5 s (gateBase passes no pollMs), so the
// call returns some 5 s after it started, and the wait is at least this.
const HELD_MS = 300;

/** Runs `call` with every machine-wide sandboxes slot held, freed `HELD_MS` after it starts; its result, and how long it ran. */
const behindFullPool = async <T>(call: () => Promise<T>) => {
  const held = tix("other", 6);
  await until(() => held.every((t) => t.taken), "the six slots to be held");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const started = Date.now();
    const running = call();
    await sleep(HELD_MS);
    for (const t of held) t.release();
    const result = await running;
    return { result, elapsed: Date.now() - started };
  } finally {
    process.chdir(cwd);
  }
};

test("the verify's wait for a machine-wide sandboxes slot is waitMs, and stepTimes keeps it out of ms", async () => {
  const project = await loadProject(root);
  const { result: gated, elapsed } = await behindFullPool(() =>
    quietly(() => verifyBase(project, "sandcastle-fixture:t", writePlan(project).file)).then((r) => r.result),
  );
  assert.ok(gated.gates.every((g) => g.pass));
  const waitMs = gated.waitMs ?? 0;
  assert.ok(waitMs >= 300, `waitMs ${waitMs} is at least the time the slots were held`);
  assert.ok(waitMs <= elapsed, `waitMs ${waitMs} is no more than the call's ${elapsed} ms`);
  const times = stepTimes(elapsed, gated);
  assert.equal(times.waitMs, waitMs);
  assert.equal(times.ms, elapsed - waitMs);
});

test("the base check's wait for a machine-wide sandboxes slot is waitMs, and stepTimes keeps it out of ms", async () => {
  const project = await loadProject(root);
  const { result, elapsed } = await behindFullPool(() =>
    quietly(() => requireGreenBase(project, "sandcastle-fixture:t", writePlan(project).file, false)),
  );
  const waitMs = (result.result as { waitMs?: number }).waitMs ?? 0;
  assert.ok(waitMs >= 300, `waitMs ${waitMs} is at least the time the slots were held`);
  assert.ok(waitMs <= elapsed, `waitMs ${waitMs} is no more than the call's ${elapsed} ms`);
  const times = stepTimes(elapsed, result.result);
  assert.equal(times.waitMs, waitMs);
  assert.equal(times.ms, elapsed - waitMs);
});
