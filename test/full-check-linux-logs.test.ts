// full-check's Linux leg runs in a `--rm` container, so its shard logs must be copied out to the
// log directory (a bind mount) before the container goes, pass or fail, and a failure must name
// that directory. No Docker here: the leg's text is held, and `bash -n` and the shell portability
// tests parse it.
//
//   pnpm test:file test/full-check-linux-logs.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const script = readFileSync(join(KIT, "test/full-check.sh"), "utf8");
const leg = script.slice(script.indexOf("leg_linux() {"), script.indexOf("# The lines of a file that name a real home"));

test("the Linux leg bind-mounts a directory of the log directory for the shard logs", () => {
  assert.match(leg, /mkdir -p "\$logs\/linux-shards"/);
  assert.match(leg, /-v "\$logs\/linux-shards:\/out"/);
});

test("the shard logs are copied out after the suite, whatever its result, and handed to the host user", () => {
  const suite = leg.indexOf("runuser -u node");
  const copy = leg.indexOf("cp -R /tmp/shards/. /out/");
  const chown = leg.indexOf('chown -R "$HOST_UID:$HOST_GID" /out');
  const exit = leg.indexOf('exit "$rc"');
  assert.ok(suite > 0 && copy > suite && chown > copy && exit > chown, "suite, then copy, then chown, then exit with the suite's status");
  assert.doesNotMatch(leg, /exec runuser/, "an exec would end the script before the copy");
  assert.match(leg, /-e HOST_UID="\$\(id -u\)" -e HOST_GID="\$\(id -g\)"/);
});

test("a failing Linux leg names the shard log directory", () => {
  assert.match(leg, /echo "FAIL \(shard logs: \$logs\/linux-shards\)"/);
});
