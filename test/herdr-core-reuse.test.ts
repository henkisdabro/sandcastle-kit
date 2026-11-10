// herdr-core: a status terminal left as a bare shell is never typed into. Once a terminal has published an OSC 7501
// status, `hc send` from another terminal wraps the text in `<hc from=...>` tags (hc 0.1.19), so a shell whose view
// died leaving its root record would get a line it cannot run. The stub `hc` here wraps every `send` that way and
// records it; the reused shell must be removed and the view opened afresh instead.
//
//   pnpm test:file test/herdr-core-reuse.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const stub = mkdtempSync(join(tmpdir(), "sandcastle-hc-reuse-"));
const bin = join(stub, "bin");
mkdirSync(bin);
const log = join(stub, "calls.log");
writeFileSync(log, "");
const shell = (labels: object) => JSON.stringify({ address: "t3", state: "live", labels, foreground: { argv: ["/bin/zsh", "-l"] } });
writeFileSync(
  join(bin, "hc"),
  `#!/bin/sh
{ for w in "$@"; do printf '%s\\037' "$w"; done; echo; } >> '${log}'
case "$1" in
  get) if [ "$2" = t-mine ]; then echo '{"address":"t-mine","pid":${process.ppid},"state":"live","labels":{}}'; exit 0; fi
       [ -f '${stub}/removed' ] && { echo '{"error":{"kind":"not_found"}}' >&2; exit 3; }
       cat '${stub}/shell.json' ;;
  rm) : > '${stub}/removed'; echo '{}' ;;
  send) echo 'send must not be used' >&2; exit 1 ;;
  run) echo '{"address":"t9"}' ;;
  *) echo '{}' ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t-mine" });

const { openCoreStatus, projectKey, readCoreView } = await import("../src/herdr-core.ts");

test("a status shell that still carries a root record is replaced by a fresh view, never typed into", () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-"))), "repo");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(stub, "shell.json"), shell({ "sandcastle.root": projectKey(root), "osc7501.root": "state=idle" }));
  const caller = { address: "t-mine", pid: 1, labels: {} };
  assert.equal(openCoreStatus(root, caller, { kit: "/k", instance: "i2" }), "t9");
  const verbs = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\u001f")[0]).filter((v) => v !== "get");
  assert.deepEqual(verbs, ["rm", "run"]);
  assert.deepEqual(readCoreView(root), { instance: "i2", status: "t9", slots: [] });
});
