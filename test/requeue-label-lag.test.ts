// `sandcastle requeue` on GitHub reminds the operator to give the label search a few seconds
// (`gh issue list --label` can miss a ticket labelled moments earlier); a note-only requeue
// changes no label and a ticket-file requeue has no search, so neither says it. The docs carry
// the same advice. A fake `gh` on PATH, no Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/requeue-label-lag.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { LABEL_LAG_REMINDER, makeTracker, requeueTicketWithEffect } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
if [ "$1 $2" = "issue view" ]; then
  case "$FAKE_GH_ISSUE" in
    queued) printf '{"number":5,"title":"T","state":"OPEN","body":"","comments":[],"labels":[{"name":"ready-for-agent"}]}\\n' ;;
    *) printf '{"number":5,"title":"T","state":"OPEN","body":"","comments":[],"labels":[]}\\n' ;;
  esac
fi
exit 0
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const tracker = (issue: string) => {
  process.env.FAKE_GH_ISSUE = issue;
  return makeTracker({ root: dir, label: "ready-for-agent", tracker: fakeTracker() } as any);
};

test("GitHub: a requeue that changes the label is flagged, with a reminder that names the wait", () => {
  assert.equal(requeueTicketWithEffect(tracker("plain"), "ready-for-agent", ["5"]).relabelled, true);
  assert.match(LABEL_LAG_REMINDER, /few seconds/);
  assert.match(LABEL_LAG_REMINDER, /sandcastle run/);
});

test("GitHub: a ticket already queued changes no label, so no reminder", () => {
  assert.equal(requeueTicketWithEffect(tracker("queued"), "ready-for-agent", ["5"]).relabelled, false);
  assert.equal(requeueTicketWithEffect(tracker("queued"), "ready-for-agent", ["5", "--note", "More."]).relabelled, false);
});

test("ticket files: a requeue has no label search to lag", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-files-"));
  mkdirSync(join(root, ".scratch/demo/issues"), { recursive: true });
  writeFileSync(join(root, ".scratch/demo/issues/04-pick.md"), "# Demo\n\nStatus: needs-human\n\nBody.\n");
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const project = { root, label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }) } as any;
  const r = requeueTicketWithEffect(makeTracker(project), "ready-for-agent", ["demo-04"]);
  assert.match(r.message, /back in the queue/);
  assert.equal(r.relabelled, false);
});

test("the README's Run section and the skill's run action tell the user to wait after labelling", () => {
  const kit = join(import.meta.dirname, "..");
  for (const file of ["README.md", "skill/SKILL.md"]) {
    assert.match(readFileSync(join(kit, file), "utf8"), /few seconds[^.]*before `sandcastle run`/, file);
  }
});
