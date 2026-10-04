// The dead-tab report is typed into a pane only while that pane is a bare shell, and by only one
// of two callers that read the same record at once. The fake `herdr` logs every call; no Herdr, no
// network.
//
//   pnpm exec tsx --test test/herdr-dead-tab-claim.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { HERDR_PLUGIN, startKit } from "./cli-spawn.ts";

// `pane process-info` answers with $FAKE_FG, one foreground command per `|`. `pane get` waits,
// when $FAKE_BARRIER is set, until two callers have asked, so both have passed every check before
// either goes on; `pane run` is slow so the first caller is still typing when the second looks.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get")
    printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w1:t2"}}}\\n' "$3"
    if [ -n "$FAKE_BARRIER" ]; then
      echo "$$" >> "$FAKE_BARRIER"
      # 30 s, not 5: each caller is its own tsx start-up, and under load the second came too late.
      for _ in $(seq 1 600); do [ "$(wc -l < "$FAKE_BARRIER")" -ge 2 ] && break; sleep 0.05; done
    fi ;;
  "pane process-info")
    out=""; IFS='|'; for c in $FAKE_FG; do out="$out\${out:+,}{\\"cmdline\\":\\"$c\\"}"; done
    printf '{"result":{"process_info":{"foreground_processes":[%s]}}}\\n' "$out" ;;
  "pane run") sleep 0.5; echo '{}' ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-claim-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const scratch = mkdtempSync(join(tmpdir(), "sandcastle-claim-log-"));
const log = join(scratch, "calls.log");
const barrier = join(scratch, "barrier");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: log, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-claim-cache-")) });
const { reportInDeadTab, viewRecord, runsBareShell } = await import("../src/herdr.ts");

const KIT_DIR = "/the/kit";
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const typed = () => calls().filter((c) => c.startsWith("pane run "));
const reset = (fg: string) => {
  writeFileSync(log, "");
  writeFileSync(barrier, "");
  Object.assign(process.env, { FAKE_FG: fg });
  delete process.env.FAKE_BARRIER;
};
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const project = (view: object) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-claim-project-")));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  return root;
};
const record = (root: string) => JSON.parse(readFileSync(viewRecord(root), "utf8"));

for (const fg of ["vim notes.md", "claude", "python3", "node", "bash /kit/status.sh 5", "zsh -c make", "sh|vim", "", "tmux"]) {
  test(`a pane running \`${fg}\` is never typed into`, () => {
    reset(fg);
    const root = project(OWN);
    assert.equal(reportInDeadTab(root, KIT_DIR), false);
    assert.deepEqual(typed(), []);
    assert.equal(record(root).reported, undefined, "left unmarked: a later tick may find the pane a shell again");
  });
}

for (const fg of ["-zsh", "bash", "/bin/bash --login", "/usr/bin/fish", "-sh -l"]) {
  test(`a bare shell (\`${fg}\`) gets the report`, () => {
    reset(fg);
    const root = project(OWN);
    assert.equal(reportInDeadTab(root, KIT_DIR), true);
    assert.equal(typed().length, 1, calls().join("\n"));
    assert.equal(record(root).reported, true);
    assert.deepEqual(readdirSync(join(root, ".sandcastle/logs")), ["herdr-view.json"], "no claim file is left");
  });
}

test("runsBareShell reads Herdr's process info", () => {
  reset("-zsh");
  assert.equal(runsBareShell("w1:t2-1"), true);
  reset("claude");
  assert.equal(runsBareShell("w1:t2-1"), false);
});

test("a failed `pane run` gives the record back unmarked", () => {
  reset("-zsh");
  const root = project(OWN);
  const broken = mkdtempSync(join(tmpdir(), "sandcastle-claim-broken-"));
  writeFileSync(
    join(broken, "herdr"),
    `#!/usr/bin/env bash\ncase "$1 $2" in\n  "pane run") exit 1 ;;\n  *) exec ${join(bin, "herdr")} "$@" ;;\nesac\n`,
  );
  chmodSync(join(broken, "herdr"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${broken}${delimiter}${path}`;
  try {
    assert.equal(reportInDeadTab(root, KIT_DIR), false);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(record(root).reported, undefined);
  assert.equal(readdirSync(join(root, ".sandcastle/logs")).length, 1);
});

test("two callers that both read the record unmarked type the report once", async () => {
  reset("-zsh");
  const cache = mkdtempSync(join(tmpdir(), "sandcastle-claim-line-"));
  const dir = join(cache, "sandcastle-kit/runs");
  mkdirSync(dir, { recursive: true });
  const root = project(OWN);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-02T01:00:00Z", pid: 2 ** 22 + 12345 }));
  writeFileSync(join(dir, "run"), root);
  const env = { ...process.env, XDG_CACHE_HOME: cache, FAKE_BARRIER: barrier };
  const done = () =>
    new Promise<number | null>((resolve) => {
      const child = startKit(["herdr", "line"], { script: HERDR_PLUGIN, env, stdio: ["ignore", "ignore", "pipe"] });
      child.on("close", resolve);
    });
  const codes = await Promise.all([done(), done()]);
  assert.deepEqual(codes, [0, 0]);
  assert.equal(calls().filter((c) => c.startsWith("pane get ")).length, 2, `both callers reached the check:\n${calls().join("\n")}`);
  assert.equal(typed().length, 1, calls().join("\n"));
  assert.equal(existsSync(viewRecord(root)) && record(root).reported, true);
});

test("a record a new run wrote between the read and the claim is neither typed for nor overwritten", () => {
  reset("-zsh");
  const root = project(OWN);
  const fresh = JSON.stringify({ tab: "w1:t9", adopted: false, status: "w1:t9-1", panes: [] }) + "\n";
  const newRun = mkdtempSync(join(tmpdir(), "sandcastle-claim-newrun-"));
  writeFileSync(join(newRun, "record"), fresh);
  // The new run writes its record while this caller asks Herdr about the pane, after the read.
  writeFileSync(
    join(newRun, "herdr"),
    `#!/usr/bin/env bash\ncase "$1 $2" in\n  "pane process-info") cp '${join(newRun, "record")}' '${viewRecord(root)}' ;;\nesac\nexec ${join(bin, "herdr")} "$@"\n`,
  );
  chmodSync(join(newRun, "herdr"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${newRun}${delimiter}${path}`;
  try {
    assert.equal(reportInDeadTab(root, KIT_DIR), false);
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(typed(), []);
  assert.equal(readFileSync(viewRecord(root), "utf8"), fresh, "the new run's record is left as it wrote it");
  assert.deepEqual(readdirSync(join(root, ".sandcastle/logs")), ["herdr-view.json"], "no claim file is left");
});
