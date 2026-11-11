// The Markdown ticket-files tracker reads a ticket's `Status:` without regard to case, and a ticket
// saved with Windows line endings or a UTF-8 BOM still has its header, its title and its blockers.
// Temp git repos only.
//
//   pnpm test:file test/tracker-files.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { blockerWhy } = await import("../src/blockers.ts");
const { headerOf, makeTracker, readTicket, requeueTicketWithEffect, statusOf } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const BOM = "﻿";
const ticketPath = (n: string, name = "a") => `.scratch/cart/issues/${n}-${name}.md`;

// A fresh repo with the given tickets committed, and the files tracker over it.
const setup = (files: Record<string, string>, label: string, done: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  // The tracker commits with the repository's own identity, and the test environment has none.
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", ".");
  git("commit", "-q", "-m", "tickets");
  const project = { root, name: "t", baseBranch: "main", label, tracker: fakeTracker({ kind: "files", dir: ".scratch", done }) } as unknown as Project;
  return { root, project, tracker: makeTracker(project) };
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

test("a ticket whose Status is written in another case than the label is queued, then closed and read as closed", () => {
  const { project, tracker } = setup({ [ticketPath("01")]: "# Cart\n\nStatus: todo\n\nBody\n" }, "Todo", ["Done"]);
  assert.deepEqual(tracker.queued().map((t) => t.id), ["cart-01"]);
  assert.equal(tracker.get("cart-01").open, true);
  tracker.close("cart-01", "finished");
  const closed = tracker.get("cart-01");
  assert.equal(closed.open, false);
  assert.deepEqual(tracker.open().map((t) => t.id), []);
  assert.deepEqual(tracker.queued().map((t) => t.id), []);
  assert.equal(project.tracker.kind, "files");
});

test("a status written exactly as the configured done word still closes the ticket", () => {
  const { root, tracker } = setup({ [ticketPath("01")]: "# Cart\n\nStatus: Todo\n" }, "todo", ["Shipped", "Done"]);
  tracker.close("cart-01", "finished");
  assert.match(read(root, ticketPath("01")), /^Status: Shipped$/m);
  assert.equal(tracker.get("cart-01").open, false);
});

test("requeue of a ticket still queued under a capitalised label only adds the note", () => {
  const { tracker } = setup({ [ticketPath("01")]: "# Cart\n\nStatus: Todo\n" }, "Todo", ["Done"]);
  const out = requeueTicketWithEffect(tracker, "Todo", ["cart-01", "--note", "mind the edge case"]);
  assert.match(out.message, /still in the queue; added your note/);
  assert.equal(out.relabelled, false);
});

test("a blocker whose Status is the capitalised label is not reported as unqueued", () => {
  const { project, tracker } = setup({ [ticketPath("01")]: "# Cart\n\nStatus: Todo\n", [ticketPath("02", "b")]: "# B\n\nStatus: Ready\n" }, "Todo", ["Done"]);
  const why = blockerWhy(project, tracker);
  assert.equal(why({ kind: "ticket", id: "cart-01", state: "open" } as never), undefined);
  assert.equal(why({ kind: "ticket", id: "cart-02", state: "open" } as never), "unqueued");
});

test("a CRLF ticket is read with its Status, Blocked by and title, and stays CRLF after close", () => {
  const text = "# Cart total\r\n\r\nStatus: ready-for-agent\r\nBlocked by: 02\r\n\r\nBody line\r\n";
  const { root, tracker } = setup({ [ticketPath("01")]: text, [ticketPath("02", "b")]: "# B\n\nStatus: ready-for-agent\n" }, "ready-for-agent", ["done"]);
  assert.equal(statusOf(text), "ready-for-agent");
  assert.deepEqual(readTicket(root, ticketPath("01"), "cart", "01").blockedBy, ["02"]);
  assert.deepEqual(tracker.queued().map((t) => t.id).sort(), ["cart-01", "cart-02"]);
  assert.equal(tracker.get("cart-01").title, "Cart total");
  tracker.close("cart-01", "report text\nsecond line");
  const after = read(root, ticketPath("01"));
  assert.doesNotMatch(after, /(?<!\r)\n/);
  assert.match(after, /^Status: done\r$/m);
  assert.match(after, /report text\r\nsecond line\r\n$/);
  assert.equal(tracker.get("cart-01").open, false);
});

test("a CRLF ticket with front matter and a hold or comment stays CRLF", () => {
  const text = "---\r\nstatus: ready\r\n---\r\n# T\r\n\r\nBody\r\n";
  assert.equal(statusOf(text), "ready");
  const { root, tracker } = setup({ [ticketPath("01")]: text }, "ready", ["done"]);
  tracker.comment("cart-01", "a note");
  tracker.hold("cart-01", "needs a person");
  const after = read(root, ticketPath("01"));
  assert.doesNotMatch(after, /(?<!\r)\n/);
  assert.match(after, /^status: ready-for-human\r$/m);
});

test("a BOM ticket is read with its Status, Blocked by and title, and keeps its BOM after close", () => {
  const text = `${BOM}# Cart total\n\nStatus: ready-for-agent\nBlocked by: 02\n\nBody\n`;
  const { root, tracker } = setup({ [ticketPath("01")]: text, [ticketPath("02", "b")]: "# B\n\nStatus: done\n" }, "ready-for-agent", ["done"]);
  assert.equal(statusOf(text), "ready-for-agent");
  assert.deepEqual(headerOf(text).meta.get("blocked by")?.value, "02");
  assert.deepEqual(readTicket(root, ticketPath("01"), "cart", "01").blockedBy, ["02"]);
  assert.equal(tracker.get("cart-01").title, "Cart total");
  assert.equal(tracker.get("cart-01").open, true);
  tracker.close("cart-01", "report");
  const after = read(root, ticketPath("01"));
  assert.ok(after.startsWith(`${BOM}# Cart total`));
  assert.ok(!after.slice(1).includes(BOM));
  assert.match(after, /^Status: done$/m);
  assert.equal(tracker.get("cart-01").open, false);
});

test("a BOM before YAML front matter is still front matter", () => {
  assert.equal(statusOf(`${BOM}---\nstatus: Done\n---\n# T\n`), "done");
});
