// `sandcastle changes`, second part: the config keys, environment variables, commands and flags
// added, removed or changed between the git tags of two releases. A made-up kit in a temp git
// repository with two tags; no network, Docker or model calls.
//
//   pnpm test:file test/changes-diff.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { changesDiffLines } = await import("../src/upgrading.ts");

const readme = (rows: string[], env: string[]) => `# Kit

## Configuration

| Field | Default | Meaning |
|---|---|---|
${rows.join("\n")}

<details>

| Variable | Default | |
|---|---|---|
${env.join("\n")}

</details>

## Other

| Field | Default | Meaning |
|---|---|---|
| \`notConfig\` | x | Outside the Configuration section |
`;

const cli = (entries: string[]) => `// sandcastle <command>
//
${entries.map((e) => `//   ${e}`).join("\n")}
//
// Models: environment variables.

import "node:fs";
// ${"   notAnEntry --nope"}
`;

const V1 = {
  readme: readme(
    ["| `name` | required | The name |", "| `concurrency` | `4` | Parallel sandboxes |", "| `implement` / `review` | models | Per agent |"],
    ["| `SKIP_PREFLIGHT=1` | off | Skip the model check |", "| `TICKETS`, `DRY_RUN` | queue label, off | Per run |"],
  ),
  cli: cli([
    "run [TICKET ...] [--dry] [--detach]",
    "                 burn down the queue; --detach starts it apart",
    "stop             stop the live run",
    "old              goes away",
  ]),
};
const V2 = {
  readme: readme(
    ["| `name` | required | The name |", "| `concurrency` | `6` | Parallel sandboxes |", "| `implement` / `review` | models | Per agent |", "| `usagePause` | unset | A new key |"],
    ["| `SKIP_PREFLIGHT=1` | off | Skip the model check |", "| `TICKETS`, `DRY_RUN` | queue label, off | Per run |", "| `USAGE_PAUSE=auto`, `ctrl` or `cmd` | off | A new variable |"],
  ),
  cli: cli([
    "run [TICKET ...] [--dry] [--api-key]",
    "                 burn down the queue; --api-key says yes to billing",
    "stop             stop the live run",
    "pause            hold the run, with --now",
  ]),
};

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

const release = (dir: string, version: string, files: { readme: string; cli: string }, tag = true) => {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "README.md"), files.readme);
  writeFileSync(join(dir, "src/cli.ts"), files.cli);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `release ${version}`);
  if (tag) git(dir, "tag", `v${version}`);
};

const kit = (tagFirst = true) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  git(dir, "init", "-q");
  release(dir, "0.1.0", V1, tagFirst);
  release(dir, "0.2.0", V2);
  return dir;
};
const project = () => mkdtempSync(join(tmpdir(), "sandcastle-project-"));

test("changes lists a config key and an environment variable added between two releases", () => {
  const lines = changesDiffLines(project(), kit(), "0.1.0");
  assert.equal(lines[0], "## Settings and flags, 0.1.0 -> 0.2.0");
  assert.ok(lines.includes("- added `usagePause` (default: unset)"), lines.join("\n"));
  assert.ok(lines.includes("- added `USAGE_PAUSE` (default: off)"), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("`ctrl`") || l.includes("`cmd`")), "a value listed beside a variable's name is not a variable");
});

test("changes shows a changed default as the old and the new value", () => {
  const lines = changesDiffLines(project(), kit(), "v0.1.0");
  assert.ok(lines.includes("- changed `concurrency` default: `4` -> `6`"), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("`name`") || l.includes("SKIP_PREFLIGHT")), "an unchanged row is not listed");
});

test("changes names a flag removed and a flag and a command added", () => {
  const lines = changesDiffLines(project(), kit(), "0.1.0");
  assert.ok(lines.includes("- `run`: added --api-key; removed --detach"), lines.join("\n"));
  assert.ok(lines.includes("- added command `pause` (--now)"), lines.join("\n"));
  assert.ok(lines.includes("- removed command `old`"), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("notAnEntry") || l.includes("notConfig")), "text outside the help entries and the Configuration section is ignored");
});

test("changes counts from the project's update record when --since is not given", () => {
  const root = project();
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/.run/kit-updated"), JSON.stringify({ version: "0.1.0", notes: [] }));
  assert.ok(changesDiffLines(root, kit()).includes("- added `usagePause` (default: unset)"));
});

test("changes says a git tag is missing, as in a shallow clone, instead of comparing", () => {
  const lines = changesDiffLines(project(), kit(false), "0.1.0");
  assert.equal(lines[0], "## Settings and flags, 0.1.0 -> 0.2.0");
  assert.match(lines.join("\n"), /no git tag v0\.1\.0 .*Only the changelog above is shown/);
  assert.ok(!lines.some((l) => l.startsWith("- ")));
});

test("changes says the kit has no tags when it is not a git checkout at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
  assert.match(changesDiffLines(project(), dir, "0.1.0").join("\n"), /no git tag v0\.1\.0 or v0\.2\.0/);
});

test("changes prints no settings part when there is no release to count from or nothing is newer", () => {
  assert.deepEqual(changesDiffLines(project(), kit()), []);
  assert.deepEqual(changesDiffLines(project(), kit(), "0.2.0"), []);
});

test("changes says so when two releases differ in no setting or flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  git(dir, "init", "-q");
  release(dir, "0.1.0", V1);
  release(dir, "0.2.0", V1);
  assert.deepEqual(changesDiffLines(project(), dir, "0.1.0"), ["## Settings and flags, 0.1.0 -> 0.2.0", "", "No config key, environment variable, command or flag was added, removed or changed."]);
});
