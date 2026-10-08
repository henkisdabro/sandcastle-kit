// The doctor tests that start the full `sandcastle doctor` with the host's PATH put a stub `docker`
// first (test/docker-stub.ts), so a slow or silent real Docker cannot time them out. Here the real
// one is a `docker` that sleeps 120 s: doctor ends at once, and only the stub was started. No Docker, no network.
//
//   pnpm test:file test/doctor-docker-stub.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { dockerStub } from "./docker-stub.ts";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-dockerstub-")));

test("doctor with a docker that sleeps behind the stub ends within seconds and runs only the stub", () => {
  const slowDir = scratch();
  const slowRan = join(slowDir, "ran");
  writeFileSync(join(slowDir, "docker"), `#!/bin/sh\necho ran >> '${slowRan}'\nsleep 120\n`);
  chmodSync(join(slowDir, "docker"), 0o755);
  const stub = dockerStub();
  const started = Date.now();
  const r = runKit(["doctor"], {
    cwd: scratch(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 20_000,
    env: { ...process.env, PATH: stub.first([slowDir, process.env.PATH ?? ""].join(delimiter)), XDG_CONFIG_HOME: scratch(), GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.ok(Date.now() - started < 20_000);
  assert.match(r.stdout, /Docker running/);
  assert.ok(existsSync(stub.calls), "the stub was never called");
  assert.match(readFileSync(stub.calls, "utf8"), /^--version$/m);
  assert.ok(!existsSync(slowRan), "the sleeping docker behind the stub was started");
});
