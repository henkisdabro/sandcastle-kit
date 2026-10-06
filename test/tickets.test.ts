// The ticket-file parsers (src/tracker.ts): the metadata block under a title,
// a ticket file read from disk, and the tracker choice read from docs/agents.
// Fixtures are written with explicit "\n" line endings in temp directories.
//
//   node --test test/tickets.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Keep the import from reading the user's real config, as in blockers.test.ts.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { detectFromDocs, headerOf, readTicket, resolveTracker, statusOf } = await import("../src/tracker.ts");

const tmp = () => mkdtempSync(join(tmpdir(), "sandcastle-tickets-"));

test("statusOf reads a plain Status line under the title", () => {
  assert.deepEqual(statusOf("# Add cart\n\nStatus: ready-for-agent\n\nBody text"), "ready-for-agent");
});

test("statusOf reads a bold Status line, lower-cased", () => {
  assert.deepEqual(statusOf("# T\n\n**Status:** Done\n"), "done");
});

test("statusOf reads YAML front matter", () => {
  assert.deepEqual(statusOf("---\nstatus: closed\n---\n# T\n"), "closed");
});

test("a Status line in the prose is not metadata", () => {
  assert.deepEqual(statusOf("# T\n\nSome prose.\n\nStatus: done\n"), undefined);
});

test("headerOf stops at the first line that is not Key: value", () => {
  const { meta, title } = headerOf("# T\n\nStatus: ready\nBlocked by: 01\n\nBody\n");
  assert.deepEqual(title, 0);
  assert.deepEqual([...meta.keys()], ["status", "blocked by"]);
});

test("readTicket takes id, status and zero-padded blockers from the header", () => {
  const root = tmp();
  writeFileSync(join(root, "f.md"), "# T\n\nStatus: ready\nBlocked by: 01, 2\n");
  const t = readTicket(root, "f.md", "Add Cart", "03");
  assert.deepEqual(
    { id: t.id, status: t.status, blockedBy: t.blockedBy },
    { id: "add-cart-03", status: "ready", blockedBy: ["01", "02"] },
  );
});

test("readTicket leaves a '#12' blocker to the body-style reader", () => {
  const root = tmp();
  writeFileSync(join(root, "f.md"), "# T\n\nStatus: ready\nBlocked by: #12\n");
  assert.deepEqual(readTicket(root, "f.md", "Add Cart", "03").blockedBy, []);
});

const docs = (root: string, file: string, text: string) => {
  mkdirSync(join(root, "docs/agents"), { recursive: true });
  writeFileSync(join(root, "docs/agents", file), text);
};

test("detectFromDocs finds nothing without a docs/agents directory", () => {
  assert.deepEqual(detectFromDocs(tmp()), {});
});

test("detectFromDocs reads the tracker kind from the issue-tracker title", () => {
  const github = tmp();
  docs(github, "issue-tracker.md", "# Issue tracker: GitHub\n\nText\n");
  assert.deepEqual(detectFromDocs(github), { kind: "github" });
  const files = tmp();
  docs(files, "issue-tracker.md", "# Issue tracker: Local Markdown\n\nText\n");
  assert.deepEqual(detectFromDocs(files), { kind: "files" });
});

test("detectFromDocs reports a tracker the kit does not support", () => {
  const root = tmp();
  docs(root, "issue-tracker.md", "# Issue tracker: Jira\n\nText\n");
  assert.deepEqual(detectFromDocs(root), { unsupported: "Jira" });
});

test("detectFromDocs reads each role's label from the triage table", () => {
  const root = tmp();
  docs(root, "triage-labels.md", "# Labels\n\n| Role | Label |\n|---|---|\n| `ready-for-agent` | `agent-ready` |\n");
  assert.deepEqual(detectFromDocs(root), { labels: { "ready-for-agent": "agent-ready" } });
});

test("resolveTracker takes the hold, triage and wontfix labels from Matt's table, else his names", () => {
  const plain = resolveTracker(tmp());
  assert.deepEqual([plain.held, plain.triage, plain.done], ["ready-for-human", "needs-triage", ["done", "closed", "resolved", "wontfix"]]);
  const root = tmp();
  docs(
    root,
    "triage-labels.md",
    "| Label in mattpocock/skills | Label in our tracker | Meaning |\n| --- | --- | --- |\n" +
      "| `needs-triage` | `triage-me` | x |\n| `ready-for-human` | `needs-human` | x |\n| `wontfix` | `Not-Doing` | x |\n",
  );
  const mapped = resolveTracker(root, "files");
  assert.deepEqual([mapped.held, mapped.triage, mapped.done.at(-1)], ["needs-human", "triage-me", "not-doing"]);
});
