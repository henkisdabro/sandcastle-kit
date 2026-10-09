// GitHub's native "blocked by" edges hold a ticket back as a `Blocked by #N` body line does: the
// adapter asks gh for `blockedBy`, `refsOf` joins the edges as github blockers, and the run's
// start (`openOnQueue`) and `blockerProblems` see them. A fake `gh` first on PATH answers
// `issue list`, `issue view` and `api` from files beside it, so no network is needed.
//
//   pnpm test:file test/github-native-blockers.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { blockerProblems } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { openOnQueue } = await import("../src/burndown.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
// `list.json`: the queue; `view-N.json`: one issue; `state-N`: what the issues API prints for N
// (`open`, `closed`, `closed not_planned`); `old-gh`: present, the fake refuses `blockedBy` as gh
// 2.x without the field does. A plain sh script: the same on macOS and Linux.
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
case "$*" in
  *blockedBy*) if [ -e "${dir}/old-gh" ]; then
    echo 'Unknown JSON field: "blockedBy"' >&2
    echo 'Available fields:' >&2
    exit 1
  fi ;;
esac
case "$1 $2" in
  "issue list") cat "${dir}/list.json" ;;
  "issue view") cat "${dir}/view-$3.json" ;;
  "api repos/{owner}/{repo}/issues/"*) cat "${dir}/state-\${2##*/}" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const project = { root: dir, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;

const issue = (number: number, body = "", blockedBy?: { number: number; state: string }[]) => ({
  number,
  title: `t${number}`,
  body,
  state: "OPEN",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "ready-for-agent" }],
  comments: [],
  ...(blockedBy ? { blockedBy } : {}),
});
const setup = (queue: ReturnType<typeof issue>[], states: Record<number, string> = {}, others: ReturnType<typeof issue>[] = []) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(gh, readGh, { mode: 0o755 });
  writeFileSync(join(dir, "list.json"), JSON.stringify(queue));
  for (const i of [...queue, ...others]) writeFileSync(join(dir, `view-${i.number}.json`), JSON.stringify(i));
  for (const [n, s] of Object.entries(states)) writeFileSync(join(dir, `state-${n}`), `${s}\n`);
};
// setup() recreates the directory, so the script is kept to be written back.
const readGh = readFileSync(gh, "utf8");


test("a queued ticket natively blocked by an open issue that is not queued waits for it, and the queue says it is not queued", async () => {
  const blocker = issue(7);
  const t = issue(5, "Do it.", [{ number: 7, state: "OPEN" }]);
  setup([t], { 7: "open" }, [blocker]);
  const tracker = makeTracker(project);
  const queued = tracker.queued(false);
  const open = await openOnQueue(project, tracker, queued);
  assert.deepEqual(open.get("5")?.map((b) => [b.kind, b.id, b.state]), [["github", "7", "open"]]);
  assert.deepEqual(await blockerProblems(project, tracker, queued), ["#5 waits for #7, which is open but not queued - queue #7 or remove the line."]);
});

test("a native blocker the body also names is one blocker", async () => {
  const t = issue(5, "Blocked by #7", [{ number: 7, state: "OPEN" }]);
  setup([t], { 7: "open" }, [issue(7)]);
  const tracker = makeTracker(project);
  const open = await openOnQueue(project, tracker, tracker.queued(false));
  assert.equal(open.get("5")?.length, 1);
});

test("two queued tickets natively blocked by each other wait for each other", async () => {
  const a = issue(5, "", [{ number: 6, state: "OPEN" }]);
  const b = issue(6, "", [{ number: 5, state: "OPEN" }]);
  setup([a, b]);
  const tracker = makeTracker(project);
  assert.deepEqual(await blockerProblems(project, tracker, tracker.queued(false)), ["#5, #6 wait for each other - none of them can ever start. Remove one \"Blocked by\" line."]);
});

test("a closed native blocker holds nothing back, one closed as not planned never lets the ticket start", async () => {
  const t = issue(5, "", [{ number: 7, state: "CLOSED" }]);
  setup([t], { 7: "closed completed" }, [issue(7)]);
  let tracker = makeTracker(project);
  assert.equal((await openOnQueue(project, tracker, tracker.queued(false))).size, 0);

  setup([t], { 7: "closed not_planned" }, [issue(7)]);
  tracker = makeTracker(project);
  const open = await openOnQueue(project, tracker, tracker.queued(false));
  assert.deepEqual(open.get("5")?.map((b) => b.state), ["closed-unmerged"]);
});

test("a ticket the list did not read is asked for its native blockers", async () => {
  setup([issue(5)], { 7: "open" }, [issue(8, "", [{ number: 7, state: "OPEN" }])]);
  assert.deepEqual(makeTracker(project).declaredBlockers("8"), ["7"]);
});

test("a gh that refuses blockedBy still lists the queue, with no native edges and one line on stderr", async () => {
  // A fresh copy of the module: the refusal is remembered for the rest of the process.
  const url = new URL("../src/tracker.ts?old-gh", import.meta.url).href;
  const { makeTracker: fresh } = (await import(url)) as typeof import("../src/tracker.ts");
  const t = issue(5, "Do it.", [{ number: 7, state: "OPEN" }]);
  setup([t], { 7: "open" }, [issue(7)]);
  writeFileSync(join(dir, "old-gh"), "");
  const written: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  let queued: { id: string }[];
  let declared: string[];
  try {
    const tracker = fresh(project);
    queued = tracker.queued(false);
    declared = tracker.declaredBlockers("5");
    tracker.queued(false);
  } finally {
    process.stderr.write = real;
  }
  assert.deepEqual(queued.map((q) => q.id), ["5"]);
  assert.deepEqual(declared, []);
  assert.deepEqual(written, [`this gh cannot read GitHub's native issue dependencies - update gh, or write "Blocked by #N" in the body\n`]);
});
