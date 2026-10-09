// A sandbox's git never starts background maintenance in the `.git` every sandbox shares: the
// environment every sandbox is built with carries `GIT_CONFIG_*` pairs for `gc.auto=0` and
// `maintenance.auto=false`, after any pair already there. No Docker, no gh, no network.
//
//   pnpm test:file test/sandbox-git-maintenance-off.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
const userEnv = join(xdg, "sandcastle-kit", ".env");
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
const credentialsFile = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n";
writeFileSync(userEnv, credentialsFile);
const { sandboxEnv } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const project = { root: mkdtempSync(join(tmpdir(), "sandcastle-maintenance-")), tracker: fakeTracker() } as unknown as Project;

/** The `[key, value]` pairs git would read from an environment, as git reads them. */
const pairs = (env: Record<string, string>) =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

test("a sandbox's environment turns off git's auto gc and background maintenance", () => {
  writeFileSync(userEnv, credentialsFile);
  const env = sandboxEnv(project);
  assert.deepEqual(pairs(env), [["gc.auto", "0"], ["maintenance.auto", "false"]]);
  assert.equal(env.GH_TOKEN, "github_pat_fake", "the credentials stay");
});

test("pairs the credentials files already carry stay, and the maintenance pairs follow them", () => {
  writeFileSync(userEnv, `${credentialsFile}GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.abbrev\nGIT_CONFIG_VALUE_0=12\n`);
  const env = sandboxEnv(project);
  assert.deepEqual(pairs(env), [["core.abbrev", "12"], ["gc.auto", "0"], ["maintenance.auto", "false"]]);
  assert.equal(env.GIT_CONFIG_COUNT, "3");
});

test("a count that is not a whole number is read as none, not as a hole in the pairs", () => {
  writeFileSync(userEnv, `${credentialsFile}GIT_CONFIG_COUNT=lots\n`);
  assert.deepEqual(pairs(sandboxEnv(project)), [["gc.auto", "0"], ["maintenance.auto", "false"]]);
});

test("git, given that environment, reads both settings off even where the repository's own config says on", () => {
  writeFileSync(userEnv, credentialsFile);
  const env = sandboxEnv(project);
  const repo = mkdtempSync(join(tmpdir(), "sandcastle-maintenance-repo-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG"))) as Record<string, string>;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...clean, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("GIT_CONFIG_"))) },
    }).trim();
  git("init", "-q");
  writeFileSync(join(repo, ".git", "config"), `${readFileSync(join(repo, ".git", "config"), "utf8")}[gc]\n\tauto = 6700\n[maintenance]\n\tauto = true\n`);
  assert.equal(git("config", "--get", "gc.auto"), "0");
  assert.equal(git("config", "--get", "--type=bool", "maintenance.auto"), "false");
});

test("every sandbox the kit opens is built from that environment", () => {
  const source = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /env: sandboxEnv\(project\)/, "sandboxConfig hands the container sandboxEnv");
  // A ticket's, a landing's and a gate-only sandbox all open through sandboxConfig; nothing else builds one.
  for (const file of ["burndown.ts", "land.ts", "gates.ts"]) {
    assert.match(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), /\.\.\.sandboxConfig\(project, image, planFile\)/, file);
  }
  assert.equal(source.match(/\bdocker\(\{/g)?.length, 1, "one place builds a docker sandbox");
});
