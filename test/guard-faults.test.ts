// Fault injection on every guard reader: `injectGuardFault` (src/verdict.ts) makes one named reader throw, and the
// guard that uses it must then refuse - `refuse` or `unknown`, never `allow` - and a landing hold must carry
// `reader-failed`. Each case first shows the same input allowed with no fault, so the refusal is the fault's doing
// and not the input's. A reader added to `GUARD_READERS` without a case here fails the first test.
// Throwaway temp repositories and a stubbed GitHub on a local port; no Docker, no network, no model call.
//
//   pnpm test:file test/guard-faults.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type { Project } from "../src/config.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { assertGitUnchanged, gitFingerprint, largeFiles, protectedChanges } = await import("../src/guard.ts");
const { tokenVerdict } = await import("../src/doctor.ts");
const { containedHostPath } = await import("../src/host-path.ts");
const { GUARD_READERS, injectGuardFault } = await import("../src/verdict.ts");
type GuardReader = (typeof GUARD_READERS)[number];
type Answer = { kind: string; code?: string };

afterEach(() => injectGuardFault());

// A repository whose agent branch changes `files` over a base holding `base`: nothing in it is held, so every
// guard allows it until a reader fails.
const branch = (base: Record<string, string>, files: Record<string, string>) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-fault-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  const write = (set: Record<string, string>) => {
    for (const [name, content] of Object.entries(set)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
    }
  };
  git("init", "-q", "-b", "main");
  write({ "README.md": "base\n", ...base });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "agent/issue-1");
  write(files);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { project: { root, baseBranch: "main" } as Project, tip: git("rev-parse", "HEAD").trim() };
};

// A GitHub that lets the token read the repository and answers the push probe 403: a token that cannot push.
const github = async <T>(body: () => Promise<T>): Promise<T> => {
  const api = createServer((req, res) => {
    res.statusCode = req.method === "POST" ? 403 : 200;
    res.setHeader("x-ratelimit-remaining", "4999");
    res.end("{}");
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  const before = process.env.SANDCASTLE_TEST_GITHUB_API;
  process.env.SANDCASTLE_TEST_GITHUB_API = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.SANDCASTLE_TEST_GITHUB_API;
    else process.env.SANDCASTLE_TEST_GITHUB_API = before;
    api.close();
  }
};

// Each reader's guards, run once with `fault` injected after the input is built: what each answers. A stop (a
// throw) is a refusal of its own kind, its code the error's words.
const stopped = (fn: () => unknown): Answer => {
  try {
    fn();
    return { kind: "allow" };
  } catch (error) {
    return { kind: "refuse", code: (error as Error).message };
  }
};
const cases: Record<GuardReader, (fault?: GuardReader) => Promise<Record<string, Answer>>> = {
  "branch-changes": async (fault) => {
    const { project, tip } = branch({}, { "src/a.ts": "a\n" });
    injectGuardFault(fault);
    return { protectedChanges: protectedChanges(project, tip), largeFiles: largeFiles(project, tip) };
  },
  manifest: async (fault) => {
    const { project, tip } = branch({ "package.json": '{"name":"demo"}\n' }, { "package.json": '{"name":"demo","description":"x"}\n' });
    injectGuardFault(fault);
    return { protectedChanges: protectedChanges(project, tip) };
  },
  size: async (fault) => {
    const { project, tip } = branch({}, { "src/a.ts": "a\n" });
    injectGuardFault(fault);
    return { largeFiles: largeFiles(project, tip) };
  },
  "token-probe": async (fault) => {
    injectGuardFault(fault);
    return { tokenVerdict: await github(() => tokenVerdict("github_pat_fake", "octo/demo")) };
  },
  "contained-host-path": async (fault) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-fault-")));
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    injectGuardFault(fault);
    return { containedHostPath: containedHostPath(root, ".claude/skills/x") };
  },
  // A fingerprint that cannot be read stops: at a run's start nothing begins, and mid-run the check stops the run.
  fingerprint: async (fault) => {
    const { project } = branch({}, { "src/a.ts": "a\n" });
    const before = gitFingerprint(project);
    injectGuardFault(fault);
    return { gitFingerprint: stopped(() => gitFingerprint(project)), assertGitUnchanged: stopped(() => assertGitUnchanged(project, before, "the test's check")) };
  },
};

test("every guard reader has a fault case", () => {
  assert.deepEqual(Object.keys(cases).sort(), [...GUARD_READERS].sort());
});

for (const reader of GUARD_READERS) {
  test(`a fault in ${reader} refuses where the same input is allowed`, async () => {
    for (const [guard, v] of Object.entries(await cases[reader]())) assert.equal(v.kind, "allow", `${guard} with no fault: ${JSON.stringify(v)}`);
    for (const [guard, v] of Object.entries(await cases[reader](reader))) {
      assert.ok(v.kind === "refuse" || v.kind === "unknown", `${guard} allowed through a fault in ${reader}`);
      // A landing hold says why: the reader failed, not that the branch changed something.
      if (guard === "protectedChanges" || guard === "largeFiles") assert.equal(v.code, "reader-failed", JSON.stringify(v));
      if (guard === "tokenVerdict") assert.equal(v.code, "token-unverified", JSON.stringify(v));
      if (guard === "gitFingerprint" || guard === "assertGitUnchanged") assert.match(v.code ?? "", new RegExp(reader));
    }
  });
}

// A reader that answers, but not in a form the guard can read: no thrown error to catch, so each guard checks the
// answer's shape itself. A `git` first on PATH passes every call to the real one but this answer's.
const garbled = (args: string, answer: string, fn: () => Answer): Answer => {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-fault-bin-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ${args} "*) printf '%s' '${answer}'; exit 0;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    return fn();
  } finally {
    process.env.PATH = path;
  }
};

test("a branch read whose lines do not parse is held with reader-failed", () => {
  const { project, tip } = branch({}, { "src/a.ts": "a\n" });
  for (const v of [garbled("diff --raw", "not a raw line\\0src/a.ts\\0", () => protectedChanges(project, tip)), garbled("diff --raw", "not a raw line\\0src/a.ts\\0", () => largeFiles(project, tip))]) {
    assert.equal(v.kind, "unknown", JSON.stringify(v));
    assert.equal(v.code, "reader-failed");
  }
});

test("a size that is not a number is held with reader-failed", () => {
  const { project, tip } = branch({}, { "src/a.ts": "a\n" });
  const v = garbled("cat-file -s", "many", () => largeFiles(project, tip));
  assert.equal(v.kind, "unknown", JSON.stringify(v));
  assert.equal(v.code, "reader-failed");
});
