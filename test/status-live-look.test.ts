// What the live view's frame looks like on a terminal: coloured (24-bit when COLORTERM
// says so, else the 256 palette), none with NO_COLOR, and ticket links with SANDCASTLE_LINKS=1 and none without.
// The view runs on a pty (test/status-run.ts); no Docker, no network, no model calls.
//
//   pnpm test:file test/status-live-look.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { buildFixture } from "./status-fixture.ts";
import { needsScript, startSession, type Session } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-live-look-"));
const fixture = buildFixture("legacy", TMP);
after(() => {
  fixture.stop();
  rmSync(TMP, { recursive: true, force: true });
});
const opened: Session[] = [];
afterEach(() => opened.splice(0).forEach((session) => session.close()));

/** The first frame the view draws with `env`, colour codes and links in. */
const firstFrame = async (env: Record<string, string>) => {
  const session = await startSession(fixture, { env });
  opened.push(session);
  return (await session.frame()).raw;
};

/** The first frame with the run record read (not `loading…`): the view paints before its sources answer, and under load the first frame has no ticket of the record yet (#744). */
const loadedFrame = async (env: Record<string, string>) => {
  const session = await startSession(fixture, { env });
  opened.push(session);
  return (await session.frame(0, (f) => !f.text.includes("loading…"), 15_000)).raw;
};

const TRUECOLOR = /\x1b\[38;2;[0-9;]+m/;
const PALETTE_256 = /\x1b\[38;5;[0-9]+m/;
const LINK = /\x1b\]8;;file:\/\/[^\x1b]*\/\.sandcastle\/logs\/agent-issue-[^\x1b]*\.log\x1b\\/;

test(`the live view is coloured on a terminal, in 24-bit when COLORTERM says so, and NO_COLOR takes it out`, needsScript, async () => {
  const deep = await firstFrame({ NO_COLOR: "", COLORTERM: "truecolor" });
  assert.match(deep, TRUECOLOR);
  const plain256 = await firstFrame({ NO_COLOR: "", COLORTERM: "" });
  assert.match(plain256, PALETTE_256);
  assert.doesNotMatch(plain256, TRUECOLOR);
  const none = await firstFrame({ NO_COLOR: "1", COLORTERM: "truecolor" });
  assert.doesNotMatch(none, /\x1b\[[0-9;]*m/);
});

test(`the live view links each ticket to its log with SANDCASTLE_LINKS=1, and not without`, needsScript, async () => {
  assert.match(await loadedFrame({ SANDCASTLE_LINKS: "1" }), LINK);
  assert.doesNotMatch(await loadedFrame({ SANDCASTLE_LINKS: "0" }), /\x1b\]8;/);
});
