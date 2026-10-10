// A native "blocked by" edge can point at an issue of another repository. It is waited on under the
// name `owner/repo#N`, its state is read from that repository, it is never taken for this
// repository's `#N`, never counted as queued and never released by a landing here. A fake `gh`
// first on PATH answers from files beside it, so no network is needed.
//
//   pnpm test:file test/github-cross-repo-blockers.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { blockedNote, blockerProblems, openBlockersNow } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { openOnQueue } = await import("../src/burndown.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
// `list.json`: the queue. The issues API answers `repos/<owner>/<repo>/issues/<n>` from
// `state-<owner>-<repo>-<n>` (a missing file is an API error, as for a repository gh cannot see);
// `repos/{owner}/{repo}/...` is this repository, Acme/App.
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
case "$1 $2" in
  "issue list") cat "${dir}/list.json" ;;
  "repo view") echo "Acme/App" ;;
  "api repos/"*)
    path=$2
    case "$path" in
      "repos/{owner}/{repo}/"*) path="repos/Acme/App/\${path#repos/\\{owner\\}/\\{repo\\}/}" ;;
    esac
    name=$(echo "\${path#repos/}" | sed 's#/issues/#-#; s#/#-#g')
    cat "${dir}/state-$name" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const project = { root: dir, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;

type Node = { number: number; state: string; repository?: { nameWithOwner: string } };
const ticket = (number: number, blockedBy: Node[]) => ({ number, title: `t${number}`, body: "Do it.", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z", labels: [{ name: "ready-for-agent" }], comments: [], blockedBy });
const setup = (queue: ReturnType<typeof ticket>[], states: Record<string, string>) => {
  writeFileSync(join(dir, "list.json"), JSON.stringify(queue));
  for (const [name, s] of Object.entries(states)) writeFileSync(join(dir, `state-${name}`), `${s}\n`);
};
const other = (number: number): Node => ({ number, state: "OPEN", repository: { nameWithOwner: "other/repo" } });
const here = (number: number): Node => ({ number, state: "OPEN", repository: { nameWithOwner: "acme/app" } });

test("a native blocker from another repository is waited on under its own name, not as this repository's issue of that number", async () => {
  // #12 here is closed; other/repo#12 is open.
  setup([ticket(5, [other(12)])], { "Acme-App-12": "closed completed", "other-repo-12": "open" });
  const tracker = makeTracker(project);
  const open = await openOnQueue(project, tracker, tracker.queued(false));
  assert.deepEqual(open.get("5")?.map((b) => [b.id, b.state]), [["other/repo#12", "open"]]);
});

test("a native blocker from another repository that is closed there holds nothing back, whatever this repository's issue of that number is", async () => {
  setup([ticket(5, [other(12)])], { "Acme-App-12": "open", "other-repo-12": "closed completed" });
  const tracker = makeTracker(project);
  assert.equal((await openOnQueue(project, tracker, tracker.queued(false))).size, 0);
});

test("a native blocker from this repository, spelt in any case, is read as before", async () => {
  setup([ticket(5, [here(12)])], { "Acme-App-12": "open" });
  const tracker = makeTracker(project);
  const open = await openOnQueue(project, tracker, tracker.queued(false));
  assert.deepEqual(open.get("5")?.map((b) => [b.kind, b.id]), [["github", "12"]]);
});

test("a queued ticket numbered like the other repository's blocker neither stands for it nor is waited on", async () => {
  setup([ticket(5, [other(6)]), ticket(6, [])], { "other-repo-6": "open" });
  const tracker = makeTracker(project);
  const queued = tracker.queued(false);
  const open = await openOnQueue(project, tracker, queued);
  assert.deepEqual(open.get("5")?.map((b) => b.id), ["other/repo#6"]);
  // Not queued, so no "open but not queued" advice and no wait-for-each-other cycle for it.
  assert.deepEqual(await blockerProblems(project, tracker, queued), []);
});

test("a landing here does not release a ticket waiting on another repository's issue of the same number", async () => {
  setup([ticket(5, [other(6)]), ticket(6, [])], { "other-repo-6": "open" });
  const tracker = makeTracker(project);
  const queued = tracker.queued(false);
  const open = await openBlockersNow(project, tracker, queued.map((t) => t.id))(queued.filter((t) => t.id === "5"), new Set(["6"]));
  assert.deepEqual(open[0].map((b) => b.id), ["other/repo#6"]);
});

test("a blocker from another repository is shown as owner/repo#N and as not in this run", async () => {
  setup([ticket(5, [other(6)]), ticket(6, [])], { "other-repo-6": "open" });
  const tracker = makeTracker(project);
  const open = await openOnQueue(project, tracker, tracker.queued(false));
  assert.equal(blockedNote(open.get("5")!, new Set(["6"])), "waits for other/repo#6 (not in this run)");
});

test("a blocker from a repository gh cannot read counts as open and the note says why", async () => {
  setup([ticket(5, [other(9)])], {});
  const tracker = makeTracker(project);
  const queued = tracker.queued(false);
  const open = await openOnQueue(project, tracker, queued);
  assert.deepEqual(open.get("5")?.map((b) => [b.id, b.state]), [["other/repo#9", "unreadable"]]);
  assert.deepEqual(await blockerProblems(project, tracker, queued), ["#5 waits for other/repo#9, which gh could not read (no such issue, or no access to that repository) - it counts as open, so it waits."]);
});

test("a node with no repository (an older gh) is this repository's issue", async () => {
  setup([ticket(5, [{ number: 12, state: "OPEN" }])], { "Acme-App-12": "open" });
  const tracker = makeTracker(project);
  tracker.queued(false);
  assert.deepEqual(tracker.declaredBlockers("5"), ["12"]);
});
