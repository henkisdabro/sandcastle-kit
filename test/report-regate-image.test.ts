// The closing summary's `Merged <base> re-gated` line names the image the verify ran on. The run's image
// is built before any ticket lands, so when a merged ticket changed a Dockerfile (the kit's base image
// or the project's own layer) the verify ran on the starting image: the line says so, and what to do.
// `changedDockerfiles` reads the change from git; a record from an older kit names no image.
//
//   node --test test/report-regate-image.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
const { changedDockerfiles } = await import("../src/gates.ts");
type Facts = Parameters<typeof render>[0];

const IMAGE = "sandcastle-fixture:0123456789ab";

const facts = (verify: Facts["verify"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: { "1": { state: "merged", title: "a" }, "2": { state: "merged", title: "b" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify,
});

const regated = (verify: Facts["verify"]) => render(facts(verify), true).split("\n").find((l) => l.startsWith("Merged main"));

const NEW_IMAGE = "Merged work changed docker/base.Dockerfile, so this ran on the run's starting image - rebuild and run sandcastle gates to check the new one.";

test("a green verify names the image it ran on", () => {
  assert.equal(regated({ green: true, line: "a=pass", image: IMAGE }), `Merged main re-gated: all 2 gates green on image ${IMAGE}.`);
});

test("merged tickets that changed docker/base.Dockerfile put the starting-image note on the re-gated line", () => {
  assert.equal(regated({ green: true, line: "a=pass", image: IMAGE, dockerfiles: ["docker/base.Dockerfile"] }), `Merged main re-gated: all 2 gates green on image ${IMAGE}. ${NEW_IMAGE}`);
});

test("a red verify names the image and carries the note too: the new image might not be red", () => {
  const line = regated({ green: false, line: "test=fail", image: IMAGE, dockerfiles: ["docker/base.Dockerfile"] });
  assert.equal(
    line,
    `Merged main re-gated: RED TOGETHER (test=fail) on image ${IMAGE} - do not push main until it is fixed. Output: .sandcastle/logs/verify-gates.log ${NEW_IMAGE}`,
  );
});

test("two changed Dockerfiles are both named", () => {
  assert.match(regated({ green: true, line: "a=pass", image: IMAGE, dockerfiles: ["docker/base.Dockerfile", ".sandcastle/Dockerfile"] })!, /Merged work changed docker\/base\.Dockerfile, \.sandcastle\/Dockerfile, so this ran on the run's starting image/);
});

test("a record from an older kit, with no image, keeps its line", () => {
  assert.equal(regated({ green: true, line: "a=pass" }), "Merged main re-gated: all 2 gates green.");
  assert.match(regated({ green: false, line: "test=fail" })!, /^Merged main re-gated: RED TOGETHER \(test=fail\) - do not push main/);
});

test("a record whose image or Dockerfiles are of the wrong type says nothing of them", () => {
  const odd = { green: true, line: "a=pass", image: 7, dockerfiles: "docker/base.Dockerfile" } as unknown as Facts["verify"];
  assert.equal(regated(odd), "Merged main re-gated: all 2 gates green.");
});

// --- changedDockerfiles: what the run's merges changed, read from git between the start and the end ---

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  const commit = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    git(root, "add", file);
    git(root, "commit", "-q", "-m", `change ${file}`);
    return git(root, "rev-parse", "HEAD");
  };
  return { root, commit };
};

test("changedDockerfiles finds the base Dockerfile and the project's own layer, and nothing else", () => {
  const { root, commit } = repo();
  const start = commit("docker/base.Dockerfile", "FROM scratch\n");
  commit(".sandcastle/Dockerfile", "ARG BASE\n");
  const project = { root, dockerfile: ".sandcastle/Dockerfile" };
  assert.deepEqual(changedDockerfiles(project, start, "main"), [".sandcastle/Dockerfile"]);
  const tip = commit("docker/base.Dockerfile", "FROM scratch\nRUN true\n");
  commit("src/app.ts", "x\n");
  assert.deepEqual(changedDockerfiles(project, start, tip), ["docker/base.Dockerfile", ".sandcastle/Dockerfile"]);
  assert.deepEqual(changedDockerfiles({ root }, start, tip), ["docker/base.Dockerfile"], "no config dockerfile: only the base");
});

test("changedDockerfiles is empty when merges changed other files, and when the commits cannot be read", () => {
  const { root, commit } = repo();
  commit("docker/base.Dockerfile", "FROM scratch\n");
  const start = commit("src/a.ts", "a\n");
  commit("src/b.ts", "b\n");
  assert.deepEqual(changedDockerfiles({ root, dockerfile: "./docker/base.Dockerfile" }, start, "main"), []);
  assert.deepEqual(changedDockerfiles({ root }, "no-such-commit", "main"), []);
});

test("a dockerfile path written with ./ is found as git names it", () => {
  const { root, commit } = repo();
  const start = commit("src/a.ts", "a\n");
  commit(".sandcastle/Dockerfile", "ARG BASE\n");
  assert.deepEqual(changedDockerfiles({ root, dockerfile: "./.sandcastle/Dockerfile" }, start, "main"), [".sandcastle/Dockerfile"]);
});
