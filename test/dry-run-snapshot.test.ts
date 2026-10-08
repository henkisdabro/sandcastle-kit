// A dry run's snapshot must see an edited title or body, and a new issue (the
// repo's highest number moves). A fake `gh` first on PATH answers from env vars,
// so no network is needed.
//
//   pnpm test:file test/dry-run-snapshot.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { makeTracker, LATEST_ISSUE } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
// Plain sh, no GNU or BSD flags: the same on macOS and Linux. The JSON is built
// with printf so a quote-free fixture is all it needs.
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
case "$1 $2" in
  "issue view")
    printf '{"state":"OPEN","labels":[{"name":"b"},{"name":"a"}],"comments":[],"title":"%s","body":"%s"}\\n' "$FAKE_TITLE" "$FAKE_BODY" ;;
  "issue list")
    if [ -n "$FAKE_LATEST" ]; then printf '[{"number": %s}]\\n' "$FAKE_LATEST"; else echo '[]'; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const project = { root: dir, label: "ready-for-agent", tracker: fakeTracker() } as any;
const tracker = makeTracker(project);

const set = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
};

test("the same issue twice: equal snapshots", () => {
  set({ FAKE_TITLE: "t", FAKE_BODY: "b", FAKE_LATEST: "57" });
  assert.deepEqual(tracker.snapshot(["5"]), tracker.snapshot(["5"]));
});

test("an edited body changes that issue's entry, and nothing else", () => {
  set({ FAKE_TITLE: "t", FAKE_BODY: "b", FAKE_LATEST: "57" });
  const before = tracker.snapshot(["5"]);
  set({ FAKE_BODY: "b edited" });
  const after = tracker.snapshot(["5"]);
  assert.notEqual(after.get("5"), before.get("5"));
  assert.equal(after.get(LATEST_ISSUE), before.get(LATEST_ISSUE));
});

test("an edited title changes that issue's entry", () => {
  set({ FAKE_TITLE: "t", FAKE_BODY: "b", FAKE_LATEST: "57" });
  const before = tracker.snapshot(["5"]);
  set({ FAKE_TITLE: "t2" });
  assert.notEqual(tracker.snapshot(["5"]).get("5"), before.get("5"));
});

test("a new issue moves only the latest-issue entry: #57 -> #58", () => {
  set({ FAKE_TITLE: "t", FAKE_BODY: "b", FAKE_LATEST: "57" });
  const before = tracker.snapshot(["5"]);
  assert.equal(before.get(LATEST_ISSUE), "#57");
  set({ FAKE_LATEST: "58" });
  const after = tracker.snapshot(["5"]);
  assert.equal(after.get(LATEST_ISSUE), "#58");
  assert.equal(after.get("5"), before.get("5"));
});

test("a repo with no issues: latest issue is none", () => {
  set({ FAKE_TITLE: "t", FAKE_BODY: "b", FAKE_LATEST: undefined });
  assert.equal(tracker.snapshot([]).get(LATEST_ISSUE), "none");
});

test("a gh failure: latest issue is unreadable", () => {
  set({ FAKE_TITLE: "t", FAKE_BODY: "b", FAKE_LATEST: "not json" });
  assert.equal(tracker.snapshot(["5"]).get(LATEST_ISSUE), "unreadable");
});
