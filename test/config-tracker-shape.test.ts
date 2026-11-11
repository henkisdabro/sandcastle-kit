// `tracker` and `blockers` are checked for shape when the config loads: a kind the kit does not know
// used to mean GitHub Issues, a misspelt `dir` was ignored, a string `done` made `close()` write its
// first letter and a string `blockers.linear` threw partway through a run.
//
//   pnpm test:file test/config-tracker-shape.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const load = (extra: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-tracker-shape-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", gates: [{ name: "t", command: "true" }], ${extra} };\n`);
  return loadProject(root);
};
const refused = async (extra: string, message: RegExp) => {
  await assert.rejects(load(extra), (e: Error) => e instanceof OperatorError && message.test(e.message), extra);
};

test('tracker: "file" is refused, not read as GitHub Issues', async () => {
  await refused('tracker: "file"', /`tracker` must be "github" or "files" or an object.*not "file"/);
});

test('tracker: { type: "Files" } is refused naming tracker.type', async () => {
  await refused('tracker: { type: "Files" }', /`tracker\.type` must be "github" or "files", not "Files"/);
});

test("a tracker object with no type, or a tracker of another type, is refused", async () => {
  await refused('tracker: { dir: "tasks" }', /`tracker\.type` must be/);
  await refused("tracker: 3", /`tracker` must be "github" or "files"/);
  await refused("tracker: [\"files\"]", /`tracker` must be "github" or "files"/);
  await refused("tracker: null", /`tracker` must be "github" or "files"/);
});

test('tracker: { dirr: "tasks" } is refused naming tracker.dirr, before the type is checked', async () => {
  await refused('tracker: { dirr: "tasks" }', /unknown key `tracker\.dirr` - did you mean `tracker\.dir`\?/);
  await refused('tracker: { type: "files", dirr: "tasks" }', /unknown key `tracker\.dirr` - did you mean `tracker\.dir`\?/);
});

test("an empty or non-string tracker.dir is refused", async () => {
  await refused('tracker: { type: "files", dir: "" }', /`tracker\.dir` must be a non-empty string, not ""/);
  await refused('tracker: { type: "files", dir: 3 }', /`tracker\.dir` must be a non-empty string, not 3/);
});

test('tracker.done: "done" (a string, not a list) is refused', async () => {
  await refused('tracker: { type: "files", done: "done" }', /`tracker\.done` must be a non-empty list of strings.*not "done"/);
  await refused('tracker: { type: "files", done: [] }', /`tracker\.done` must be a non-empty list of strings/);
  await refused('tracker: { type: "files", done: [1] }', /`tracker\.done` must be a non-empty list of strings/);
  await refused('tracker: { type: "files", done: [""] }', /`tracker\.done` must be a non-empty list of strings/);
});

test('blockers: { linear: "ENG" } is refused naming blockers.linear', async () => {
  await refused('blockers: { linear: "ENG" }', /`blockers\.linear` must be a list of strings.*not "ENG"/);
});

test("blockers.files must be an object with a string dir and a list done; unknown keys are refused", async () => {
  await refused('blockers: { files: "tasks" }', /`blockers\.files` must be an object/);
  await refused("blockers: { files: { dir: 3 } }", /`blockers\.files\.dir` must be a non-empty string, not 3/);
  await refused('blockers: { files: { dir: "" } }', /`blockers\.files\.dir` must be a non-empty string/);
  await refused('blockers: { files: { dir: "t", done: "done" } }', /`blockers\.files\.done` must be a list of strings.*not "done"/);
  await refused('blockers: { files: { dirr: "t" } }', /unknown key `blockers\.files\.dirr` - did you mean `blockers\.files\.dir`\?/);
});

test("the valid forms still load", async () => {
  assert.equal((await load('tracker: "github"')).tracker.kind, "github");
  assert.equal((await load('tracker: "files"')).tracker.kind, "files");
  assert.equal((await load('tracker: { type: "github" }')).tracker.kind, "github");
  const files = (await load('tracker: { type: "files", dir: "tasks", done: ["done"] }')).tracker;
  assert.deepEqual([files.kind, files.dir, files.done], ["files", "tasks", ["done"]]);
  await load("");
  await load('blockers: { linear: ["ENG"] }');
  await load('blockers: { files: { done: ["x"] } }');
  await load('blockers: { files: { dir: "t", done: ["done"] }, linear: [] }');
});

test("every example config, and each tracker and blockers line of the init template, still loads", async () => {
  const configs = readdirSync("examples", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("config.ts"));
  assert.ok(configs.length >= 2, configs.join());
  for (const f of configs) {
    const root = mkdtempSync(join(tmpdir(), "sc-tracker-shape-"));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle/config.ts"), readFileSync(join("examples", f), "utf8"));
    await loadProject(root).catch((e) => assert.fail(`examples/${f}: ${e.message}`));
  }
  // The template has no gates until `init` fills them in, and its options are commented out.
  const template = readFileSync("templates/config.ts", "utf8");
  const lines = template.split("\n").filter((l) => /^\s*\/\/ (tracker|blockers): /.test(l));
  assert.ok(lines.length >= 4, lines.join("\n"));
  for (const line of lines) {
    const enabled = line.replace(/^(\s*)\/\/ /, "$1").replace(/\s+\/\/ .*$/, "");
    const root = mkdtempSync(join(tmpdir(), "sc-tracker-shape-"));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle/config.ts"), template.replace('name: "my-project",', () => `name: "my-project", gates: [{ name: "t", command: "true" }], ${enabled}`));
    await loadProject(root).catch((e) => assert.fail(`templates/config.ts, ${enabled.trim()}: ${e.message}`));
  }
});
