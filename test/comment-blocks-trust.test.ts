// `commentOnlyBlocks` reads a GitHub comment only from the accounts a prompt shows (#829's trust: the repository's
// owners, members and collaborators, and the ticket's author), so a stranger cannot put a "Blocked by" warning in front
// of the operator. A ticket file's comment has no author record and is read as ever. A fake `gh` on PATH; no network.
//
//   pnpm test:file test/comment-blocks-trust.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { commentOnlyBlocks } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'open '\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);
const base = { id: "4", body: "Do it.", author: "someone", queued: true };

test("an account with no association to the repository saying 'Blocked by #9' gives no finding", async () => {
  const found = await commentOnlyBlocks(project, tracker, [{ ...base, comments: ["Blocked by #9"], commentBy: [{ login: "stranger", association: "NONE" }] }]);
  assert.deepEqual(found, []);
});

test("a collaborator saying 'Blocked by #9' gives one finding", async () => {
  const found = await commentOnlyBlocks(project, tracker, [{ ...base, comments: ["Blocked by #9"], commentBy: [{ login: "maintainer", association: "COLLABORATOR" }] }]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.blockers.map((b) => [b.kind, b.id, b.state]), [["github", "9", "open"]]);
});

test("the ticket's own author counts, and only the trusted one of two comments is read", async () => {
  const found = await commentOnlyBlocks(project, tracker, [
    { ...base, comments: ["Blocked by #8", "Blocked by #9"], commentBy: [{ login: "stranger", association: "NONE" }, { login: "someone", association: "NONE" }] },
  ]);
  assert.deepEqual(found[0]!.blockers.map((b) => b.id), ["9"]);
});

test("a ticket file's comment, which has no commentBy, is still read", async () => {
  const files = { ...project, tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const found = await commentOnlyBlocks(files, makeTracker(project), [{ ...base, id: "shop-02", comments: ["Blocked by: 01"] }]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.issue, "shop-02");
});
