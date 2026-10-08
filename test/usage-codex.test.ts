// Codex's 5-hour and weekly plan usage beside Claude's while cross-review runs (src/usage.ts, src/agents.ts):
// a `rate_limits` object parses to a reading by its windows' lengths, the cross-review pass's command carries
// the sandbox session's last `rate_limits` out as its closing stdout line, the run's collector reads it from the
// pass's sidecar next to Claude's, and a run shows it only on a ChatGPT plan. A fake `codex` on PATH writes the
// session the real one writes, in the shape Codex 0.160.0 wrote for a pass against a local stand-in server;
// temp directories only, no Docker, no model, no network.
//
//   pnpm test:file test/usage-codex.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import type { PlanUsage } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-usage-codex-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
// Read at import: cross-review on.
process.env.CROSS_REVIEW = "1";
after(() => rmSync(TMP, { recursive: true, force: true }));
const { crossReview } = await import("../src/agents.ts");
const { agentLog, agentLogging, rawLog } = await import("../src/run.ts");
const { codexSignIn, readCodexAuth, readPlanUsage, readPlanUsages, showsCodexUsage, usageFromCodexEvent, usageFromRateLimits, watchUsage } = await import("../src/usage.ts");

// The ticket's own numbers: the 5-hour window spent, the week 16%.
const LIMITS = {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 100.0, window_minutes: 300, resets_at: 1791188474 },
  secondary: { used_percent: 16.0, window_minutes: 10080, resets_at: 1791713039 },
  credits: null,
  individual_limit: null,
  spend_control_reached: null,
  plan_type: null,
  rate_limit_reached_type: null,
};
const READING = {
  provider: "codex",
  windows: { fiveHour: { percent: 100, resetsAt: 1791188474 }, week: { percent: 16, resetsAt: 1791713039 } },
  at: 1791190000,
};
// The `token_count` event of a Codex session, as Codex 0.160.0 wrote it (`info` shortened to its totals).
const tokenCount = (limits: unknown, ordinal = 11) =>
  JSON.stringify({
    timestamp: "2026-10-05T23:15:13.128Z",
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, total_tokens: 7 }, model_context_window: 258400 },
      rate_limits: limits,
    },
  });

test("a rate_limits object parses to the reading by the windows' lengths, 300 and 10080 minutes, whichever is primary or secondary", () => {
  assert.deepEqual(usageFromRateLimits(LIMITS, 1791190000), READING);
  // The week reported first, the 5-hour window second: the same reading.
  assert.deepEqual(usageFromRateLimits({ ...LIMITS, primary: LIMITS.secondary, secondary: LIMITS.primary }, 1791190000), READING);
  // A fraction rounds to the nearest percent, and a window past its limit stops at 100.
  const w = usageFromRateLimits({ primary: { used_percent: 42.4, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 130, window_minutes: 10080, resets_at: 2 } }, 1)?.windows;
  assert.deepEqual([w?.fiveHour.percent, w?.week.percent], [42, 100]);
});

test("rate_limits without both windows of those lengths, or with a window that is no reading, give none", () => {
  const five = { used_percent: 10, window_minutes: 300, resets_at: 1791188474 };
  const week = { used_percent: 20, window_minutes: 10080, resets_at: 1791713039 };
  for (const limits of [
    undefined,
    null,
    "rate_limits",
    {},
    { primary: five },
    { primary: five, secondary: null },
    { primary: five, secondary: { ...five } },
    { primary: five, secondary: { ...week, window_minutes: 60 } },
    { primary: { ...five, used_percent: "10" }, secondary: week },
    { primary: { ...five, used_percent: Number.NaN }, secondary: week },
    { primary: { ...five, resets_at: 0 }, secondary: week },
    { primary: five, secondary: { used_percent: 20, window_minutes: 10080 } },
  ]) assert.equal(usageFromRateLimits(limits, 1), undefined, JSON.stringify(limits));
});

test("a token_count line of the session parses, and no other line does", () => {
  assert.deepEqual(usageFromCodexEvent(tokenCount(LIMITS), 1791190000), READING);
  const text = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: 'it says "rate_limits"' } });
  for (const line of [
    "",
    "{",
    "not json, but it says \"rate_limits\"",
    tokenCount(null),
    tokenCount({ primary: LIMITS.primary }),
    text,
    tokenCount(LIMITS).replace('"type":"event_msg"', '"type":"response_item"'),
    tokenCount(LIMITS).replace('"type":"token_count"', '"type":"task_complete"'),
    // A reviewer that read a session file sees it as an escaped string inside a tool result: not a reading.
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: tokenCount(LIMITS) } }),
  ]) assert.equal(usageFromCodexEvent(line, 1), undefined, line);
});

// ---------------------------------------------------------------------------
// The cross-review pass's command, run as the sandbox runs it (`sh -c`, the prompt on stdin).
// ---------------------------------------------------------------------------

const FAKE_CODEX = `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"01a10e59-9032-7123-85cf-50458a610680"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2}}'
exit "\${FAKE_CODEX_EXIT:-0}"
`;
const bin = join(TMP, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "codex"), FAKE_CODEX);
chmodSync(join(bin, "codex"), 0o755);

/** A sandbox's home with `rollouts` (name, lines, mtime in seconds) under its Codex sessions directory, as Codex lays them out. */
const sandboxHome = (name: string, rollouts: { name: string; lines: string[]; mtime: number }[]) => {
  const home = join(TMP, name);
  const dir = join(home, ".codex", "sessions", "2026", "10", "05");
  mkdirSync(dir, { recursive: true });
  for (const r of rollouts) {
    const file = join(dir, `rollout-${r.name}.jsonl`);
    writeFileSync(file, r.lines.join("\n") + "\n");
    utimesSync(file, r.mtime, r.mtime);
  }
  return home;
};
const session = (limits: unknown) => [JSON.stringify({ type: "session_meta", payload: { session_id: "x" } }), tokenCount(limits), JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })];

const agent = (await crossReview("pass", async (a) => a))!;
const command = (agent.buildPrintCommand({ prompt: "review it", dangerouslySkipPermissions: true }) as { command: string; stdin: string }).command;

/** What the sandbox would do: run the pass's command with `home` as the home directory, `exit` the code the fake `codex` ends with. */
const runPass = (home: string, exit = 0) => {
  const r = spawnSync("sh", ["-c", command], { input: "review it", encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CODEX_EXIT: String(exit), CODEX_HOME: "" } });
  return { status: r.status, lines: r.stdout.split("\n").filter(Boolean), stderr: r.stderr };
};

test("the pass's command ends with the session's last rate_limits as one more stdout line, after codex's own lines", () => {
  const { status, lines } = runPass(sandboxHome("one-session", [{ name: "2026-10-05T23-15-13-a", lines: session(LIMITS), mtime: 1000 }]));
  assert.equal(status, 0);
  assert.equal(lines.length, 5, lines.join("\n"));
  assert.equal(lines[0], '{"type":"thread.started","thread_id":"01a10e59-9032-7123-85cf-50458a610680"}');
  assert.deepEqual(usageFromCodexEvent(lines[4], 1791190000), READING);
  for (const earlier of lines.slice(0, 4)) assert.equal(usageFromCodexEvent(earlier, 1), undefined);
});

test("the library still reads the pass as before: the reply is the result, and the extra line is none of its events", () => {
  const { lines } = runPass(sandboxHome("parsed", [{ name: "2026-10-05T23-15-13-a", lines: session(LIMITS), mtime: 1000 }]));
  const events = lines.map((l) => agent.parseStreamLine(l));
  assert.deepEqual(events[0], [{ type: "session_id", sessionId: "01a10e59-9032-7123-85cf-50458a610680" }]);
  assert.deepEqual(events[2], [{ type: "text", text: "hello" }, { type: "result", result: "hello" }]);
  assert.deepEqual(events[4], []);
  assert.equal(agent.captureSessions, false, "the session still stays out of the host's ~/.codex");
});

test("codex's exit code is the pass's, a failing one included, and its reading still comes out", () => {
  const home = sandboxHome("failing", [{ name: "2026-10-05T23-15-13-a", lines: session(LIMITS), mtime: 1000 }]);
  const { status, lines } = runPass(home, 3);
  assert.equal(status, 3);
  assert.deepEqual(usageFromCodexEvent(lines.at(-1) ?? "", 1791190000), READING, "a pass that hit the plan's limit is the one that most needs it shown");
});

test("the newest session is the pass's, and its last non-empty rate_limits is the reading", () => {
  const older = { ...LIMITS, primary: { ...LIMITS.primary, used_percent: 90 } };
  const home = sandboxHome("newest", [
    { name: "2026-10-05T20-00-00-old", lines: session(older), mtime: 1000 },
    // Later in the pass the account says nothing of limits (a reply with no limits on it): the last that did is kept.
    { name: "2026-10-05T23-15-13-new", lines: [tokenCount({ ...LIMITS, primary: { ...LIMITS.primary, used_percent: 55 } }, 3), tokenCount(null, 4)], mtime: 2000 },
  ]);
  const w = usageFromCodexEvent(runPass(home).lines.at(-1) ?? "", 1)?.windows;
  assert.deepEqual([w?.fiveHour.percent, w?.week.percent], [55, 16]);
});

test("no session, no limits in it, or limits only quoted in a file the reviewer read: no extra line, and the pass is as it was", () => {
  const quoted = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: tokenCount(LIMITS) } });
  const cases: [string, { name: string; lines: string[]; mtime: number }[]][] = [
    ["none", []],
    ["no-limits", [{ name: "a", lines: session(null), mtime: 1000 }]],
    ["quoted", [{ name: "a", lines: [quoted], mtime: 1000 }]],
  ];
  for (const [name, rollouts] of cases) {
    const { status, lines } = runPass(sandboxHome(`silent-${name}`, rollouts));
    assert.equal(status, 0, name);
    assert.equal(lines.length, 4, `${name}: ${lines.join("\n")}`);
  }
  // A home with no ~/.codex at all.
  const bare = join(TMP, "bare-home");
  mkdirSync(bare);
  assert.equal(runPass(bare).lines.length, 4);
});

// ---------------------------------------------------------------------------
// The run's collector, over the pass's sidecar written the way `agentLogging` writes it.
// ---------------------------------------------------------------------------

const project = (name: string) => {
  const root = join(TMP, name);
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  return { root, name: "fixture" } as Project;
};
/** One agent pass writing raw stream lines through the kit's own `agentLogging`, the sidecar stamped as written at `mtime` (seconds). */
const pass = (p: Project, id: string, name: string, run: string) => {
  const logging = agentLogging(p, id, name, run) as { onAgentStreamEvent: (e: unknown) => void };
  const file = rawLog(agentLog(p, id, name));
  return {
    say(lines: string[], mtime: number) {
      for (const line of lines) logging.onAgentStreamEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
      utimesSync(file, mtime, mtime);
    },
  };
};
const watching = (p: Project, run: string, providers?: ("claude" | "codex")[]) => {
  const clock = { ms: 1_791_190_000_000 };
  const written: PlanUsage[] = [];
  const watch = watchUsage({ logs: join(p.root, ".sandcastle/logs"), run, write: (r) => void written.push(r), now: () => clock.ms, providers });
  after(() => watch.stop());
  return { clock, written, watch };
};
const claudeEvent = (five: number, week: number) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: five, resetsAt: 1791195000 }, seven_day: { utilization: week, resetsAt: 1791324000 } } },
  });

test("a cross-review pass's output reaches the collector as Codex's reading, beside Claude's from another pass", () => {
  const p = project("collector");
  const { lines } = runPass(sandboxHome("collector-home", [{ name: "a", lines: session(LIMITS), mtime: 1000 }]));
  pass(p, "7", "impl-7", "run-1").say([claudeEvent(0.13, 0.92)], 5_000);
  pass(p, "7", "review-codex-7", "run-1").say(lines, 6_000);
  const { written, watch } = watching(p, "run-1");
  watch.poll();
  assert.deepEqual(written.map((r) => r.provider).sort(), ["claude", "codex"], "a reading of each, written together");
  assert.deepEqual(written.find((r) => r.provider === "codex"), READING);
  assert.deepEqual(written.find((r) => r.provider === "claude")?.windows, { fiveHour: { percent: 13, resetsAt: 1791195000 }, week: { percent: 92, resetsAt: 1791324000 } });
});

test("each provider's newest reading is its own: a later Claude pass does not replace Codex's", () => {
  const p = project("each-newest");
  const codexLines = (percent: number) => runPass(sandboxHome(`each-${percent}`, [{ name: "a", lines: session({ ...LIMITS, primary: { ...LIMITS.primary, used_percent: percent } }), mtime: 1000 }])).lines;
  const cross = pass(p, "7", "review-codex-7", "run-1");
  const impl = pass(p, "8", "impl-8", "run-1");
  const { clock, written, watch } = watching(p, "run-1");
  cross.say(codexLines(40), 5_000);
  impl.say([claudeEvent(0.1, 0.5)], 6_000);
  watch.poll();
  written.length = 0;
  // Claude's pass writes again, later than Codex's last, and says nothing of Codex.
  clock.ms += 20_000;
  impl.say([claudeEvent(0.2, 0.5)], 7_000);
  watch.poll();
  assert.deepEqual(written.map((r) => r.provider), ["claude"], "Codex's reading has not changed: not written again");
  // The next cross-review pass, lower and newer.
  written.length = 0;
  clock.ms += 20_000;
  cross.say(codexLines(25), 8_000);
  watch.poll();
  assert.deepEqual(written.map((r) => [r.provider, r.windows?.fiveHour.percent]), [["codex", 25]]);
});

test("a run that does not show Codex's usage reads none of it, whatever its agents print", () => {
  const p = project("claude-only");
  const { lines } = runPass(sandboxHome("claude-only-home", [{ name: "a", lines: session(LIMITS), mtime: 1000 }]));
  pass(p, "7", "review-codex-7", "run-1").say(lines, 5_000);
  const { written, watch } = watching(p, "run-1", ["claude"]);
  watch.poll(true);
  assert.deepEqual(written, []);
});

test("an earlier run's Codex reading in the same sidecar is not this run's", () => {
  const p = project("earlier");
  const { lines } = runPass(sandboxHome("earlier-home", [{ name: "a", lines: session(LIMITS), mtime: 1000 }]));
  pass(p, "7", "review-codex-7", "run-0").say(lines, 5_000);
  const now = pass(p, "7", "review-codex-7", "run-1");
  const { written, watch } = watching(p, "run-1");
  watch.poll();
  assert.deepEqual(written, []);
  now.say(lines, 6_000);
  watch.poll();
  assert.deepEqual(written, [READING]);
});

// ---------------------------------------------------------------------------
// When a run shows it.
// ---------------------------------------------------------------------------

const chatgpt = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: "y", refresh_token: "z", account_id: "a" }, last_refresh: "2026-10-05T00:00:00Z" });
const apikey = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-not-real" });

test("Codex's usage is shown with cross-review on a ChatGPT sign-in, and not with an API key, nor without cross-review", () => {
  assert.equal(showsCodexUsage({ crossReview: true, apiKey: false, auth: chatgpt }), true);
  assert.equal(showsCodexUsage({ crossReview: false, apiKey: false, auth: chatgpt }), false, "no cross-review pass, no reading to show");
  assert.equal(showsCodexUsage({ crossReview: true, apiKey: false, auth: apikey }), false, "an API key has no plan");
  // CODEX_API_KEY in the sandboxes' environment is spent in place of the login.
  assert.equal(showsCodexUsage({ crossReview: true, apiKey: true, auth: chatgpt }), false);
  assert.equal(showsCodexUsage({ crossReview: true, apiKey: false, auth: undefined }), false, "no login to read");
});

test("how Codex is signed in is read from auth.json's mode, and from its keys when an older Codex wrote none", () => {
  assert.equal(codexSignIn(chatgpt), "plan");
  assert.equal(codexSignIn(apikey), "api key");
  // An older file has no auth_mode: the key is an API key, the tokens a ChatGPT sign-in.
  assert.equal(codexSignIn(JSON.stringify({ OPENAI_API_KEY: "sk-test-not-real" })), "api key");
  assert.equal(codexSignIn(JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "y" } })), "plan");
  // Anything else says nothing: another sign-in, no sign-in, a file that is not one.
  for (const text of [undefined, "", "{", "null", "[]", "{}", JSON.stringify({ auth_mode: "agentIdentity", tokens: { access_token: "y" } }), JSON.stringify({ auth_mode: "other" })])
    assert.equal(codexSignIn(text), undefined, String(text));
});

test("the host's Codex login is read from the file the sandboxes get a copy of, and none is no login", () => {
  const file = join(TMP, "auth.json");
  assert.equal(readCodexAuth(file), undefined);
  writeFileSync(file, chatgpt);
  assert.equal(codexSignIn(readCodexAuth(file)), "plan");
});

test("a record's usage reads back as a list of well-formed entries, the object an older kit wrote included", () => {
  const claude = { provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: 5 }, week: { percent: 93, resetsAt: 6 } }, at: 7 };
  assert.deepEqual(readPlanUsages([claude, READING]), [claude, READING]);
  assert.deepEqual(readPlanUsages(claude), [claude]);
  assert.deepEqual(readPlanUsages([{ provider: "claude" }, { provider: "codex" }]), [{ provider: "claude" }, { provider: "codex" }]);
  assert.deepEqual(readPlanUsage({ ...READING, windows: { fiveHour: { percent: "lots", resetsAt: 1 }, week: READING.windows.week } }), { provider: "codex" });
  assert.deepEqual(readPlanUsages([claude, 3, "codex", null, { provider: "other", windows: claude.windows }, [1]]), [claude]);
  for (const junk of [undefined, null, "claude", 3, {}, []]) assert.deepEqual(readPlanUsages(junk), [], JSON.stringify(junk));
});
