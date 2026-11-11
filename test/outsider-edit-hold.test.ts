// A queued GitHub ticket whose author is no owner, member or collaborator is held for a person when its body, or one of
// the author's comments, was written or edited after the queue label was last added (the maintainer's decision on
// #829's remaining gap). A fake `gh` answers the GraphQL read; no network.
//
//   pnpm test:file test/outsider-edit-hold.test.ts

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
const fakeGh = (body: string) => {
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> '${calls}'\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(calls, "");
};

type Edit = { editedAt: string; editor: string };
type Comment = { login: string; createdAt: string; lastEditedAt?: string; edits?: Edit[] };
type Issue = { association?: string; author?: string; labelled?: string[]; lastEditedAt?: string; edits?: Edit[]; comments?: Comment[]; otherLabel?: string };

/** The GraphQL answer for one issue; the label events carry the queue label, plus one for another label. */
const answer = (i: Issue) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          author: { login: i.author ?? "outsider" },
          authorAssociation: i.association ?? "NONE",
          lastEditedAt: i.lastEditedAt ?? null,
          userContentEdits: { nodes: (i.edits ?? []).map((e) => ({ editedAt: e.editedAt, editor: { login: e.editor } })) },
          timelineItems: {
            nodes: [
              ...(i.labelled ?? []).map((createdAt) => ({ createdAt, label: { name: "ready-for-agent" } })),
              ...(i.otherLabel ? [{ createdAt: i.otherLabel, label: { name: "bug" } }] : []),
            ],
          },
          comments: {
            nodes: (i.comments ?? []).map((c) => ({
              author: { login: c.login },
              createdAt: c.createdAt,
              lastEditedAt: c.lastEditedAt ?? null,
              userContentEdits: { nodes: (c.edits ?? []).map((e) => ({ editedAt: e.editedAt, editor: { login: e.editor } })) },
            })),
          },
        },
      },
    },
  });
const gives = (i: Issue) => {
  const file = join(bin, "answer.json");
  writeFileSync(file, answer(i));
  fakeGh(`cat '${file}'`);
};

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);
const START = Date.parse("2026-11-10T09:00:00Z");
const held = (i: Issue) => {
  gives(i);
  return outsiderEdit(tracker, "12", START);
};

test("an outsider's body edited after the label is held, and the hold text names the change", async () => {
  const r = await held({ labelled: ["2026-11-09T10:00:00Z"], lastEditedAt: "2026-11-10T12:00:30Z", edits: [{ editedAt: "2026-11-10T12:00:30Z", editor: "outsider" }] });
  assert.ok(r?.kind === "held");
  assert.match(r.note, /^Sandcastle held this: its author changed it after it was queued \(body edited 2026-11-10T12:00Z\)\. Read it, then `sandcastle requeue 12` to run it\.$/);
});

test("an outsider's comment written after the label is held", async () => {
  const r = await held({ labelled: ["2026-11-09T10:00:00Z"], comments: [{ login: "outsider", createdAt: "2026-11-10T08:00:00Z" }] });
  assert.ok(r?.kind === "held");
  assert.match(r.why, /\(comment by outsider 2026-11-10T08:00Z\)/);
});

test("an outsider's comment edited after the label is held, though it was written before", async () => {
  const r = await held({
    labelled: ["2026-11-09T10:00:00Z"],
    comments: [{ login: "outsider", createdAt: "2026-11-09T09:00:00Z", lastEditedAt: "2026-11-10T07:00:00Z", edits: [{ editedAt: "2026-11-10T07:00:00Z", editor: "outsider" }] }],
  });
  assert.ok(r?.kind === "held");
  assert.match(r.why, /\(comment by outsider 2026-11-10T07:00Z\)/);
});

test("a body edited before the label time is not held", async () => {
  assert.equal(await held({ labelled: ["2026-11-10T10:00:00Z"], lastEditedAt: "2026-11-10T09:00:00Z", edits: [{ editedAt: "2026-11-10T09:00:00Z", editor: "outsider" }] }), undefined);
});

test("the newest queue-label event is the label time, so a requeue accepts the change", async () => {
  const edit = { lastEditedAt: "2026-11-10T09:00:00Z", edits: [{ editedAt: "2026-11-10T09:00:00Z", editor: "outsider" }] };
  assert.equal(await held({ labelled: ["2026-11-09T10:00:00Z", "2026-11-10T10:00:00Z"], ...edit }), undefined);
  assert.ok((await held({ labelled: ["2026-11-09T10:00:00Z"], ...edit }))?.kind === "held");
});

test("another label added later is not the queue label's time", async () => {
  const r = await held({ labelled: ["2026-11-09T10:00:00Z"], otherLabel: "2026-11-10T11:00:00Z", lastEditedAt: "2026-11-10T09:00:00Z", edits: [{ editedAt: "2026-11-10T09:00:00Z", editor: "outsider" }] });
  assert.ok(r?.kind === "held");
});

test("a body or an author comment edited after the label by the owner's account is not held", async () => {
  const r = await held({
    labelled: ["2026-11-09T10:00:00Z"],
    lastEditedAt: "2026-11-10T12:00:00Z",
    edits: [{ editedAt: "2026-11-10T12:00:00Z", editor: "maintainer" }],
    comments: [{ login: "outsider", createdAt: "2026-11-09T09:00:00Z", lastEditedAt: "2026-11-10T12:30:00Z", edits: [{ editedAt: "2026-11-10T12:30:00Z", editor: "maintainer" }] }],
  });
  assert.equal(r, undefined);
});

test("a ticket never labelled is measured from the run's start", async () => {
  assert.equal(await held({ comments: [{ login: "outsider", createdAt: "2026-11-10T08:59:00Z" }] }), undefined);
  const r = await held({ comments: [{ login: "outsider", createdAt: "2026-11-10T09:01:00Z" }] });
  assert.ok(r?.kind === "held");
});

test("a collaborator, member or owner author is never held, whatever the times", async () => {
  for (const association of ["COLLABORATOR", "MEMBER", "OWNER"]) {
    const r = await held({ association, author: "maintainer", labelled: ["2026-11-09T10:00:00Z"], lastEditedAt: "2026-11-10T12:00:00Z", edits: [{ editedAt: "2026-11-10T12:00:00Z", editor: "maintainer" }], comments: [{ login: "maintainer", createdAt: "2026-11-10T12:00:00Z" }] });
    assert.equal(r, undefined, association);
  }
});

test("a comment after the label by another account does not hold", async () => {
  assert.equal(await held({ labelled: ["2026-11-09T10:00:00Z"], comments: [{ login: "stranger", createdAt: "2026-11-10T12:00:00Z", lastEditedAt: "2026-11-10T13:00:00Z", edits: [{ editedAt: "2026-11-10T13:00:00Z", editor: "stranger" }] }] }), undefined);
});

test("a read that fails gives no hold, and the ticket is not started this turn", async () => {
  fakeGh("echo 'HTTP 502: Bad Gateway' >&2\nexit 1");
  const r = await outsiderEdit(tracker, "12", START);
  assert.ok(r?.kind === "unread");
  assert.match(r.why, /^could not read whether its author edited it after it was queued \(.*502.*\); not started this turn, it stays queued$/);
});

test("a read that gets no answer in time is the same failed read", async () => {
  fakeGh("exec sleep 30");
  const r = await outsiderEdit(tracker, "12", START, 300);
  assert.ok(r?.kind === "unread");
  assert.match(r.why, /gave no answer in 0\.3 s/);
});

test("one gh api graphql call asks for the issue, its queue-label events, comments and who edited them", async () => {
  gives({ labelled: ["2026-11-09T10:00:00Z"] });
  await outsiderEdit(tracker, "12", START);
  const asked = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^api graphql /);
  for (const word of ["authorAssociation", "lastEditedAt", "LABELED_EVENT", "userContentEdits", "editor { login }", "number=12"]) assert.ok(asked[0].includes(word), word);
});

test("the files tracker never makes the read", async () => {
  fakeGh("echo unexpected >&2\nexit 1");
  const files = makeTracker({ ...project, tracker: fakeTracker({ kind: "files", dir: ".scratch" }) } as unknown as Project);
  assert.equal(files.editedSinceQueued, undefined);
  assert.equal(await outsiderEdit(files, "cart-01", START), undefined);
  assert.equal(readFileSync(calls, "utf8"), "");
});

test("every pipeline start asks, before a slot or an agent, and a landing's own check does not", () => {
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const asked = burndown.indexOf("await outsiderEdit(tracker, issue.id, Date.parse(runId))");
  const checked = burndown.indexOf("await withdrawal(issue.id)");
  const piped = burndown.indexOf("return await pipeline(issue,");
  assert.ok(checked > 0 && asked > checked && piped > asked, "outsiderEdit follows withdrawal() in the attempt and precedes the pipeline");
  // The held ending is returned in place of the pipeline, for a fresh and a carried ticket alike.
  assert.match(burndown.slice(asked, piped), /outsider\?\.kind === "held"[\s\S]*notes\.push\(\{ issue: issue\.id, kind: "hold", text: outsider\.note \}\)[\s\S]*return heldResolution\(/);
  assert.ok(!readFileSync(new URL("../src/landing.ts", import.meta.url), "utf8").includes("outsiderEdit"));
});
