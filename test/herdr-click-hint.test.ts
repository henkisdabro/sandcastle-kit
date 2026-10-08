// The status view's click hint: the terminal each attached Herdr client was started from, mapped
// to the modifier that opens a ticket's log there; the clients picked from made-up `ps` output and
// session lists; the override's precedence; a bad setting. No Herdr, no Docker, no network.
//
//   pnpm test:file test/herdr-click-hint.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-click-hint-"));
// src/ reads XDG_CONFIG_HOME when it is imported: never the machine's own config.json.
process.env.XDG_CONFIG_HOME = temp();
const { attachedClients, clientSession, herdrSettingProblem, HINT_TEXT, linuxProcesses, parsePsEnv, parseSessions, resolveClickHint, sensedHint, terminalOf } = await import(
  "../src/click-hint.ts"
);
const { PLUGIN_DIR } = await import("../src/herdr-plugin.ts");

test("each terminal maps to its name and modifier", () => {
  assert.deepEqual(terminalOf({ LC_TERMINAL: "iTerm2", TERM_PROGRAM: "tmux" }), { name: "iTerm2", mod: "cmd" });
  assert.deepEqual(terminalOf({ TERM_PROGRAM: "iTerm.app" }), { name: "iTerm2", mod: "cmd" });
  assert.deepEqual(terminalOf({ TERM_PROGRAM: "Apple_Terminal" }), { name: "Terminal.app", mod: "ctrl" });
  assert.deepEqual(terminalOf({ TERM_PROGRAM: "ghostty" }), { name: "Ghostty", mod: "ctrl" });
  // Unsurveyed: named where known, the fallback all the same.
  assert.deepEqual(terminalOf({ TERM_PROGRAM: "WezTerm", WEZTERM_EXECUTABLE: "/opt/wezterm" }), { name: "WezTerm", mod: "fallback" });
  assert.deepEqual(terminalOf({ KITTY_WINDOW_ID: "1" }), { name: "Kitty", mod: "fallback" });
  assert.deepEqual(terminalOf({ VTE_VERSION: "7600" }), { name: "a VTE terminal", mod: "fallback" });
  assert.deepEqual(terminalOf({ TERM_PROGRAM: "vscode" }), { name: "vscode", mod: "fallback" });
  assert.deepEqual(terminalOf({}), { name: undefined, mod: "fallback" });
});

test("clients that agree give their hint; disagreeing clients or none give the fallback", () => {
  assert.equal(sensedHint([{ LC_TERMINAL: "iTerm2" }]).mod, "cmd");
  assert.equal(sensedHint([{ TERM_PROGRAM: "ghostty" }, { TERM_PROGRAM: "ghostty" }]).mod, "ctrl");
  assert.equal(sensedHint([{ TERM_PROGRAM: "Apple_Terminal" }]).terminal, "Terminal.app");
  const split = sensedHint([{ LC_TERMINAL: "iTerm2" }, { TERM_PROGRAM: "ghostty" }]);
  assert.equal(split.mod, "fallback");
  assert.match(split.why, /disagree \(iTerm2, Ghostty\)/);
  assert.equal(sensedHint([{ TERM_PROGRAM: "ghostty" }, {}]).mod, "fallback");
  const none = sensedHint([]);
  assert.equal(none.mod, "fallback");
  assert.match(none.why, /no Herdr client/);
  assert.match(sensedHint([{ KITTY_WINDOW_ID: "3" }]).why, /sensed Kitty/);
});

test("only a bare client, --session NAME or session attach NAME is a client", () => {
  assert.equal(clientSession(["herdr"]), null);
  assert.equal(clientSession(["/opt/homebrew/bin/herdr"]), null);
  assert.equal(clientSession(["herdr", "--session", "work"]), "work");
  assert.equal(clientSession(["herdr", "session", "attach", "work"]), "work");
  for (const argv of [
    ["herdr", "server"],
    ["herdr", "--remote", "box"],
    ["herdr", "--session", "work", "--remote", "box"],
    ["herdr", "remote-client-bridge"],
    ["herdr", "plugin", "list"],
    ["herdr", "session", "list"],
    ["herdrx"],
    ["sh", "herdr"],
    [],
  ]) {
    assert.equal(clientSession(argv), undefined, argv.join(" "));
  }
});

const SESSIONS = JSON.stringify({
  result: {
    sessions: [
      { name: "default", socket_path: "/run/herdr/default.sock", is_default: true },
      { name: "work", socket_path: "/run/herdr/work.sock", is_default: false },
    ],
  },
});

test("macOS: the clients on the view's own server, from one ps listing with environments", () => {
  const ps = [
    "  101 herdr TERM_PROGRAM=iTerm.app LC_TERMINAL=iTerm2 HOME=/h",
    "  102 herdr --session work TERM_PROGRAM=ghostty HOME=/h",
    "  103 herdr session attach work TERM_PROGRAM=Apple_Terminal",
    "  104 herdr server TERM_PROGRAM=Apple_Terminal",
    "  105 herdr remote-client-bridge TERM_PROGRAM=WezTerm",
    "  106 herdr --remote box TERM_PROGRAM=WezTerm",
    "  107 /bin/zsh -l TERM_PROGRAM=herdr",
  ].join("\n");
  const procs = parsePsEnv(ps);
  assert.deepEqual(procs[1], { argv: ["herdr", "--session", "work"], env: { TERM_PROGRAM: "ghostty" } });
  const sessions = parseSessions(SESSIONS);
  // A bare client is the default session's.
  assert.deepEqual(attachedClients(procs, sessions, "/run/herdr/default.sock"), [{ TERM_PROGRAM: "iTerm.app", LC_TERMINAL: "iTerm2" }]);
  // Both spellings of a named session; the server and the remote clients never.
  assert.deepEqual(attachedClients(procs, sessions, "/run/herdr/work.sock"), [{ TERM_PROGRAM: "ghostty" }, { TERM_PROGRAM: "Apple_Terminal" }]);
  assert.equal(sensedHint(attachedClients(procs, sessions, "/run/herdr/work.sock")).mod, "ctrl");
  // A server nobody listed: no client.
  assert.deepEqual(attachedClients(procs, sessions, "/run/herdr/other.sock"), []);
});

test("Linux: the pids from ps, argv and environment from /proc", () => {
  const proc: Record<string, string> = {
    "/proc/201/cmdline": "herdr\0",
    "/proc/201/environ": "HOME=/h\0VTE_VERSION=7600\0TERM_PROGRAM=gnome-terminal\0",
    "/proc/202/cmdline": "/usr/local/bin/herdr\0server\0",
    "/proc/202/environ": "TERM_PROGRAM=kitty\0",
  };
  const read = (path: string) => {
    if (!(path in proc)) throw new Error("ENOENT");
    return proc[path];
  };
  // 203 ended between the listing and the read: skipped, not an error.
  const procs = linuxProcesses("  201 herdr\n  202 /usr/local/bin/herdr server\n  203 herdr\n  204 bash\n", read);
  assert.deepEqual(procs, [
    { argv: ["herdr"], env: { VTE_VERSION: "7600", TERM_PROGRAM: "gnome-terminal" } },
    { argv: ["/usr/local/bin/herdr", "server"], env: { TERM_PROGRAM: "kitty" } },
  ]);
  const clients = attachedClients(procs, parseSessions(SESSIONS), "/run/herdr/default.sock");
  assert.deepEqual(sensedHint(clients), { mod: "fallback", terminal: "a VTE terminal", why: "sensed a VTE terminal, whose click the kit has not surveyed" });
});

test("a session list whose default is only its name, or a bare list, still names the default", () => {
  const procs = [{ argv: ["herdr"], env: { TERM_PROGRAM: "ghostty" } }];
  assert.equal(attachedClients(procs, parseSessions(JSON.stringify([{ name: "default", socket_path: "/s" }])), "/s").length, 1);
  assert.equal(attachedClients(procs, parseSessions(JSON.stringify({ sessions: [{ name: "work", socket_path: "/s" }] })), "/s").length, 0);
});

const IN_HERDR = { HERDR_SOCKET_PATH: "/run/herdr/default.sock" };
const iterm = () => [{ LC_TERMINAL: "iTerm2" }];

test("SANDCASTLE_CLICK_HINT wins over config.json, which wins over the sensor", () => {
  assert.equal(resolveClickHint({ ...IN_HERDR, SANDCASTLE_CLICK_HINT: "ctrl" }, () => ({ herdr: { clickHint: "cmd" } }), iterm).mod, "ctrl");
  assert.equal(resolveClickHint({ ...IN_HERDR }, () => ({ herdr: { clickHint: "ctrl" } }), iterm).mod, "ctrl");
  // auto in the environment senses, whatever the file says.
  assert.equal(resolveClickHint({ ...IN_HERDR, SANDCASTLE_CLICK_HINT: "auto" }, () => ({ herdr: { clickHint: "ctrl" } }), iterm).mod, "cmd");
  assert.equal(resolveClickHint({ ...IN_HERDR }, () => ({ herdr: { clickHint: "auto" } }), iterm).mod, "cmd");
  assert.equal(resolveClickHint({ ...IN_HERDR }, () => ({}), iterm).mod, "cmd");
  // Outside Herdr nothing is sensed (and no process is listed).
  let sensed = false;
  const hint = resolveClickHint({}, () => ({}), () => ((sensed = true), iterm()));
  assert.equal(hint.mod, "fallback");
  assert.equal(sensed, false);
  // An override needs no sensing either.
  resolveClickHint({ ...IN_HERDR, SANDCASTLE_CLICK_HINT: "cmd" }, () => ({}), () => ((sensed = true), []));
  assert.equal(sensed, false);
});

test("a bad value, an unreadable file or a failing sensor gives the fallback, never an error", () => {
  for (const herdr of ["cmd", { clickHint: "alt" }, { clickHint: "cmd", panes: "all" }, null, ["cmd"]]) {
    assert.equal(resolveClickHint({ ...IN_HERDR }, () => ({ herdr }), iterm).mod, "fallback", JSON.stringify(herdr));
  }
  assert.equal(resolveClickHint({ ...IN_HERDR, SANDCASTLE_CLICK_HINT: "shift" }, () => ({}), iterm).mod, "fallback");
  const unreadable = resolveClickHint({ ...IN_HERDR }, () => { throw new Error("not valid JSON"); }, iterm);
  assert.equal(unreadable.mod, "fallback");
  assert.match(unreadable.why, /could not be read/);
  assert.equal(resolveClickHint({ ...IN_HERDR }, () => ({}), () => { throw new Error("ps: not found"); }).mod, "fallback");
});

test("herdrSettingProblem accepts clickHint alone, with auto, ctrl or cmd", () => {
  for (const ok of [undefined, {}, { clickHint: "auto" }, { clickHint: "ctrl" }, { clickHint: "cmd" }]) assert.equal(herdrSettingProblem(ok), undefined);
  assert.match(herdrSettingProblem({ clickHint: "alt" }) ?? "", /"clickHint": "alt", not "auto", "ctrl" or "cmd"/);
  assert.match(herdrSettingProblem({ panes: "all" }) ?? "", /holds `panes`; its only key is "clickHint"/);
  assert.match(herdrSettingProblem("cmd") ?? "", /not an object/);
});

test("status.sh draws the same three texts", () => {
  const sh = readFileSync(join(KIT, "status.sh"), "utf8");
  for (const [mod, text] of Object.entries(HINT_TEXT)) {
    assert.ok(sh.includes(`${mod === "fallback" ? "*" : mod}) CLICK_HINT="${text}"`), `${mod}: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// doctor: the bad value in the settings check, and the hint's info line inside Herdr.
// ---------------------------------------------------------------------------

const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const doctor = (settings: string | undefined, env: Record<string, string> = {}) => {
  const home = temp();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const herdrList = JSON.stringify({ result: { plugins: [{ plugin_id: "sandcastle-kit", plugin_root: PLUGIN_DIR }] } });
  const shims: Record<string, string> = {
    git: `#!/bin/sh\nexec ${realGit} "$@"\n`,
    gh: "#!/bin/sh\nexit 0\n",
    jq: "#!/bin/sh\nexit 0\n",
    // Only what doctor asks: the plugin list and the help's config path. Anything else fails.
    herdr: `#!/bin/sh\ncase "$*" in\n  "plugin list --json") echo '${herdrList}' ;;\n  --help) echo "Config: ${join(home, "herdr.toml")}" ;;\n  *) exit 1 ;;\nesac\n`,
  };
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(home, "config");
  if (settings !== undefined) {
    mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
    writeFileSync(join(config, "sandcastle-kit", "config.json"), settings);
  }
  const r = runKit(["doctor"], {
    cwd: home,
    encoding: "utf8",
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: home,
      CLAUDE_CODE_VERSION: "2.1.0",
      CODEX_VERSION: "0.1.0",
      ...env,
    },
  });
  return (r.stdout as string) + (r.stderr as string);
};

test("doctor reports a herdr value other than {clickHint: auto | ctrl | cmd}", () => {
  assert.match(doctor('{"herdr": {"clickHint": "cmd"}}'), /^ok +machine-wide settings/m);
  const out = doctor('{"herdr": {"clickHint": "alt"}}');
  assert.match(out, /^FIX +machine-wide settings/m);
  assert.match(out, /"herdr" in \S+config\.json has "clickHint": "alt", not "auto", "ctrl" or "cmd"\./);
  assert.match(out, /Set it to `\{"clickHint": "auto"\}`/);
});

test("doctor inside Herdr with the plugin linked names the hint, why, and the override", () => {
  const out = doctor(undefined, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nowhere/herdr.sock", SANDCASTLE_CLICK_HINT: "cmd" });
  const line = out.split("\n").find((l) => l.startsWith("info status view's click hint"));
  assert.ok(line, out);
  assert.match(line, /"cmd-click a ticket for its log" - set by SANDCASTLE_CLICK_HINT=cmd\. Override: SANDCASTLE_CLICK_HINT=ctrl or cmd/);
  // Outside Herdr there is no plugin to click through, and no line.
  assert.ok(!doctor(undefined, { SANDCASTLE_CLICK_HINT: "cmd" }).includes("click hint"));
});
