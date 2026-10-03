// `pnpmStore: true` keeps the host's pnpm store path out of the committed config: the kit asks the
// host's pnpm for it when the config loads, and adds the mount and the store-dir setup step. A
// literal path (`~/Library/pnpm/store/v11`) was valid on one OS only. A fake `pnpm` on PATH stands
// in for the host's, so no real pnpm, Docker or network is involved.
//
//   pnpm exec tsx --test test/pnpm-store.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const fakeBin = (script: string) => {
  const bin = mkdtempSync(join(tmpdir(), "sc-pnpm-bin-"));
  writeFileSync(join(bin, "pnpm"), script);
  chmodSync(join(bin, "pnpm"), 0o755);
  return bin;
};
const withPath = async <T>(dirs: string[], fn: () => Promise<T>) => {
  const saved = process.env.PATH;
  // Keep /usr/bin and /bin for `sh` and `env`, but put the fake first. An empty `dirs` is "no pnpm".
  process.env.PATH = [...dirs, "/usr/bin", "/bin"].join(delimiter);
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
};
const STORE = '#!/bin/sh\n[ "$1" = store ] && [ "$2" = path ] && echo /fake/pnpm-store/v11\n';
const load = (extra: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-pnpm-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }], ${extra} };\n`);
  return loadProject(root);
};

test("pnpmStore: the host's store is mounted and the sandbox's pnpm pointed at it before setup", async () => {
  const project = await withPath([fakeBin(STORE)], () => load('pnpmStore: true, setup: ["pnpm install --frozen-lockfile"]'));
  assert.deepEqual(project.mounts, [{ hostPath: "/fake/pnpm-store/v11", sandboxPath: "/home/agent/.pnpm-store" }]);
  assert.deepEqual(project.setup, ["pnpm config set store-dir /home/agent/.pnpm-store", "pnpm install --frozen-lockfile"]);
});

test("pnpmStore: other mounts are kept, and a literal mount of the store path is not doubled", async () => {
  const other = '{ hostPath: "~/.cache/uv", sandboxPath: "/home/agent/.cache/uv" }';
  const literal = '{ hostPath: "~/Library/pnpm/store/v11", sandboxPath: "/home/agent/.pnpm-store" }';
  const bin = fakeBin(STORE);
  const added = await withPath([bin], () => load(`pnpmStore: true, mounts: [${other}]`));
  assert.equal(added.mounts.length, 2);
  assert.equal(added.mounts[0].sandboxPath, "/home/agent/.cache/uv");
  const old = await withPath([bin], () => load(`pnpmStore: true, mounts: [${literal}], setup: ["pnpm config set store-dir /home/agent/.pnpm-store", "pnpm install"]`));
  assert.deepEqual(old.mounts.map((m) => m.hostPath), ["~/Library/pnpm/store/v11"]);
  assert.equal(old.setup.filter((c) => c.startsWith("pnpm config set store-dir")).length, 1);
});

test("pnpmStore: without pnpm on the host nothing is mounted, and a note says so", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const project = await withPath([fakeBin("#!/bin/sh\nexit 127\n")], () => load('pnpmStore: true, setup: ["pnpm install"]'));
    assert.deepEqual(project.mounts, []);
    assert.deepEqual(project.setup, ["pnpm install"]);
  } finally {
    console.warn = warn;
  }
  assert.match(warned.join("\n"), /pnpmStore is set but pnpm is not on this host/);
});

test("pnpmStore unset or false asks nothing of the host and adds nothing", async () => {
  const project = await withPath([fakeBin(STORE)], () => load('setup: ["pnpm install"]'));
  assert.deepEqual(project.mounts, []);
  assert.deepEqual(project.setup, ["pnpm install"]);
  const off = await withPath([fakeBin(STORE)], () => load("pnpmStore: false"));
  assert.deepEqual(off.mounts, []);
});

test("pnpmStore must be true or false", async () => {
  await assert.rejects(load('pnpmStore: "yes"'), (e: Error) => e instanceof OperatorError && /`pnpmStore` must be true or false, not "yes"/.test(e.message));
});

test("this repository's own config and the pnpm example name no host path", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of [".sandcastle/config.ts", "examples/node-pnpm/config.ts"]) {
    const text = readFileSync(join(import.meta.dirname, "..", f), "utf8");
    assert.match(text, /^\s*pnpmStore: true,/m, f);
    assert.ok(!/pnpm\/store|\.pnpm-store/.test(text), f);
  }
});
