// USAGE_PAUSE keeps Claude's 5-hour window in view. Claude Code writes the weekly window alone in each pass,
// so the agents' readings often lack the 5-hour window - the one that runs out within a run - and a pause
// that judged only those readings would let an agent run into the limit it was set to avoid. When a reading
// lacks a window, the pause takes that one from the usage endpoint USAGE_STOP reads, through its cache.
// The pause is driven through its ports with a fake clock; fetch is stubbed. No Docker, no model, no network.
//
//   pnpm test:file test/usage-pause-five-hour.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlanUsage, UsagePaused } from "../mod/hooks/run-record.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createUsagePause, usageEndpointWindows, usagePauseWords } = await import("../src/usage.ts");
type Ports = Parameters<typeof createUsagePause>[1];

const T0 = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const FIVE_RESET = T0 + 2 * HOUR;
const WEEK_RESET = T0 + 30 * HOUR;

const weekOnly = (percent = 30): PlanUsage => ({ provider: "claude", windows: { week: { percent, resetsAt: WEEK_RESET } }, at: T0 });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/** The pause at 90% over a fake clock, with the holds and lines it gives kept, and `endpoint` as its reader. */
const world = (endpoint?: Ports["endpoint"]) => {
  const clock = { seconds: T0 };
  const held: UsagePaused[] = [];
  const said: string[] = [];
  const pause = createUsagePause(90, {
    standing: () => undefined,
    hold: (p) => void held.push(p),
    now: () => clock.seconds * 1000,
    resumed: new Set(),
    ...(endpoint && { endpoint }),
    say: (line) => void said.push(line),
  });
  return { clock, held, said, pause };
};

test("a week-only reading below the pause and an endpoint 5-hour window at it pause the run until that window's reset", async () => {
  let calls = 0;
  const { held, pause } = world(async () => (calls++, { windows: { fiveHour: { percent: 93, resetsAt: FIVE_RESET } } }));
  pause.reading([weekOnly()]);
  await until(() => held.length > 0, "the pause to be held");
  assert.deepEqual(held.at(-1), { cause: "usage", provider: "claude", window: "fiveHour", percent: 93, resumesAt: FIVE_RESET + 60 });
  assert.equal(usagePauseWords(held.at(-1)!), "5-hour usage 93%", "the pause line names the 5-hour window");
  assert.equal(calls, 1);
});

test("readings that carry both windows never call the endpoint reader, so no credential is read", async () => {
  const { held, pause } = world(() => assert.fail("the endpoint reader was called"));
  const both: PlanUsage = { provider: "claude", windows: { fiveHour: { percent: 20, resetsAt: FIVE_RESET }, week: { percent: 30, resetsAt: WEEK_RESET } }, at: T0 };
  assert.equal(pause.reading([both]), undefined);
  await sleep(20);
  assert.deepEqual(held, []);
});

test("an endpoint failure leaves the pause judging the windows it has, and says once that the 5-hour window could not be read", async () => {
  const { clock, held, said, pause } = world(async () => ({ why: "the usage endpoint answered HTTP 429, rate-limited" }));
  assert.equal(pause.reading([weekOnly()]), undefined);
  await until(() => said.length > 0, "the line about the unread window");
  assert.deepEqual(said, ["Usage pause: Claude's 5-hour window could not be read (the usage endpoint answered HTTP 429, rate-limited); the pause judges the windows it has."]);
  // The week the agents report still pauses the run at the threshold.
  const asked = pause.reading([weekOnly(95)]);
  assert.deepEqual(asked, { cause: "usage", provider: "claude", window: "week", percent: 95, resumesAt: WEEK_RESET + 60 });
  // Asked again after ten minutes, failing again: nothing more is said.
  clock.seconds += 10 * 60;
  pause.reading([weekOnly()]);
  await sleep(20);
  assert.equal(said.length, 1);
  assert.equal(held.length, 1);
});

test("the endpoint is asked at most once each ten minutes, however many readings come in", async () => {
  let calls = 0;
  const { clock, held, pause } = world(async () => (calls++, { windows: { fiveHour: { percent: 40, resetsAt: FIVE_RESET } } }));
  for (let i = 0; i < 5; i++) pause.reading([weekOnly()]);
  await sleep(20);
  for (let i = 0; i < 5; i++) {
    clock.seconds += 60;
    pause.reading([weekOnly()]);
  }
  await sleep(20);
  assert.equal(calls, 1, "one ask in the first ten minutes");
  clock.seconds = T0 + 10 * 60;
  pause.reading([weekOnly()]);
  await sleep(20);
  assert.equal(calls, 2, "asked again once ten minutes have passed");
  assert.deepEqual(held, []);
});

test("the real reader takes the windows and their reset times from the endpoint's answer, one request for every ask within its cache", async () => {
  const real = globalThis.fetch;
  const requests: string[] = [];
  const reset = new Date(FIVE_RESET * 1000).toISOString();
  globalThis.fetch = (async (url: string) => (
    requests.push(String(url)),
    new Response(JSON.stringify({ five_hour: { utilization: 93.4, resets_at: reset }, seven_day: { utilization: 12, resets_at: null } }), { status: 200 })
  )) as unknown as typeof fetch;
  const noLogin = { keychain: () => undefined, file: () => undefined };
  try {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" };
    assert.deepEqual(await usageEndpointWindows(env, noLogin), { windows: { fiveHour: { percent: 93, resetsAt: FIVE_RESET } } });
    await usageEndpointWindows(env, noLogin);
    assert.equal(requests.length, 1, "the second ask is the cached reading");
    assert.deepEqual(await usageEndpointWindows({}, noLogin), { why: "no subscription token (CLAUDE_CODE_OAUTH_TOKEN) to read it with" });
  } finally {
    globalThis.fetch = real;
  }
});
