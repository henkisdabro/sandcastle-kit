// `sandcastle queue` shows which tickets implement with their own model or effort
// label, in the run's start-line text, and reports a bad label without stopping the
// listing. A throwaway repo and a fake `gh`; no Docker, no model call, no network.
//
//   pnpm exec tsx --test test/queue-models.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init } = await import("../src/init.ts");

test("queue adds [implement model/effort] for a label, and names a bad label without stopping", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-queue-models-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  const log = console.log;
  console.log = () => {};
  try {
    init(root);
  } finally {
    console.log = log;
  }
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  const issue = (n: number, labels: string[]) =>
    JSON.stringify({ number: n, title: `t${n}`, body: "", updatedAt: "2026-01-01T00:00:00Z", labels: labels.map((name) => ({ name })) });
  const list = `[${[issue(1, ["model:claude-opus-5-5", "effort:max"]), issue(2, []), issue(3, ["effort:turbo"]), issue(4, ["effort:low"])].join(",")}]`;
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  *"issue list"*) cat <<'EOF'\n${list}\nEOF\n  ;;\n  *) echo '[]' ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const r = runKit(["queue"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, IMPL_MODEL: "claude-sonnet-5-5", IMPL_EFFORT: "high", PATH: [bin, process.env.PATH].join(delimiter) },
  });
  assert.equal(r.status, 0, r.stderr);
  const line = (n: number) => r.stdout.split("\n").find((l) => l.includes(`t${n}`)) ?? "";
  assert.match(line(1), /\[implement claude-opus-5-5\/max\]/, r.stdout);
  assert.ok(!line(2).includes("[implement"), r.stdout);
  assert.match(line(3), /effort:turbo/, r.stdout);
  assert.match(line(4), /\[implement claude-sonnet-5-5\/low\]/, r.stdout);
});
