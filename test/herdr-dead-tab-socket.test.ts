// The live-runs directory is machine-wide, so with two Herdr servers on one machine the reader
// that finds a run dead may belong to the server that does not hold its tab, where the record's
// pane ids mean nothing (or a bare shell of someone else's). A record names its server (`socket`);
// a caller on another one makes no herdr call, types nothing and leaves the run's file. A record
// with no `socket`, or a caller with no HERDR_SOCKET_PATH, acts as it always did. Fake herdr.
//
//   pnpm exec tsx --test test/herdr-dead-tab-socket.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { everyPidIsTheKit } from "./kit-process.ts";

const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "tab get") echo '{"result":{"tab":{"pane_count":1,"label":"3"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"t9","workspace_id":"w1"},"root_pane":{"pane_id":"p9"}}}' ;;
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w1:t2","workspace_id":"w1"}}}\\n' "$3" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"-zsh"}]}}}\\n' ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-socket-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(mkdtempSync(join(tmpdir(), "sandcastle-socket-log-")), "calls.log");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: log, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-socket-cache-")) });
delete process.env.HERDR_SOCKET_PATH;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
const { replaceDeadTab, runsLine } = await import("../src/herdr-plugin.ts");
const { viewRecord, openSandboxView } = await import("../src/herdr.ts");

const KIT_DIR = "/the/kit";
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const probe = (pid: number) => (pid === process.pid ? everyPidIsTheKit() : undefined);

/** A dead run's project and runs directory, with the view record it left. */
const setup = (view: object) => {
  writeFileSync(log, "");
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-socket-runs-"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-socket-project-")));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(dir, "run"), root);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-02T01:00:00Z", pid: 2 ** 22 + 12345 }));
  writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  return { dir, root };
};
const tick = (dir: string, socket: string | undefined) => {
  if (socket === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = socket;
  return runsLine(dir, undefined, probe, (root) => replaceDeadTab(root, KIT_DIR));
};

test("a caller on another server makes no herdr call, types nothing and keeps the run's file", () => {
  const { dir, root } = setup({ ...OWN, socket: "/run/herdr-a.sock" });
  const before = readFileSync(viewRecord(root), "utf8");
  assert.equal(tick(dir, "/run/herdr-b.sock"), "");
  assert.deepEqual(calls(), []);
  assert.equal(readdirSync(dir).length, 1, "the file stays for the server that holds the tab");
  assert.equal(readFileSync(viewRecord(root), "utf8"), before);
});

test("the server that holds the tab gets the report once, and the file goes", () => {
  const { dir, root } = setup({ ...OWN, socket: "/run/herdr-a.sock" });
  assert.equal(tick(dir, "/run/herdr-a.sock"), "");
  assert.deepEqual(calls().filter((c) => c.startsWith("pane run ")), [`pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' report`]);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, true);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).socket, "/run/herdr-a.sock");
  assert.equal(readdirSync(dir).length, 0);
});

test("a record without a socket is reported as before, whichever server asks", () => {
  const { dir } = setup(OWN);
  assert.equal(tick(dir, "/run/herdr-b.sock"), "");
  assert.equal(calls().filter((c) => c.startsWith("pane run ")).length, 1, calls().join("\n"));
  assert.equal(readdirSync(dir).length, 0);
});

test("a caller without HERDR_SOCKET_PATH is reported to as before", () => {
  const { dir } = setup({ ...OWN, socket: "/run/herdr-a.sock" });
  assert.equal(tick(dir, undefined), "");
  assert.equal(calls().filter((c) => c.startsWith("pane run ")).length, 1, calls().join("\n"));
  assert.equal(readdirSync(dir).length, 0);
});

test("the view record names the server that holds the tab, when the run knows it", () => {
  const open = (socket: string | undefined) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-socket-view-")));
    mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
    if (socket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = socket;
    openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}), "none");
    return JSON.parse(readFileSync(viewRecord(root), "utf8"));
  };
  assert.equal(open("/run/herdr-a.sock").socket, "/run/herdr-a.sock");
  assert.equal("socket" in open(undefined), false);
});
