// What `sandcastle init` and an empty `sandcastle queue` say to do next: a fresh
// project has no queued tickets, and a kit that stops at "(empty)" leaves the
// operator to guess where work comes from. A throwaway repo and a fake `gh`;
// no Docker, no model call, no network.
//
//   pnpm test:file test/next-step.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init } = await import("../src/init.ts");

const project = (t: { after: (fn: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-next-step-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  return root;
};

const captured = (fn: () => void) => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
};

test("init closes with the next steps and where work comes from", (t) => {
  const out = captured(() => init(project(t)));
  for (const step of ["sandcastle build", "sandcastle lean", "sandcastle gates", "/sandcastle queue", "ready-for-agent"]) {
    assert.ok(out.includes(step), `init output names ${step}:\n${out}`);
  }
});

test("an empty queue counts the open issues and names the choices; --json stays bare", (t) => {
  const root = project(t);
  captured(() => init(root));
  // POSIX sh, matched on the arguments only: the queue read carries --label, the open read does not.
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
  *"issue list"*--label*) echo '[]' ;;
  *"issue list"*) echo '[{"number":1,"title":"a","body":"","updatedAt":"2026-01-01T00:00:00Z","labels":[]},{"number":2,"title":"b","body":"","updatedAt":"2026-01-01T00:00:00Z","labels":[]}]' ;;
  *) echo '[]' ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const run = (...args: string[]) =>
    // runKit starts this node, not bin/sandcastle: that finds `node` on PATH, and a mise or asdf shim there
    // reads its config from the XDG_CONFIG_HOME this file points at a temp dir, then exits.
    runKit(["queue", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME },
    });

  const human = run();
  assert.equal(human.status, 0, human.stderr);
  assert.ok(human.stdout.includes("2 open ticket(s) not in the queue"), human.stdout);
  assert.ok(human.stdout.includes("/sandcastle queue"), human.stdout);

  const json = run("--json");
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout.trim(), "[]");
});
