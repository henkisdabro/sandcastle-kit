// The update record keeps the update steps a user declined, so `/sandcastle update` names them in a
// line at the next update and does not ask again. A made-up kit and project in temp directories; no network.
//
//   pnpm test:file test/upgrading-declined.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-declined-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { declinedSteps, markUpdated, pendingUpgrades } = await import("../src/upgrading.ts");

const SKILL = readFileSync(new URL("../skill/update.md", import.meta.url), "utf8");

const kit = (release: string) => {
  const dir = mkdtempSync(join(TMP, "kit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: release }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Upgrading\n\n- **A new default.** Words.\n");
  return dir;
};

const project = () => {
  const root = mkdtempSync(join(TMP, "project-"));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  return root;
};
const record = (root: string) => join(root, ".sandcastle/.run/kit-updated");

test("a decline is recorded at the kit's release and a later update without keys keeps it", () => {
  const root = project();
  markUpdated(root, kit("0.11.0"), ["claude-mod", "autonomy-drain"]);
  assert.deepEqual(declinedSteps(root), { "claude-mod": "0.11.0", "autonomy-drain": "0.11.0" });

  markUpdated(root, kit("0.12.0"));
  assert.deepEqual(declinedSteps(root), { "claude-mod": "0.11.0", "autonomy-drain": "0.11.0" });
  assert.equal(JSON.parse(readFileSync(record(root), "utf8")).version, "0.12.0");

  // Declined again, a step moves to the release it was declined at last; the others stay.
  markUpdated(root, kit("0.13.0"), ["claude-mod", "hook-tests"]);
  assert.deepEqual(declinedSteps(root), { "claude-mod": "0.13.0", "autonomy-drain": "0.11.0", "hook-tests": "0.13.0" });
});

test("no step is declined by a record without the field, the older plain form or no record", () => {
  const root = project();
  assert.deepEqual(declinedSteps(root), {});
  writeFileSync(record(root), `${JSON.stringify({ version: "0.10.0", notes: [] })}\n`);
  assert.deepEqual(declinedSteps(root), {});
  writeFileSync(record(root), "1c4f46f0a1b2c3d4e5f60718293a4b5c6d7e8f90\n");
  assert.deepEqual(declinedSteps(root), {});
  writeFileSync(record(root), "{ not json");
  assert.deepEqual(declinedSteps(root), {});
  writeFileSync(record(root), `${JSON.stringify({ version: "0.10.0", notes: [], declined: ["x"] })}\n`);
  assert.deepEqual(declinedSteps(root), {});
});

test("the older plain form is rewritten as the JSON form by a decline", () => {
  const root = project();
  writeFileSync(record(root), "1c4f46f0a1b2c3d4e5f60718293a4b5c6d7e8f90\n");
  markUpdated(root, kit("0.11.0"), ["generated"]);
  assert.deepEqual(declinedSteps(root), { generated: "0.11.0" });
});

test("the pending Upgrading notes are the same with and without declined steps", () => {
  const k = kit("0.11.0");
  const withDeclined = project();
  const without = project();
  writeFileSync(record(withDeclined), `${JSON.stringify({ version: "0.10.0", notes: [], declined: { "claude-mod": "0.10.0" } })}\n`);
  writeFileSync(record(without), `${JSON.stringify({ version: "0.10.0", notes: [] })}\n`);
  assert.deepEqual(pendingUpgrades(withDeclined, k), { recorded: true, since: "0.10.0", notes: ["A new default."] });
  assert.deepEqual(pendingUpgrades(withDeclined, k), pendingUpgrades(without, k));

  markUpdated(withDeclined, k, ["claude-mod"]);
  assert.deepEqual(pendingUpgrades(withDeclined, k).notes, []);
});

test("sandcastle updated --declined records every key it is given", () => {
  const root = project();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const run = (...args: string[]) =>
    runKit(["updated", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_CONFIG_HOME: join(TMP, "config"), XDG_CACHE_HOME: join(TMP, "cache"), GIT_CEILING_DIRECTORIES: tmpdir() },
    });
  const r = run("--declined", "autonomy-drain,claude-mod");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Recorded: this project is up to date with sandcastle-kit/);
  const declined = JSON.parse(readFileSync(record(root), "utf8")).declined;
  assert.deepEqual(Object.keys(declined).sort(), ["autonomy-drain", "claude-mod"]);
  assert.match(declined["claude-mod"], /^\d+\.\d+\.\d+$/);

  // A plain `sandcastle updated` later keeps them.
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(record(root), "utf8")).declined, declined);

  const bad = run("--declined");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: sandcastle updated \[--declined KEY/);
  assert.equal(run("--declined", "a b").status, 1);
});

test("the update action names each declinable step by key, reads declined, and records it in step 4", () => {
  for (const key of ["herdr-plugin", "claude-mod", "hook-tests", "generated", "gate-token", "autonomy-drain", "touches-lines", "api-key", "upgrading-line"]) {
    assert.ok(SKILL.includes(`**\`${key}\`**`), `skill/update.md names no bold key ${key}`);
  }
  assert.match(SKILL, /`declined` in `\.sandcastle\/\.run\/kit-updated`/);
  const step4 = SKILL.slice(SKILL.indexOf("4. **Record and commit.**"), SKILL.indexOf("5. **Fresh sessions.**"));
  assert.match(step4, /sandcastle updated\s+--declined/);
  assert.match(step4, /every key now declined/);
});
