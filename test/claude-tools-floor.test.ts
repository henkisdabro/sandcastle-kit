// A project whose Claude Code is older than 2.1.295 gets a warning from `sandcastle doctor` and
// `sandcastle lean`: the passes' --tools allow-list misses tools that register after launch there.
// No Docker, no network.
//
//   pnpm test:file test/claude-tools-floor.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { belowToolsFloor, toolsFloorLine } from "../src/versions.ts";

test("versions under 2.1.295, and a pre-release of it, are below the floor", () => {
  for (const v of ["2.1.285", "2.1.294", "2.1.295-beta.1", "1.9.999", "2.0.400"]) assert.equal(belowToolsFloor(v), true, v);
});

test("2.1.295 and later are not below the floor, compared as numbers", () => {
  for (const v of ["2.1.295", "2.1.296", "2.2.0", "3.0.0", "2.1.1000", "2.10.0"]) assert.equal(belowToolsFloor(v), false, v);
});

test("the warning names the version, the floor and the fix; none at the floor", () => {
  const line = toolsFloorLine("2.1.294");
  assert.match(line ?? "", /Claude Code 2\.1\.294 applies the passes' tool allow-list only to the tools present at launch/);
  assert.match(line ?? "", /until 2\.1\.295/);
  assert.match(line ?? "", /claudeCode.*pin/);
  assert.match(line ?? "", /check the network/);
  assert.equal(toolsFloorLine("2.1.295"), undefined);
});

test("doctor and the lean command both print toolsFloorLine's line", () => {
  const doctor = readFileSync(new URL("../src/doctor.ts", import.meta.url), "utf8");
  assert.match(doctor, /toolsFloorLine\(versions\.claude\)/);
  assert.match(doctor, /console\.log\(`warn \$\{floorLine\}`\)/);
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const lean = cli.slice(cli.indexOf('case "lean": {'), cli.indexOf('case "lean-apply"'));
  assert.match(lean, /toolsFloorLine\(versions\.claude\)/);
  assert.match(lean, /console\.log\(`\\n {2}WARN \$\{floorLine\}`\)/);
});
