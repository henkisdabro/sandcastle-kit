// The run's ports over the real `herdr-app` and `hc` CLIs (src/herdr-app.ts `appCliPorts`, #959), against stubs on
// PATH that answer from files: what each answer parses to, what an error, a non-JSON answer or no window gives, and
// that `herdr-app --version` is asked once per set of ports.
//
//   pnpm test:file test/herdr-app-ports.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const stub = mkdtempSync(join(tmpdir(), "sandcastle-app-ports-"));
const bin = join(stub, "bin");
mkdirSync(bin);
const log = join(stub, "calls.log");
// Each stub logs its argv, then answers with the file named for its verb: `<verb>.out` on stdout, exit `<verb>.code`
// (0 by default), or sleeps on `<verb>.hang`. A missing answer file is an error, as no window is.
const answer = (name: string) => `#!/bin/sh
echo "${name} $*" >> '${log}'
verb="$1"; [ "$1" = do ] && verb="$2"
[ "$1" = --version ] && exit 0
[ -f '${stub}/'"$verb.hang" ] && exec sleep 5
[ "${name}" = hc ] && cat > /dev/null
[ -f '${stub}/'"$verb.out" ] || { echo '{"error":"no window"}' >&2; exit 1; }
cat '${stub}/'"$verb.out"
exit "$(cat '${stub}/'"$verb.code" 2>/dev/null || echo 0)"
`;
for (const name of ["herdr-app", "hc"]) {
  writeFileSync(join(bin, name), answer(name));
  chmodSync(join(bin, name), 0o755);
}
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const { appCliPorts } = await import("../src/herdr-app.ts");

const answers = (files: Record<string, string>) => {
  for (const f of ["ls", "status", "pane.split", "pane.close", "pane.focus", "connect"]) for (const x of [".out", ".code", ".hang"]) rmSync(join(stub, f + x), { force: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(stub, f), text);
  writeFileSync(log, "");
};
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);

test("split parses the pane the app made, and sends the mod and its props beside the given pane", () => {
  answers({ "pane.split.out": '{ "pane": "p77" }' });
  assert.equal(appCliPorts().split("p1", { project: "/r" }), "p77");
  assert.deepEqual(calls(), ['herdr-app do pane.split {"direction":"right","pane":"p1","mod":"sandcastle","props":{"project":"/r"}}']);
});

test("split throws on an error answer, an answer with no pane, output that is not JSON, and a timeout", () => {
  answers({ "pane.split.out": '{ "error": "unknown mod" }', "pane.split.code": "1" });
  assert.throws(() => appCliPorts().split("p1", {}));
  answers({ "pane.split.out": '{ "terminal": "t1" }' });
  assert.throws(() => appCliPorts().split("p1", {}), /gave no pane/);
  answers({ "pane.split.out": "not json" });
  assert.throws(() => appCliPorts().split("p1", {}));
  answers({ "pane.split.out": '{ "pane": "p77" }', "pane.split.hang": "" });
  assert.throws(() => appCliPorts({ timeoutMs: 300 }).split("p1", {}));
});

test("paneOf finds the caller's local pane, and gives undefined for no window, output that is not JSON, or no pane", () => {
  const listed = { spaces: [{ machine: "xps", tabs: [{ terminals: [{ terminal: "t7", pane: "xps/p9" }] }] }, { machine: null, tabs: [{ terminals: [{ terminal: "t7", pane: "p3" }] }] }] };
  answers({ "ls.out": JSON.stringify(listed) });
  assert.equal(appCliPorts().paneOf("t7"), "p3");
  assert.equal(appCliPorts().paneOf("t8"), undefined);
  answers({});
  assert.equal(appCliPorts().paneOf("t7"), undefined, "no window");
  answers({ "ls.out": "Herdr is not running" });
  assert.equal(appCliPorts().paneOf("t7"), undefined);
});

test("focused reads the focused pane from status, and undefined when there is none or no window", () => {
  answers({ "status.out": '{ "focused_pane": "p5", "layout": "main" }' });
  assert.equal(appCliPorts().focused(), "p5");
  answers({ "status.out": '{ "focused_pane": null }' });
  assert.equal(appCliPorts().focused(), undefined);
  answers({});
  assert.equal(appCliPorts().focused(), undefined);
});

test("modPanes reads the core's layout document through hc connect, and throws when it cannot", () => {
  const doc = { spaces: [{ tabs: [{ root: { type: "row", children: [{ id: "p1", content: { terminal: "t1" } }, { id: "p2", content: { mod: "sandcastle", props: { project: "/r" } } }] } }] }] };
  answers({ "connect.out": `{"jsonrpc":"2.0","method":"event","params":{}}\n${JSON.stringify({ id: 1, jsonrpc: "2.0", result: { value: doc } })}\n` });
  assert.deepEqual(appCliPorts().modPanes(), [{ pane: "p2", project: "/r" }]);
  assert.deepEqual(calls(), ["hc connect"]);
  answers({ "connect.out": '{"id":1,"jsonrpc":"2.0","error":{"code":-32000,"message":"unavailable"}}\n' });
  assert.throws(() => appCliPorts().modPanes(), /unavailable/);
  answers({ "connect.out": "" });
  assert.throws(() => appCliPorts().modPanes(), /no answer/);
});

test("close and focus name the pane", () => {
  answers({ "pane.close.out": '{"ok":true}', "pane.focus.out": '{"ok":true}' });
  const ports = appCliPorts();
  ports.close("p2");
  ports.focus("p3");
  assert.deepEqual(calls(), ['herdr-app do pane.close {"pane":"p2"}', 'herdr-app do pane.focus {"pane":"p3"}']);
});

test("herdr-app --version is asked once per set of ports, however many questions they answer", () => {
  answers({ "ls.out": '{"spaces":[]}' });
  const ports = appCliPorts();
  ports.paneOf("t1");
  ports.paneOf("t2");
  ports.modCurrent(stub);
  assert.equal(calls().filter((c) => c === "herdr-app --version").length, 1);
});
