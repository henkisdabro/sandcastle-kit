// A herdr-core slot whose ticket lands with `ok = true` and the outcome `failed to land` (what the ledger tells it for a
// ticket a later autonomy turn re-runs) reads idle, and its text names the ending; `ok = false` stays blocked.
// Against a fake `hc` on PATH; no herdr-core, no Docker.
//
//   pnpm test:file test/herdr-core-retried-slot.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const stub = mkdtempSync(join(tmpdir(), "sandcastle-hc-retried-"));
const bin = join(stub, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "hc"),
  `#!/bin/sh
case "$1" in
  get) if [ "$2" = t-mine ]; then echo '{"address":"t-mine","pid":${process.ppid},"state":"live","labels":{"herdr.space":"sp1","herdr.tab":"tb1"}}'; exit 0; fi
       echo '{"error":{"kind":"not_found"}}' >&2; exit 3 ;;
  run) echo '{"address":"t8"}' ;;
  *) echo '{}' ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t-mine" });

const { openCoreView, readSlotState, slotStateFile } = await import("../src/herdr-core.ts");
const CALLER = { address: "t-mine", pid: 1, labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } };

const slot = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-retried-")));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const view = openCoreView(root, CALLER, { kit: "/kit", instance: "i1", panes: 1, slots: true, ref: (id) => `#${id}` });
  view.claim("12", "Add cart");
  view.finish("12", "green");
  return { view, state: () => readSlotState(slotStateFile(root, 0)) };
};

test("a slot whose ticket a later turn re-runs reads idle, with `failed to land` as its text", () => {
  const { view, state } = slot();
  view.landed("12", true, "failed to land");
  assert.equal(state()?.state, "idle");
  assert.equal(state()?.phase, "failed to land");
});

test("a slot whose ticket nobody re-runs reads blocked, with the same text", () => {
  const { view, state } = slot();
  view.landed("12", false, "failed to land");
  assert.equal(state()?.state, "blocked");
  assert.equal(state()?.phase, "failed to land");
});
