// docker/base.Dockerfile read as text (no Docker): the npm cache is dropped in the
// layer that fills it, the build checks the git `sandcastle preview` needs, and the
// full trixie base stays, with the reasons written down.
//
//   node --test test/base-dockerfile.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docker", "base.Dockerfile"), "utf8");

// One entry per instruction: backslash continuations joined, comment lines dropped.
const instructions = text
  .replace(/\\\r?\n/g, " ")
  .split("\n")
  .filter((l) => !l.trim().startsWith("#") && l.trim() !== "");
const runs = instructions.filter((l) => /^RUN\s/.test(l));

test("every npm install -g clears the npm cache in the same RUN", () => {
  const installs = runs.filter((l) => /npm install -g/.test(l));
  assert.ok(installs.length > 0, "expected at least the Codex install");
  for (const run of installs) assert.match(run, /npm install -g .*&& npm cache clean --force/, run);
});

test("a RUN checks the git version at build, naming sandcastle preview", () => {
  const check = runs.find((l) => /2\.47|--write-tree/.test(l));
  assert.ok(check, "no RUN checks git 2.47");
  assert.match(check, /sandcastle preview/);
  assert.match(check, /exit 1/);
});

test("the git check is POSIX sh and compares versions correctly", () => {
  const check = runs.find((l) => /2\.47|--write-tree/.test(l))!.replace(/^RUN\s+/, "");
  // Stand in for git so the check runs against made-up versions, on any platform.
  const run = (version: string) => {
    try {
      execFileSync("/bin/sh", ["-c", `git() { echo "git version ${version}"; }\n${check}`], { stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch {
      return false;
    }
  };
  for (const ok of ["2.47.0", "2.47.3", "2.50.1", "3.0.0", "2.100.0"]) assert.ok(run(ok), ok);
  for (const bad of ["2.46.9", "2.39.5", "1.99.0", "2.9.0"]) assert.ok(!run(bad), bad);
});

test("the base stays the full node:24-trixie, never -slim", () => {
  assert.ok(instructions.includes("FROM node:24-trixie"), "FROM node:24-trixie changed");
  assert.ok(!instructions.some((l) => /^FROM .*-slim/.test(l)), "FROM uses a -slim image");
});

test("the header comment records why not -slim", () => {
  const comments = text.split("\n").filter((l) => l.startsWith("#")).join("\n");
  assert.match(comments, /-slim/);
  assert.match(comments, /python3/);
  assert.match(comments, /Alpine/);
});

test("the image stops on SIGKILL, so docker stop does not wait out its 10 s for sleep", () => {
  assert.ok(instructions.some((l) => /^STOPSIGNAL\s+SIGKILL\s*$/.test(l)), "expected STOPSIGNAL SIGKILL");
});

// The JSON (exec) form of an instruction, parsed, or undefined when it is missing or in shell form.
const execForm = (name: string): string[] | undefined => {
  const line = instructions.find((l) => new RegExp(`^${name}\\s`).test(l));
  if (!line) return undefined;
  try {
    return JSON.parse(line.replace(new RegExp(`^${name}\\s+`), ""));
  } catch {
    return undefined;
  }
};

test("PID 1 is tini, so orphans of exec'd processes are reaped instead of staying zombies", () => {
  assert.deepEqual(execForm("ENTRYPOINT"), ["tini", "--"]);
});

test("the default command is sleep infinity, so a hand-run docker run <image> bash gets a shell", () => {
  assert.deepEqual(execForm("CMD"), ["sleep", "infinity"]);
});

test("an apt-get install RUN installs tini", () => {
  assert.ok(runs.some((l) => /apt-get install -y [^&]*\btini\b/.test(l)), "no apt-get install names tini");
});
