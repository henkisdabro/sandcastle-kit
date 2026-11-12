// A queued GitHub ticket whose outside author renamed it after the queue label went on is held, like a body edit: the
// title reaches every agent pass through `gh issue view`. A fake `gh` answers the GraphQL read; no network.
//
//   pnpm test:file test/outsider-title-rename.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { makeTracker } = await import("../src/tracker.ts");
const { outsiderEdit } = await import("../src/burndown.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
const calls = join(bin, "calls");
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

type Rename = { createdAt: string; actor: string | null };
const gives = (labelled: string, renames: Rename[], extra: { association?: string } = {}) => {
  const answer = JSON.stringify({
    data: {
      repository: {
        issue: {
          author: { login: "outsider" },
          authorAssociation: extra.association ?? "NONE",
          lastEditedAt: null,
          userContentEdits: { nodes: [] },
          timelineItems: {
            nodes: [
              { createdAt: labelled, label: { name: "ready-for-agent" } },
              ...renames.map((r) => ({ createdAt: r.createdAt, actor: r.actor === null ? null : { login: r.actor } })),
            ],
          },
          comments: { nodes: [] },
        },
      },
    },
  });
  const file = join(bin, "answer.json");
  writeFileSync(file, answer);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> '${calls}'\ncat '${file}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(calls, "");
};

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);
const START = Date.parse("2026-11-10T09:00:00Z");
const LABEL = "2026-11-10T10:00:00Z";

test("a rename by the outside author after the label holds the ticket, naming the title", async () => {
  gives(LABEL, [{ createdAt: "2026-11-10T12:00:30Z", actor: "outsider" }]);
  const r = await outsiderEdit(tracker, "12", START);
  assert.ok(r?.kind === "held");
  assert.match(r.note, /^Sandcastle held this: its author changed it after it was queued \(title renamed 2026-11-10T12:00Z\)\. Read it, then `sandcastle requeue 12` to run it\.$/);
});

test("the author's actor name is matched without regard to case", async () => {
  gives(LABEL, [{ createdAt: "2026-11-10T12:00:30Z", actor: "OutSider" }]);
  assert.equal((await outsiderEdit(tracker, "12", START))?.kind, "held");
});

test("a rename before the label does not hold", async () => {
  gives(LABEL, [{ createdAt: "2026-11-10T09:30:00Z", actor: "outsider" }]);
  assert.equal(await outsiderEdit(tracker, "12", START), undefined);
});

test("a rename by someone else, or by an account GitHub no longer shows, does not hold", async () => {
  gives(LABEL, [
    { createdAt: "2026-11-10T12:00:00Z", actor: "maintainer" },
    { createdAt: "2026-11-10T13:00:00Z", actor: null },
  ]);
  assert.equal(await outsiderEdit(tracker, "12", START), undefined);
});

test("a rename by a collaborator who opened the ticket never holds", async () => {
  gives(LABEL, [{ createdAt: "2026-11-10T12:00:00Z", actor: "outsider" }], { association: "COLLABORATOR" });
  assert.equal(await outsiderEdit(tracker, "12", START), undefined);
});

test("the query asks for title-rename events with their time and actor", async () => {
  gives(LABEL, []);
  await outsiderEdit(tracker, "12", START);
  const asked = readFileSync(calls, "utf8");
  for (const word of ["RENAMED_TITLE_EVENT", "... on RenamedTitleEvent { createdAt actor { login } }"]) assert.ok(asked.includes(word), `the query lacks ${word}`);
});
