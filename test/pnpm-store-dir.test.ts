// `pnpm store path` prints the versioned directory (`<store-dir>/v11`) and pnpm adds its own `vN` to
// any `store-dir`, so mounting the printed path nested a second store (`v11/v11`) inside the host's.
// The kit mounts the store-dir, the parent, so the sandbox's `<mount>/vN` is the host's own store.
// A fake `pnpm` on PATH stands in for the host's: no real pnpm, Docker or network.
//
//   pnpm test:file test/pnpm-store-dir.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { hostPnpmStore } from "../src/config.ts";

const withStorePath = <T>(printed: string, fn: () => T): T => {
  const bin = mkdtempSync(join(tmpdir(), "sc-pnpm-dir-bin-"));
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\n[ "$1" = store ] && [ "$2" = path ] && echo '${printed}'\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = [bin, "/usr/bin", "/bin"].join(delimiter);
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
};

test("the versioned directory's parent is the store-dir to mount", () => {
  assert.equal(withStorePath("/fake/pnpm/store/v11", () => hostPnpmStore(tmpdir())), "/fake/pnpm/store");
  assert.equal(withStorePath("/fake/pnpm/store/v3", () => hostPnpmStore(tmpdir())), "/fake/pnpm/store");
});

test("a path with no vN segment is mounted as it is, not cut short", () => {
  assert.equal(withStorePath("/fake/pnpm/store", () => hostPnpmStore(tmpdir())), "/fake/pnpm/store");
  assert.equal(withStorePath("/fake/pnpm/vendor", () => hostPnpmStore(tmpdir())), "/fake/pnpm/vendor");
});
