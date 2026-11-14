// herdr-core: a status view that is slow to hand its `--keep` terminal a shell after Ctrl-C (hc 0.1.19 takes about
// 2.5 s, longer on a loaded machine) must not leave two status terminals for one project. The stub `hc` keeps the
// terminal on the view for longer than the kit waits and only shows the shell after the kill.
//
//   pnpm test:file test/herdr-core-slow-recovery.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const stub = mkdtempSync(join(tmpdir(), "sandcastle-hc-slow-"));
const bin = join(stub, "bin");
mkdirSync(bin);
const log = join(stub, "calls.log");
writeFileSync(log, "");
const view = (labels: object) => JSON.stringify({ address: "t3", state: "live", labels, foreground: { argv: ["node", "/k/src/cli.ts", "status"] } });
writeFileSync(
  join(bin, "hc"),
  `#!/bin/sh
{ for w in "$@"; do printf '%s\\037' "$w"; done; echo; } >> '${log}'
case "$1" in
  get) if [ "$2" = t-mine ]; then echo '{"address":"t-mine","pid":${process.ppid},"state":"live","labels":{}}'; exit 0; fi
       [ -f '${stub}/removed' ] && { echo '{"error":{"kind":"not_found"}}' >&2; exit 3; }
       cat '${stub}/view.json' ;;
  rm) : > '${stub}/removed'; echo '{}' ;;
  run) echo '{"address":"t9"}' ;;
  *) echo '{}' ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t-mine" });

const { openCoreStatus, projectKey, readCoreView, statusName } = await import("../src/herdr-core.ts");

test("a status view still running after the wait is ended and replaced by name, never left beside a second one", () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-"))), "repo");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(stub, "view.json"), view({ "sandcastle.root": projectKey(root) }));
  const caller = { address: "t-mine", pid: 1, labels: {} };
  assert.equal(openCoreStatus(root, caller, { kit: "/k", instance: "i2" }), "t9");
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\u001f").slice(0, -1));
  assert.deepEqual(calls.map((c) => c[0]).filter((v) => v !== "get"), ["keys", "kill", "rm", "run"]);
  const run = calls.find((c) => c[0] === "run")!;
  assert.equal(run[run.indexOf("--name") + 1], statusName(root));
  assert.deepEqual(readCoreView(root), { instance: "i2", status: "t9", slots: [], caller: "t-mine", pid: process.pid });
});
