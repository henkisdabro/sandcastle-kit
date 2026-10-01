// An adopted Herdr tab keeps an operator's label (src/herdr.ts), against a fake
// `herdr` on PATH: no Herdr, no Docker.
//
//   pnpm exec tsx --test test/herdr.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Answers only what openSandboxView asks of an adopted, lone tab; logs every call.
// Plain bash 3.2: no associative arrays, no mapfile.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1"}}}' ;;
  "tab get") printf '{"result":{"tab":{"pane_count":1,"label":"%s"}}}\\n' "$FAKE_LABEL" ;;
  "pane layout") printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"p1","rect":{"width":200}}]}}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"p2"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-herdr-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
// IN_HERDR is read when the module loads, so the environment comes first.
const { defaultTabLabel, openSandboxView } = await import("../src/herdr.ts");

const adopt = (label: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-herdr-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "herdr-calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  process.env.FAKE_LABEL = label;
  openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`);
  return readFileSync(log, "utf8").split("\n");
};

test("defaultTabLabel: only Herdr's bare-number label counts as default", () => {
  for (const label of [undefined, "", "1", "12"]) assert.equal(defaultTabLabel(label), true, String(label));
  for (const label of ["sandcastle shop", "sandcastle shop run 4", "build"]) assert.equal(defaultTabLabel(label), false, label);
});

test("an adopted tab with an operator's label is not renamed", () => {
  const calls = adopt("sandcastle shop run 4");
  assert.equal(calls.some((c) => c.startsWith("tab rename")), false);
  assert.ok(calls.includes("pane rename p1 sandcastle run shop"));
});

test("an adopted tab with Herdr's default label is renamed", () => {
  const calls = adopt("3");
  assert.ok(calls.includes("tab rename t1 sandcastle shop"));
  assert.ok(calls.includes("pane rename p1 sandcastle run shop"));
});
