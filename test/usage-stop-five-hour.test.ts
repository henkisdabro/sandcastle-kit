// USAGE_STOP keeps Claude's 5-hour window in view. Claude Code writes the weekly window alone in each pass,
// so a run's freshest agent reading often carries the week only. That reading must not stand in for the
// usage endpoint, the one source that always reports the 5-hour window: the guard would stop checking the
// window that runs out within a run. No Docker, no model, no network (fetch is stubbed).
//
//   pnpm test:file test/usage-stop-five-hour.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlanUsage } from "../mod/hooks/run-record.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.USAGE_CHECK = "1";
process.env.USAGE_STOP = "95";
const { usageStop } = await import("../src/usage.ts");

const T0 = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const now = () => (T0 + 60) * 1000;
const noLogin = { keychain: () => undefined, file: () => undefined };
const ENV = { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" };

const endpoint = (windows: Record<string, { utilization: number }>) => {
  const real = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => (requests.push(String(url)), new Response(JSON.stringify(windows), { status: 200 }))) as unknown as typeof fetch;
  return { requests, restore: () => void (globalThis.fetch = real) };
};

test("a fresh week-only agent reading does not hide a 5-hour window at USAGE_STOP: the endpoint is asked", async () => {
  const api = endpoint({ five_hour: { utilization: 98 }, seven_day: { utilization: 30 } });
  try {
    const weekOnly: PlanUsage = { provider: "claude", windows: { week: { percent: 30, resetsAt: T0 + 30 * HOUR } }, at: T0 };
    assert.equal(await usageStop(ENV, noLogin, () => weekOnly, now), "plan usage five_hour 98% reached USAGE_STOP=95%");
    assert.equal(api.requests.length, 1, "the endpoint answered for the window the reading lacks");
  } finally {
    api.restore();
  }
});

test("a fresh agent reading with both windows still decides alone, with no credential and no request", async () => {
  const api = endpoint({ five_hour: { utilization: 98 } });
  try {
    const both: PlanUsage = {
      provider: "claude",
      windows: { fiveHour: { percent: 20, resetsAt: T0 + 2 * HOUR }, week: { percent: 30, resetsAt: T0 + 30 * HOUR } },
      at: T0,
    };
    assert.equal(await usageStop({}, noLogin, () => both, now), undefined);
    assert.deepEqual(api.requests, []);
  } finally {
    api.restore();
  }
});
