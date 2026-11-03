// Which terminal host a command runs in (src/terminal-host.ts): herdr-core only when the terminal
// HC_TERMINAL_ID names is an ancestor of this process, else Herdr TUI by HERDR_ENV as always, else none.
// Either host's variables can be stale, in both directions. With no HC_TERMINAL_ID nothing is probed,
// and the commands the Claude Code mod parses never probe at all.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { detectHost, type HostProbe, inHerdr1, PROBE } from "../src/terminal-host.ts";

const probe = (pid: number | undefined, ancestors: number[] = [10, 20, 30]) => {
  const calls: string[] = [];
  const p: HostProbe = {
    core(id) {
      calls.push(`core ${id}`);
      return pid === undefined ? undefined : { address: id, pid, labels: { "herdr.tab": "tb1" } };
    },
    ancestors() {
      calls.push("ancestors");
      return ancestors;
    },
  };
  return { p, calls };
};

test("a core terminal that is an ancestor is core, and wins over stale HERDR_*", () => {
  const { p } = probe(20);
  const host = detectHost({ HC_TERMINAL_ID: "t1", HERDR_ENV: "1", HERDR_PANE_ID: "p1" }, p);
  assert.deepEqual(host, { kind: "core", terminal: { address: "t1", pid: 20, labels: { "herdr.tab": "tb1" } } });
  assert.equal(inHerdr1({ HC_TERMINAL_ID: "t1", HERDR_ENV: "1" }, p), false);
});

test("a stale HC_TERMINAL_ID naming a live terminal that is not an ancestor leaves Herdr TUI as it was", () => {
  const { p } = probe(999);
  assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t1", HERDR_ENV: "1" }, p), { kind: "herdr1" });
  assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t1" }, p), { kind: "none" });
});

test("hc not answering is not core", () => {
  const { p } = probe(undefined);
  assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t1" }, p), { kind: "none" });
  assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t1", HERDR_ENV: "1" }, p), { kind: "herdr1" });
});

test("with no HC_TERMINAL_ID nothing is probed: HERDR_ENV alone decides, as before", () => {
  const { p, calls } = probe(20);
  assert.deepEqual(detectHost({ HERDR_ENV: "1" }, p), { kind: "herdr1" });
  assert.deepEqual(detectHost({ HERDR_ENV: "0" }, p), { kind: "none" });
  assert.deepEqual(detectHost({}, p), { kind: "none" });
  assert.deepEqual(calls, []);
});

/** A stub `hc` on PATH: `get t-mine` answers with this test process's parent (an ancestor), `get t-other` with a pid that is not one, anything else fails; every call is logged. */
const stubHc = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-hc-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(
    join(bin, "hc"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$2" in',
      `  t-mine) echo '{"address":"t-mine","pid":${process.ppid},"labels":{"herdr.space":"sp1"},"state":"live"}' ;;`,
      `  t-other) echo '{"address":"t-other","pid":999999,"labels":{},"state":"live"}' ;;`,
      `  t-done) echo '{"address":"t-done","pid":${process.ppid},"labels":{},"state":"finished"}' ;;`,
      '  *) echo \'{"error":{"kind":"not_found"}}\' >&2; exit 3 ;;',
      "esac",
    ].join("\n") + "\n",
  );
  chmodSync(join(bin, "hc"), 0o755);
  return { bin, log };
};

test("the real probe asks hc and ps, and judges by ancestry and liveness", () => {
  const { bin, log } = stubHc();
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t-mine", HERDR_ENV: "1" }, PROBE), {
      kind: "core",
      terminal: { address: "t-mine", pid: process.ppid, labels: { "herdr.space": "sp1" } },
    });
    assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t-other", HERDR_ENV: "1" }, PROBE), { kind: "herdr1" });
    assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t-done" }, PROBE), { kind: "none" });
    assert.deepEqual(detectHost({ HC_TERMINAL_ID: "t-gone" }, PROBE), { kind: "none" });
    // Asked once per id, however often a command asks.
    detectHost({ HC_TERMINAL_ID: "t-mine" }, PROBE);
    assert.deepEqual(
      readFileSync(log, "utf8").trim().split("\n"),
      ["get t-mine --json", "get t-other --json", "get t-done --json", "get t-gone --json"],
    );
  } finally {
    process.env.PATH = path;
  }
});

test("`--version --json`, which the Claude Code mod parses, never probes a core", () => {
  const { bin, log } = stubHc();
  const r = runKit(["--version", "--json"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HC_TERMINAL_ID: "t-mine", HERDR_ENV: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  assert.equal(existsSync(log), false, "hc was called");
});
