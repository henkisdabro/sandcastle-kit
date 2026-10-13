// The status view's ticket links and its ctrl-click hint, on a terminal: inside Herdr they
// are emitted only once `sandcastle herdr configure` has left its marker under the kit's cache
// (no marker, no plugin, so a click would do nothing), and SANDCASTLE_LINKS overrides all of
// it. The pipe cases are in test/status.test.sh; only a pty from `script` reaches the marker
// check; a live view reads the marker again on each redraw, which the live tests change from
// outside while it runs. No Docker, no network, no model calls.
//
//   pnpm test:file test/status-links.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { buildFixture } from "./status-fixture.ts";
import { needsScript, startSession, type Painted, type Session } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-links-"));
// An older orchestrator's live run: #301 has a log, so it has a link.
const fixture = buildFixture("legacy", TMP);
const MARKER = join(fixture.cache, "sandcastle-kit", "herdr-plugin-linked");
after(() => {
  fixture.stop();
  rmSync(TMP, { recursive: true, force: true });
});
const link = () => {
  mkdirSync(dirname(MARKER), { recursive: true });
  writeFileSync(MARKER, "");
};
const unlink = () => rmSync(MARKER, { force: true });

const READ = (f: Pick<Painted, "raw" | "text">) => ({ linked: f.raw.includes("\x1b]8;;file://"), hint: f.text.includes("ctrl-click a ticket for its card") });
const NONE = { linked: false, hint: false };
const BOTH = { linked: true, hint: true };

const opened: Session[] = [];
afterEach(() => opened.splice(0).forEach((s) => s.close()));
const open = async (options: Parameters<typeof startSession>[1]) => {
  const s = await startSession(fixture, options);
  opened.push(s);
  return s;
};

// HERDR_ENV and SANDCASTLE_LINKS are set by the test (an empty string clears one): a test run from inside Herdr would otherwise carry its own.
const view = async (env: Record<string, string>) => {
  const s = await open({ args: ["0", "all"], cols: 100, env });
  await s.ended("it drew its frame");
  assert.ok(s.output().includes("#301"), `no ticket row drawn: ${s.output()}`);
  return READ({ raw: s.output(), text: s.output().replace(/\u001b\][^\u001b]*\u001b\\/g, "") });
};

test("inside Herdr with no plugin marker: no links, no hint", needsScript, async () => {
  unlink();
  assert.deepEqual(await view({ HERDR_ENV: "1" }), NONE);
});

test("inside Herdr with the plugin marker: links and the hint", needsScript, async () => {
  link();
  assert.deepEqual(await view({ HERDR_ENV: "1" }), BOTH);
});

test("outside Herdr a marker changes nothing, and SANDCASTLE_LINKS overrides it all", needsScript, async () => {
  link();
  assert.deepEqual(await view({}), NONE);
  assert.deepEqual(await view({ HERDR_ENV: "1", SANDCASTLE_LINKS: "0" }), NONE);
  unlink();
  assert.deepEqual(await view({ SANDCASTLE_LINKS: "1" }), BOTH);
});

// A live view reads the marker again on each redraw. The marker is changed from outside while the view runs, and a
// frame that starts after the change - the second one drawn after it, the first may already have been under way -
// shows it. A view that never read the marker again would draw none, and the wait for one would run out.
const second = async (s: Session, after: number) => {
  const first = await s.frame(after);
  return s.frame(first.end);
};

test("a view opened before the plugin was linked shows links once the marker appears", needsScript, async () => {
  unlink();
  const s = await open({ args: ["1"], env: { HERDR_ENV: "1" } });
  const first = await s.frame();
  assert.deepEqual(READ(first), NONE);
  link();
  const later = await s.frame(first.end, (f) => READ(f).linked, 15_000);
  assert.deepEqual(READ(later), BOTH);
});

test("a view drops its links once the marker goes", needsScript, async () => {
  link();
  const s = await open({ args: ["1"], env: { HERDR_ENV: "1" } });
  // A ticket's link needs the run record's logs: the first paint can come while the record still loads.
  const first = await s.frame(0, (f) => READ(f).linked, 15_000);
  assert.deepEqual(READ(first), BOTH);
  unlink();
  const later = await s.frame(first.end, (f) => !READ(f).linked, 15_000);
  assert.deepEqual(READ(later), NONE);
});

test("a marker that appears mid-view changes nothing outside Herdr or under SANDCASTLE_LINKS", needsScript, async () => {
  const outside: Record<string, string>[] = [{}, { HERDR_ENV: "1", SANDCASTLE_LINKS: "0" }];
  for (const env of outside) {
    unlink();
    const s = await open({ args: ["1"], env });
    const first = await s.frame();
    link();
    assert.deepEqual(READ(await second(s, first.end)), NONE, JSON.stringify(env));
    s.close();
  }
  link();
  const forced = await open({ args: ["1"], env: { SANDCASTLE_LINKS: "1" } });
  const first = await forced.frame(0, (f) => READ(f).linked, 15_000);
  unlink();
  assert.deepEqual([READ(first), READ(await second(forced, first.end))], [BOTH, BOTH]);
});
