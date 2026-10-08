// Doctor's advisory line for triage labels that docs/agents/triage-labels.md maps but GitHub lacks:
// it names the missing ones with one create command, and says nothing when all exist. A fake `gh`
// and a made-up mapping; no Docker, no network.
//
//   pnpm test:file test/doctor-mapped-labels.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = join(tmp, "cache");
process.env.XDG_CONFIG_HOME = join(tmp, "config");
const { mappedLabels } = await import("../src/doctor.ts");

const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), '#!/bin/sh\n[ "$FAKE_GH_FAIL" = 1 ] && exit 1\nprintf \'%s\' "$FAKE_LABELS"\n');
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = bin + delimiter + process.env.PATH;

const table = (rows: Record<string, string>) =>
  "| Role | Label | Meaning |\n|---|---|---|\n" + Object.entries(rows).map(([r, l]) => `| \`${r}\` | \`${l}\` | x |`).join("\n") + "\n";
const project = (name: string, rows?: Record<string, string>) => {
  const root = join(tmp, name);
  mkdirSync(join(root, "docs/agents"), { recursive: true });
  if (rows) writeFileSync(join(root, "docs/agents/triage-labels.md"), table(rows));
  return root;
};
const mapping = { "needs-triage": "needs-triage", "needs-info": "needs-info", "ready-for-agent": "ready-for-agent", "ready-for-human": "needs-human-hands", wontfix: "wontfix" };

test("a mapped label missing on GitHub is named with one create command", () => {
  process.env.FAKE_GH_FAIL = "0";
  process.env.FAKE_LABELS = '[{"name":"ready-for-agent"},{"name":"wontfix"}]';
  const m = mappedLabels(project("missing", mapping));
  assert.equal(m.state, "missing");
  assert.deepEqual(m.missing, ["needs-info", "needs-human-hands"]);
  assert.equal(
    m.fix,
    "`gh label create needs-info --description 'Waiting on reporter for more information' && gh label create needs-human-hands --description 'Requires human implementation'`",
  );
});

test("nothing is said when every mapped label exists, whatever its case", () => {
  process.env.FAKE_GH_FAIL = "0";
  process.env.FAKE_LABELS = '[{"name":"Needs-Info"},{"name":"needs-human-hands"},{"name":"wontfix"}]';
  assert.equal(mappedLabels(project("present", mapping)).state, "ok");
});

test("nothing is said without a mapping, or when gh cannot answer", () => {
  process.env.FAKE_GH_FAIL = "0";
  process.env.FAKE_LABELS = "[]";
  assert.equal(mappedLabels(project("unmapped")).state, "ok");
  process.env.FAKE_GH_FAIL = "1";
  assert.equal(mappedLabels(project("offline", mapping)).state, "not checked");
});
