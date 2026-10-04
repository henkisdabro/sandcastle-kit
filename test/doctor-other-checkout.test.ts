// Doctor says so when the project is a different checkout of the kit than the one running: a bare
// `sandcastle` then runs the other checkout's code, and `./bin/sandcastle` runs the project's. An
// ordinary project, and the kit's own checkout, get no such line; the kit's own checkout is checked
// as a project, as it has a project config. No Docker, no network.
//
//   pnpm exec tsx --test test/doctor-other-checkout.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const KIT = join(import.meta.dirname, "..");
const project = (files: Record<string, string>) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-checkout-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return root;
};
const doctor = (root: string) =>
  runKit(["doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() },
  }).stdout;
const note = /^info This project is a different checkout of the kit/m;

test("a project whose package.json names the kit gets the line, with both paths", () => {
  const root = project({ "package.json": '{ "name": "sandcastle-kit" }\n' });
  const out = doctor(root);
  assert.match(out, note);
  const line = out.split("\n").find((l) => note.test(l)) ?? "";
  assert.ok(line.includes(root), line);
  assert.ok(line.includes(realpathSync(KIT)), line);
  assert.match(line, /`\.\/bin\/sandcastle` runs this checkout/);
});

test("a project with the kit's bin/sandcastle gets the line", () => {
  assert.match(doctor(project({ "bin/sandcastle": "#!/bin/sh\n" })), note);
});

test("an ordinary project prints nothing new", () => {
  assert.doesNotMatch(doctor(project({ "package.json": '{ "name": "something-else" }\n' })), /different checkout/);
});

test("the kit's own checkout gets no such line, and is checked as a project", () => {
  const out = doctor(KIT);
  assert.doesNotMatch(out, /different checkout/);
  assert.doesNotMatch(out, /not inside a project/);
  assert.match(out, /^project .+\n/m);
  assert.match(out, /^ok {3}\.sandcastle\/config\.ts$/m);
});
