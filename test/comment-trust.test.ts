// Whose comments a run counts. A comment by an account that is not the repository's owner, member or collaborator, or
// the ticket's author, never makes a carried branch unreviewed, and opening with the agent marker makes a comment the
// agent's only when the account GH_TOKEN belongs to wrote it. The ledger's `personCommentsSince` over made-up comments;
// the tracker's reading of `gh issue list` and `gh api user` through a fake `gh` on PATH. No network.
//
//   pnpm test:file test/comment-trust.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { personCommentsSince, trustOf } = await import("../src/ledger.ts");
const { AGENT_COMMENT_MARKER, makeTracker, tokenUserOf, trustedComment } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const PLAIN = "Please also handle the empty case.";
const AGENT = `${AGENT_COMMENT_MARKER}\n\nWhat I changed.`;

/** Comments with their authors, as the tracker reads a GitHub ticket. */
const thread = (...c: [string, string, string][]) => ({ comments: c.map((x) => x[2]), commentBy: c.map((x) => ({ login: x[0], association: x[1] })), author: "reporter" });

test("a plain comment from an account with no association past the count does not make the ticket unreviewed, a collaborator's does", () => {
  const stranger = thread(["stranger", "NONE", PLAIN]);
  assert.deepEqual(personCommentsSince(stranger.comments, 0, trustOf(stranger, "the-token-user")), []);
  const collaborator = thread(["maintainer", "COLLABORATOR", PLAIN]);
  assert.deepEqual(personCommentsSince(collaborator.comments, 0, trustOf(collaborator, "the-token-user")), [PLAIN]);
  for (const association of ["OWNER", "MEMBER"]) assert.equal(trustedComment({ login: "someone", association }), true);
  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", undefined]) assert.equal(trustedComment({ login: "someone", association }), false);
});

test("the ticket's author counts as a person whatever the association, and only on their own ticket", () => {
  const t = thread(["reporter", "NONE", PLAIN]);
  assert.deepEqual(personCommentsSince(t.comments, 0, trustOf(t, null)), [PLAIN]);
  assert.deepEqual(personCommentsSince(t.comments, 0, trustOf({ ...t, author: "someone-else" }, null)), []);
});

test("an outsider's comment that opens with the agent marker is not the agent's, and it is not a person's either", () => {
  const t = thread(["stranger", "NONE", AGENT], ["stranger", "NONE", PLAIN]);
  assert.deepEqual(personCommentsSince(t.comments, 0, trustOf(t, "stranger")), []);
  const kit = thread(["stranger", "NONE", "Sandcastle held this: conflict resolution changed other.txt."]);
  assert.deepEqual(personCommentsSince(kit.comments, 0, trustOf(kit, null)), []);
});

test("a comment with the agent marker is the agent's only when the token's own account wrote it", () => {
  const mine = thread(["bot-account", "COLLABORATOR", AGENT]);
  assert.deepEqual(personCommentsSince(mine.comments, 0, trustOf(mine, "bot-account")), []);
  // A collaborator who copies the marker is a person: the review it asks for is not skipped.
  const copied = thread(["maintainer", "COLLABORATOR", AGENT]);
  assert.deepEqual(personCommentsSince(copied.comments, 0, trustOf(copied, "bot-account")), [AGENT]);
});

test("a ticket without authors (a ticket file) keeps telling the agent's comment by its marker", () => {
  assert.deepEqual(personCommentsSince([AGENT, PLAIN], 0), [PLAIN]);
});

/** A `gh` that answers `api user` with `user` (or fails with it as the error when `fails`) and `issue list` with `listed`. */
const fakeGh = (answer: { user?: string; fails?: string; listed?: unknown }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-comment-trust-"));
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
echo "$* [GH_TOKEN=$GH_TOKEN]" >> '${calls}'
case "$1 $2" in
  "api user") ${answer.fails ? `echo '${answer.fails}' >&2; exit 1` : `echo '${answer.user}'`} ;;
  "issue list") cat '${join(dir, "listed.json")}' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
  );
  writeFileSync(join(dir, "listed.json"), JSON.stringify(answer.listed ?? []));
  chmodSync(join(dir, "gh"), 0o755);
  return { dir, calls: () => readFileSync(calls, "utf8").trim().split("\n") };
};

const projectIn = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-comment-trust-root-"));
  return { root, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
};

const withPath = <T>(dir: string, fn: () => T): T => {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before}`;
  try {
    return fn();
  } finally {
    process.env.PATH = before;
  }
};

test("when gh cannot say whose token it is, the run prints one line naming it and a marker comment counts as a person's", async () => {
  const gh = fakeGh({ fails: "HTTP 401: Bad credentials" });
  const project = projectIn();
  const { result: user, lines } = await quietly(() => withPath(gh.dir, () => [tokenUserOf(project), tokenUserOf(project)]));
  assert.deepEqual(user, [null, null]);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /Could not read which account GH_TOKEN belongs to \(gh api user: HTTP 401: Bad credentials\)/);
  assert.equal(gh.calls().length, 1, "read once");
  const t = thread(["maintainer", "OWNER", AGENT]);
  assert.deepEqual(personCommentsSince(t.comments, 0, trustOf(t, user[0])), [AGENT]);
});

test("the token's account is read once, with the project's own GH_TOKEN", () => {
  const gh = fakeGh({ user: "bot-account" });
  const project = projectIn();
  mkdirSync(join(project.root, ".sandcastle"));
  writeFileSync(join(project.root, ".sandcastle/.env"), "GH_TOKEN=github_pat_example\n");
  assert.equal(withPath(gh.dir, () => [tokenUserOf(project), tokenUserOf(project)]).join(), "bot-account,bot-account");
  assert.deepEqual(gh.calls(), ["api user --jq .login [GH_TOKEN=github_pat_example]"]);
});

test("the GitHub tracker keeps who wrote the ticket and each comment, beside the text", () => {
  const gh = fakeGh({
    listed: [
      {
        number: 7,
        title: "seven",
        body: "",
        author: { login: "reporter" },
        updatedAt: "2026-10-04T00:00:00Z",
        labels: [{ name: "ready-for-agent" }],
        comments: [
          { body: PLAIN, author: { login: "stranger" }, authorAssociation: "NONE" },
          { body: "ok", author: { login: "maintainer" }, authorAssociation: "OWNER" },
        ],
      },
    ],
  });
  const project = projectIn();
  const [t] = withPath(gh.dir, () => makeTracker(project).queued());
  assert.equal(t.author, "reporter");
  assert.deepEqual(t.comments, [PLAIN, "ok"]);
  assert.deepEqual(t.commentBy, [
    { login: "stranger", association: "NONE" },
    { login: "maintainer", association: "OWNER" },
  ]);
  assert.match(gh.calls()[0], /--json number,title,body,author,updatedAt,labels,comments/);
});

test("burndown reads the token's account at its start and takes the late-comment check through the trust", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /tracker\.kind === "github"\) tokenUserOf\(project\)/);
  assert.match(source, /trustOf\(read, tokenUserOf\(project\)\)/);
  assert.match(source, /carriedKindAtStart\(project\.root, project\.baseBranch, i, tracker\.kind === "github" \? tokenUserOf\(project\) : null\)/);
});
