// A GitHub read made during a run is tried three times when it fails in a way that is GitHub's slowness (no answer in
// time, a 5xx, a timeout), and once when it fails any other way. A fake `gh` on PATH that counts its calls; no network.
//
//   pnpm test:file test/tracker-read-retry.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeEach, test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { GH_READ_RETRY, makeTracker } = await import("../src/tracker.ts");
const { outsiderEdit } = await import("../src/burndown.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
const counter = join(bin, "count");
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

/** A `gh` whose body is given the number of this call as `$n` (1 for the first). */
const fakeGh = (body: string) => {
  writeFileSync(counter, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho x >> '${counter}'\nn=$(wc -l < '${counter}' | tr -d ' ')\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
};
const calls = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;

const said: string[] = [];
beforeEach(() => {
  said.length = 0;
  GH_READ_RETRY.waitsMs = [10, 10];
  GH_READ_RETRY.say = (line) => said.push(line);
});

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);
const VIEW = '{"number":4,"title":"t","state":"OPEN","body":"b","comments":[],"labels":[]}';
const GRAPHQL = JSON.stringify({
  data: { repository: { issue: { author: { login: "outsider" }, authorAssociation: "NONE", lastEditedAt: null, userContentEdits: { nodes: [] }, timelineItems: { nodes: [] }, comments: { nodes: [] } } } },
});
const START = Date.parse("2026-11-10T09:00:00Z");

test("a read that gets no answer in time at first is tried again and answers, with one line saying so", async () => {
  fakeGh(`[ "$n" = 1 ] && exec sleep 30\necho '${VIEW}'`);
  const ticket = await tracker.getAsync!("4", 200);
  assert.equal(ticket.id, "4");
  assert.equal(calls(), 2);
  assert.equal(said.filter((l) => l.includes("GitHub slow")).length, 1);
});

test("a 502 on the edit check's first read is tried again, so the ticket is not left unread", async () => {
  fakeGh(`if [ "$n" = 1 ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi\necho '${GRAPHQL}'`);
  const r = await outsiderEdit(tracker, "12", START);
  assert.notEqual(r?.kind, "unread");
  assert.equal(calls(), 2);
});

test("a read that never answers is tried three times, waits included, then fails with today's message", async () => {
  GH_READ_RETRY.waitsMs = [50, 150];
  fakeGh("exec sleep 30");
  const started = Date.now();
  await assert.rejects(tracker.getAsync!("4", 200), (e: Error) => /^gh issue view failed: gh issue gave no answer in 0\.2 s - GitHub is slow or not answering\.$/.test(e.message));
  const ms = Date.now() - started;
  assert.equal(calls(), 3);
  assert.ok(ms >= 600 && ms < 3000, `ended after ${ms} ms`);
  assert.equal(said.filter((l) => l.includes("GitHub slow")).length, 1);
});

for (const [stderr, message] of [
  ["HTTP 404: Not Found", /^gh issue view failed: HTTP 404: Not Found/],
  ["GraphQL: Could not resolve to an issue or pull request with the number of 9.", /^gh issue view failed: GraphQL: Could not resolve to an issue or pull request with the number of 9\.$/],
  ["HTTP 401: Bad credentials", /^gh issue view failed: HTTP 401: Bad credentials - gh is not signed in to GitHub/],
] as const) {
  test(`a read refused with "${stderr.slice(0, 30)}" is tried once and says nothing`, async () => {
    fakeGh(`echo '${stderr}' >&2\nexit 1`);
    await assert.rejects(tracker.getAsync!("9", 5000), (e: Error) => message.test(e.message));
    assert.equal(calls(), 1);
    assert.deepEqual(said, []);
  });
}

for (const stderr of ["HTTP 408: Request Timeout", "Client.Timeout exceeded while awaiting headers"]) {
  test(`a read that failed first with "${stderr.slice(0, 30)}" answers on its second try`, async () => {
    fakeGh(`if [ "$n" = 1 ]; then echo '${stderr}' >&2; exit 1; fi\necho '${VIEW}'`);
    assert.equal((await tracker.getAsync!("4", 5000)).id, "4");
    assert.equal(calls(), 2);
  });
}

test("the line for a GraphQL read names gh api graphql and the first line gh said", async () => {
  fakeGh(`if [ "$n" = 1 ]; then echo 'HTTP 502: Bad Gateway' >&2; echo 'second line' >&2; exit 1; fi\necho '${GRAPHQL}'`);
  await tracker.editedSinceQueued!("12", START);
  assert.deepEqual(said, ["GitHub slow (gh api graphql: HTTP 502: Bad Gateway): trying again"]);
});

test("the line for a REST read names the path whole", async () => {
  fakeGh(`if [ "$n" = 1 ]; then echo 'HTTP 503: Service Unavailable' >&2; exit 1; fi\necho 'closed completed'`);
  const { blockerResolver } = await import("../src/blockers.ts");
  const blocker = await blockerResolver(project, tracker, new Set(), 5000)({ kind: "github", id: "3" });
  assert.equal(blocker.state, "closed");
  assert.deepEqual(said, ["GitHub slow (gh api repos/{owner}/{repo}/issues/3: HTTP 503: Service Unavailable): trying again"]);
});
