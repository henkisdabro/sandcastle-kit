// herdr-core: a status terminal left as a bare shell is never typed into. Once a terminal has published an OSC 7501
// status, `hc send` from another terminal wraps the text in `<hc from=...>` tags (hc 0.1.19), so a shell whose view
// died leaving its root record would get a line it cannot run. The stub `hc` here refuses every `send` and
// records it; the reused shell must be removed and the view opened afresh instead.
//
//   pnpm test:file test/herdr-core-reuse.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

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
       [ -f '${stub}/vanish' ] && [ -f '${stub}/keyed' ] && { echo '{"error":{"kind":"not_found"}}' >&2; exit 3; }
       cat '${stub}/shell.json' ;;
  rm) [ -f '${stub}/rm-fails' ] && { echo '{"error":{"message":"terminal is live"}}' >&2; exit 1; }
      : > '${stub}/removed'; echo '{}' ;;
  keys) : > '${stub}/keyed'; echo '{}' ;;
  send) echo 'send must not be used' >&2; exit 1 ;;
  run) echo '{"address":"t9"}' ;;
  *) echo '{}' ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t-mine" });

const { openCoreStatus, projectKey, readCoreView, statusName } = await import("../src/herdr-core.ts");

const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\u001f").slice(0, -1));
const verbs = () => calls().map((c) => c[0]).filter((v) => v !== "get");
const setUp = (rmFails = false) => {
  for (const f of ["removed", "rm-fails", "vanish", "keyed"]) rmSync(join(stub, f), { force: true });
  if (rmFails) writeFileSync(join(stub, "rm-fails"), "");
  writeFileSync(log, "");
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-"))), "repo");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(stub, "shell.json"), shell({ "sandcastle.root": projectKey(root), "osc7501.root": "state=idle" }));
  return root;
};
const caller = { address: "t-mine", pid: 1, labels: {} };

test("a status shell that still carries a root record is replaced by a fresh view, never typed into", () => {
  const root = setUp();
  assert.equal(openCoreStatus(root, caller, { kit: "/k", instance: "i2" }), "t9");
  assert.deepEqual(verbs(), ["kill", "rm", "run"]);
  const run = calls().find((c) => c[0] === "run")!;
  assert.equal(run[run.indexOf("--name") + 1], statusName(root));
  assert.deepEqual(readCoreView(root), { instance: "i2", status: "t9", slots: [], caller: "t-mine", pid: process.pid });
});

const withShell = (root: string, doc: object) => writeFileSync(join(stub, "shell.json"), JSON.stringify({ address: "t3", ...doc }));
const view = ["node", "/k/src/cli.ts", "status"];

// The shell is live, and the kit never relies on hc removing a live terminal: one hc would not remove keeps the
// name, and this run's view still opens, unnamed, rather than the run starting with no status view. The old
// terminal is the person's to close, and one line names it.
test("a status shell hc will not remove costs the view its name, never the view, and one line names the old terminal", async () => {
  const root = setUp(true);
  const { result, lines } = await quietly(() => openCoreStatus(root, caller, { kit: "/k", instance: "i2" }));
  assert.equal(result, "t9");
  assert.deepEqual(verbs(), ["kill", "rm", "run"]);
  const run = calls().find((c) => c[0] === "run")!;
  assert.ok(!run.includes("--name"), run.join(" "));
  assert.deepEqual(readCoreView(root), { instance: "i2", status: "t9", slots: [], caller: "t-mine", pid: process.pid });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /\bt3\b/);
});

test("a finished status terminal hc will not remove gives the unnamed view and the line, never no view", async () => {
  const root = setUp(true);
  withShell(root, { state: "finished", labels: { "sandcastle.root": projectKey(root) } });
  const { result, lines } = await quietly(() => openCoreStatus(root, caller, { kit: "/k", instance: "i2" }));
  assert.equal(result, "t9");
  assert.deepEqual(verbs(), ["rm", "run"]);
  const run = calls().find((c) => c[0] === "run")!;
  assert.ok(!run.includes("--name"), run.join(" "));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /\bt3\b/);
});

test("a status view that vanishes while the kit waits for its shell leaves the new view its name", async () => {
  const root = setUp();
  writeFileSync(join(stub, "vanish"), "");
  withShell(root, { state: "live", labels: { "sandcastle.root": projectKey(root) }, foreground: { argv: view } });
  const { result, lines } = await quietly(() => openCoreStatus(root, caller, { kit: "/k", instance: "i2" }));
  assert.equal(result, "t9");
  const run = calls().find((c) => c[0] === "run")!;
  assert.equal(run[run.indexOf("--name") + 1], statusName(root));
  assert.deepEqual(lines, []);
});

test("a live terminal labelled for another root keeps the name and prints no line", async () => {
  const root = setUp();
  withShell(root, { state: "live", labels: { "sandcastle.root": "another-root" } });
  const { result, lines } = await quietly(() => openCoreStatus(root, caller, { kit: "/k", instance: "i2" }));
  assert.equal(result, "t9");
  assert.deepEqual(verbs(), ["run"]);
  const run = calls().find((c) => c[0] === "run")!;
  assert.ok(!run.includes("--name"), run.join(" "));
  assert.deepEqual(lines, []);
});
