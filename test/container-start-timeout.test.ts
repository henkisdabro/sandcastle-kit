// A sandbox that takes too long to start (Sandcastle's 120 s `ContainerStartTimeoutError`, or the `docker run` of
// `sandcastle lean`'s hook check ending at its time limit) is an `OperatorError` naming the cause and the fix, which
// `cli.ts` prints as a message with no stack trace. The library's error is built the way it arrives through
// `Effect.runPromise` (a `FiberFailure` that keeps the message); `docker` is a fake shell script. No Docker, model or network.
//
//   pnpm test:file test/container-start-timeout.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { containerStartTimeout, dockerRunTimeout, OperatorError } from "../src/errors.ts";
import { openOrAbandon } from "../src/guard.ts";

const src = (file: string) => readFileSync(join(import.meta.dirname, "../src", file), "utf8");

const project = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-start-timeout-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  return { root, name: "fixture", baseBranch: "main" } as Project;
};

/** What `createSandbox` rejects with when the container does not start in time: `runPromise` wraps the tagged error. */
const libraryTimeout = (message: string) => Object.assign(new Error(message), { name: "(FiberFailure) Error" });

const NAMES_CAUSE_AND_FIX = /Docker took longer than 120 s to start a container.*busy.*retry once the machine is quieter/s;

test("a sandbox open that hits the container-start timeout is an OperatorError naming the cause and the fix", async () => {
  for (const message of ["Sandbox container start timed out after 120000ms", "Isolated sandbox container start timed out after 120000ms"]) {
    const error = await openOrAbandon(project(), "sandcastle/base-gates-1", async () => {
      throw libraryTimeout(message);
    }).catch((e) => e);
    assert.ok(error instanceof OperatorError, `${message}: ${error}`);
    assert.match(error.message, NAMES_CAUSE_AND_FIX);
    assert.doesNotMatch(error.message, /\bat \S+ \(|FiberFailure/, "no stack trace or library wrapper in the words");
  }
});

test("the timeout is read from the tagged error too, with its own figure", () => {
  const error = containerStartTimeout(Object.assign(new Error("x"), { _tag: "ContainerStartTimeoutError", timeoutMs: 90_000 }));
  assert.match(error?.message ?? "", /longer than 90 s to start a container/);
});

test("any other open failure is thrown as it was", async () => {
  const original = new Error("worktree add failed");
  const error = await openOrAbandon(project(), "agent/issue-3", async () => {
    throw original;
  }).catch((e) => e);
  assert.equal(error, original);
});

test("a docker that outlasts its time limit is an OperatorError naming the cause and the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-slow-docker-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "docker"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(dir, "docker"), 0o755);
  const r = spawnSync(join(dir, "docker"), ["run"], { timeout: 200, stdio: "ignore" });
  const error = dockerRunTimeout(r.error, 120, "start a container and check the hooks in it");
  assert.ok(error instanceof OperatorError);
  assert.match(error.message, /Docker took longer than 120 s to start a container and check the hooks in it.*busy.*retry once the machine is quieter/s);
  assert.equal(dockerRunTimeout(new Error("exit 1"), 120, "x"), undefined, "a docker that failed is not a timeout");
});

test("every sandbox open goes through openOrAbandon, and lean's hook check turns ETIMEDOUT into the same error", () => {
  for (const file of ["gates.ts", "land.ts", "burndown.ts"]) {
    const text = src(file);
    assert.match(text, /openOrAbandon\(project, branch, \(\) => createSandbox\(/, file);
    assert.equal(text.match(/createSandbox\(/g)?.length, 1, `${file} opens a sandbox only through openOrAbandon`);
  }
  assert.match(src("lean.ts"), /catch \(error\) \{\s*throw dockerRunTimeout\(error, HOOK_CHECK_SECONDS,/);
});
