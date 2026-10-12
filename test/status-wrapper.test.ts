// `status.sh` is a wrapper of a few lines: `sandcastle status`, `status 0`, an interval into a pipe and the
// Herdr popup start it, and every call goes to the TypeScript view (src/status-view.ts) with its arguments,
// environment and exit code, on a machine with no working jq. No Docker, no network, no model calls.
//
//   pnpm test:file test/status-wrapper.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "./cli-spawn.ts";
import { buildFixture } from "./status-fixture.ts";
import { drawFrame, viewEnv } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-wrapper-"));
const fixture = buildFixture("live", join(TMP, "fixture"));
after(() => {
  fixture.stop();
  rmSync(TMP, { recursive: true, force: true });
});

// A jq on PATH that does not run is as good as none: the view must not mind.
const NO_JQ = join(TMP, "no-jq");
mkdirSync(NO_JQ);
writeFileSync(join(NO_JQ, "jq"), "#!/bin/sh\nexit 127\n");
chmodSync(join(NO_JQ, "jq"), 0o755);

const throughWrapper = (args: string[], env: Record<string, string> = {}) => {
  const base = viewEnv(fixture, { TERM_COLS: "120", TERM_ROWS: "400", ...env });
  return spawnSync("bash", [join(KIT, "status.sh"), ...args], {
    encoding: "utf8",
    // The fixture's clock, which test/status-run.ts preloads where it starts the view itself.
    env: { ...base, PATH: [NO_JQ, base.PATH].join(delimiter), NODE_OPTIONS: `--import=${join(KIT, "test/status-clock.ts")}` },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
};

test("status.sh is a wrapper of a few lines that starts the TypeScript view", () => {
  const code = readFileSync(join(KIT, "status.sh"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.ok(code.length <= 5, `status.sh holds ${code.length} lines of code`);
  assert.match(code.at(-1)!, /^exec node .*src\/status-view\.ts" "\$@"$/);
});

test("status 0, status 0 all and an interval into a pipe draw the TypeScript view's frame, with no jq", () => {
  const direct = drawFrame(fixture, { cols: 120 });
  for (const args of [["0", "all"], ["0"], ["10"]]) {
    const r = throughWrapper(args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, direct.raw, args.join(" "));
  }
});

test("the view's exit code and words come through the wrapper: 1 without a project", () => {
  const none = throughWrapper(["0"], { SANDCASTLE_PROJECT: join(TMP, "nowhere") });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /nowhere\/\.sandcastle: No such file or directory/);
  assert.doesNotMatch(none.stderr, /jq/);
});

test("no test switch is left: nothing in the suite or the kit names SANDCASTLE_TEST_STATUS_IMPL or STATUS_STRICT", () => {
  const found: string[] = [];
  const hunt = (dir: string) => {
    for (const e of readdirSync(join(KIT, dir), { withFileTypes: true })) {
      if (!e.isFile() || !/\.(ts|sh|mjs|tsx)$/.test(e.name) || (dir === "test" && e.name === "status-wrapper.test.ts")) continue;
      if (/SANDCASTLE_TEST_STATUS_(IMPL|STRICT)/.test(readFileSync(join(KIT, dir, e.name), "utf8"))) found.push(`${dir}/${e.name}`);
    }
  };
  for (const dir of ["src", "test", "mod/hooks", "herdr"]) hunt(dir);
  assert.deepEqual(found, []);
  assert.doesNotMatch(readFileSync(join(KIT, "status.sh"), "utf8"), /SANDCASTLE_TEST_STATUS/);
});
