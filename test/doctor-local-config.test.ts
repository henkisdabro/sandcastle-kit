// A clone's own `.sandcastle/config.local.json`: doctor names the file and the keys it set, and gives a
// FIX when git would show it as untracked (a run's clean-tree check then refuses to start), naming the
// ignore line and the exclude file git resolves. No file, no line.
// A temp repo; doctor's machine checks may fail around it; no network needed for these lines.
//
//   pnpm test:file test/doctor-local-config.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const project = (ignore: string, local?: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-localdoc-")));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", tracker: "files", setup: [], autonomy: 1, gates: [{ name: "ok", command: "true" }] };\n');
  writeFileSync(join(root, ".sandcastle/.gitignore"), ignore);
  if (local !== undefined) writeFileSync(join(root, ".sandcastle/config.local.json"), local);
  return root;
};
const doctor = (root: string) =>
  runKit(["doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() },
  }).stdout;

const ALL = ".env\nlogs/\nworktrees/\n.run/\ntriage/\n";

test("an ignored config.local.json is named with its keys, and no FIX", () => {
  const out = doctor(project(`${ALL}config.local.json\n`, '{ "autonomy": 2, "implement": { "model": "m" } }'));
  assert.match(out, /info \.sandcastle\/config\.local\.json sets autonomy, implement\.model over \.sandcastle\/config\.ts/);
  assert.doesNotMatch(out, /FIX  \.sandcastle\/config\.local\.json/);
});

test("a config.local.json that is not ignored is a FIX naming the ignore line and the resolved exclude file", () => {
  const root = project(ALL, '{ "autonomy": 2 }');
  const out = doctor(root);
  assert.match(out, /info \.sandcastle\/config\.local\.json sets autonomy over/);
  assert.match(out, /FIX  \.sandcastle\/config\.local\.json is gitignored\n.*printf '%s\\n' config\.local\.json/);
  assert.ok(out.includes(`echo .sandcastle/config.local.json >> ${join(root, ".git/info/exclude")}`), out);
});

test("without config.local.json doctor says nothing about it", () => {
  assert.doesNotMatch(doctor(project(ALL)), /config\.local\.json/);
});
