// `sandcastle setup` - the interactive install: links the command and the
// skill, writes the credentials file, then hands over to doctor. Safe to re-run:
// every step checks before it acts, so a second run fixes only what changed.
// It installs no software and edits no shell files - it prints those commands.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { doctor, probeGithubToken, run } from "./doctor.ts";
import { OperatorError } from "./errors.ts";
import { configure, pluginState } from "./herdr-plugin.ts";
import { KIT, USER_CONFIG } from "./sandbox.ts";

// Ctrl-C at a question rejects it with an AbortError, which reached the operator as a stack
// trace; it ends setup, as it does at a token prompt.
const ask = async (q: string) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(q)).trim();
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
    stdout.write("\n");
    process.exit(130);
  } finally {
    rl.close();
  }
};

const yes = async (q: string, byDefault: boolean) => {
  const a = (await ask(`${q} ${byDefault ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a.startsWith("y") : byDefault;
};

// Tokens are read with echo off, so they never land in scrollback or a
// screen recording.
const secret = (q: string) =>
  new Promise<string>((resolve) => {
    stdout.write(q);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let s = "";
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolve(s.trim());
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        s = c === "\u007f" || c === "\b" ? s.slice(0, -1) : s + c;
      }
    };
    stdin.on("data", onData);
  });

const has = (cmd: string) => !!run("sh", ["-c", `command -v ${cmd}`]);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

// Unlike `ln -sfn`, this never drops a link inside a real directory that
// already sits at the target.
const link = async (target: string, path: string, label: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const st = (() => {
    try {
      return lstatSync(path);
    } catch {
      return undefined;
    }
  })();
  if (st) {
    if (!st.isSymbolicLink()) return console.log(`skip ${label}: ${path} exists and is not a link - move it away and run setup again`);
    if (real(path) === real(target)) return console.log(`ok   ${label}`);
    if (!(await yes(`${path} points at ${readlinkSync(path)}. Point it at this kit instead?`, false))) return;
    unlinkSync(path);
  }
  symlinkSync(target, path);
  console.log(`done ${label}: ${path}`);
};

// Keeps comments and other keys; drops empty `KEY=` lines, which a run
// refuses, and replaces the keys being set. `drop` removes further keys, so a
// replaced credential of the other kind cannot keep winning over the new one.
export const writeEnv = (file: string, set: Record<string, string>, drop: string[] = []) => {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : ["# sandcastle-kit credentials, written by `sandcastle setup`. Keep this file private."];
  const kept = lines.filter((l) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(l);
    return !m || (!(m[1] in set) && !drop.includes(m[1]) && m[2].trim() !== "");
  });
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const text = [...kept, ...Object.entries(set).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n";
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // mode above applies only when the file is created
};

const openUrl = (url: string) => {
  const opener = platform() === "darwin" ? "open" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore" });
};

export const setup = async (repoRoot?: string) => {
  if (!stdin.isTTY) {
    console.log("`sandcastle setup` asks for tokens, so it needs a terminal. Run it in your own terminal, or follow docs/INSTALL.md by hand.");
    process.exit(1);
  }
  console.log(`sandcastle-kit setup - kit at ${KIT}\n`);

  // 1. The command and the skill.
  const binDir = join(homedir(), ".local/bin");
  await link(join(KIT, "bin/sandcastle"), join(binDir, "sandcastle"), "`sandcastle` command");
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    const shell = basename(process.env.SHELL ?? "");
    const line = shell === "fish" ? "fish_add_path ~/.local/bin" : `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.${shell === "bash" ? "bashrc" : "zshrc"}`;
    console.log(`     ~/.local/bin is not on your PATH. Add it, then open a new terminal:\n       ${line}`);
  }
  await link(join(KIT, "skill"), join(homedir(), ".claude/skills/sandcastle"), "skill for Claude Code (and OpenCode)");
  // OpenCode reads both skill folders, so the Codex link is made only for
  // Codex users - otherwise OpenCode would see the skill twice.
  const codexSkill = join(homedir(), ".agents/skills/sandcastle");
  if (real(codexSkill) === real(join(KIT, "skill"))) console.log("ok   skill for Codex");
  else if (has("codex") && (await yes("Codex is installed. Link the skill for Codex too ($sandcastle)?", true))) {
    await link(join(KIT, "skill"), codexSkill, "skill for Codex");
  }

  // 2. Credentials.
  mkdirSync(USER_CONFIG, { recursive: true, mode: 0o700 });
  const envFile = join(USER_CONFIG, ".env");
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const set: Record<string, string> = {};

  const drop: string[] = [];

  const claudeFlow = async () => {
    if (await yes("\nUse your Claude subscription for the agents? (No = an Anthropic API key, billed per token)", true)) {
      if (!has("claude")) console.log("     Claude Code is not installed here. Install it (https://claude.com/claude-code), or run `claude setup-token` on any machine that has it.");
      else if (await yes("Run `claude setup-token` now? It opens your browser, then prints a long-lived token.", true)) spawnSync("claude", ["setup-token"], { stdio: "inherit" });
      const t = await secret("Paste the token (sk-ant-oat...), or press Enter to skip: ");
      if (t.startsWith("sk-ant-")) {
        set.CLAUDE_CODE_OAUTH_TOKEN = t;
        drop.push("ANTHROPIC_API_KEY");
      } else if (t) console.log("     That does not look like a Claude token (sk-ant-...); not saved.");
    } else {
      const t = await secret("Paste the API key (sk-ant-api...), or press Enter to skip: ");
      if (t.startsWith("sk-ant-")) {
        set.ANTHROPIC_API_KEY = t;
        drop.push("CLAUDE_CODE_OAUTH_TOKEN");
      } else if (t) console.log("     That does not look like an Anthropic API key (sk-ant-...); not saved.");
    }
  };
  const claudeKey = env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : undefined;
  if (claudeKey) {
    console.log(`ok   Claude credential already set (${claudeKey})`);
    if (await yes("     Replace it?", false)) await claudeFlow();
  } else await claudeFlow();

  // A saved token is checked live too: a revoked or expired one would otherwise
  // pass here and only fail when an agent first calls GitHub. No answer at all
  // (offline, or a proxy Node's fetch ignores) proves nothing about the token.
  let saved = false;
  if (env.GH_TOKEN?.startsWith("github_pat_")) {
    const probe = await probeGithubToken(env.GH_TOKEN);
    if (!probe) {
      saved = true;
      console.log("ok   GitHub token already set (not checked: no connection)");
    } else if (probe.ok) {
      saved = true;
      console.log(`ok   GitHub token already set (${probe.login})`);
    } else if (probe.status >= 400 && probe.status < 500) {
      console.log(`     GitHub rejects the saved token (HTTP ${probe.status}).`);
    } else {
      saved = true;
      console.log(`ok   GitHub token already set (not checked: HTTP ${probe.status})`);
    }
  }
  const githubFlow = async () => {
    const login = run("gh", ["api", "user", "--jq", ".login"]);
    const url = new URL("https://github.com/settings/personal-access-tokens/new");
    url.search = new URLSearchParams({
      name: "sandcastle-kit",
      description: "sandcastle-kit agents: read and comment on GitHub issues",
      ...(login ? { target_name: login } : {}),
      issues: "write",
      metadata: "read",
    }).toString();
    console.log(
      "\nThe agents need a fine-grained GitHub token that can only read and comment on GitHub issues." +
        "\nThe page below comes pre-filled (Issues: read and write, Metadata: read). On it:" +
        "\n  - Resource owner: whoever owns the repos you will run (you, or an organisation)" +
        "\n  - Repository access: Only select repositories -> pick those repos" +
        `\n  ${url}`,
    );
    if (await yes("Open it in your browser?", true)) openUrl(url.toString());
    const t = await secret("Paste the token (github_pat_...), or press Enter to skip: ");
    if (t && !t.startsWith("github_pat_")) {
      console.log("     Only fine-grained tokens (github_pat_...) are accepted: a classic or `gh auth token` token could push or edit workflows. Not saved.");
    } else if (t) {
      const res = await probeGithubToken(t);
      if (res?.ok) {
        set.GH_TOKEN = t;
        console.log(`     GitHub accepts the token (${res.login}).`);
      } else {
        console.log(`     GitHub rejected the token (${res ? `HTTP ${res.status}` : "no connection"}); not saved.`);
      }
    }
  };
  if (!saved) await githubFlow();
  else if (await yes("     Replace it?", false)) await githubFlow();

  if (Object.keys(set).length || existsSync(envFile)) {
    writeEnv(envFile, set, drop);
    if (Object.keys(set).length) console.log(`done credentials saved to ${envFile}`);
  }

  // 3. Inside Herdr, the kit's plugin: recommended, so Enter says yes. It edits Herdr's own
  // config, so `configure` shows what it adds before asking; a config that already sets the
  // same things is reported, not touched, and setup goes on.
  if (process.env.HERDR_ENV === "1") {
    const plugin = pluginState();
    if (!plugin.linkedHere || !plugin.block) {
      console.log("\nInside Herdr, the kit's plugin adds the status view and report over any tab, Ctrl-click on a ticket for its log, and run progress in the sidebar.");
      try {
        await configure(false, false, true);
      } catch (error) {
        if (!(error instanceof OperatorError)) throw error;
        console.log(`     ${error.message}`);
      }
    }
  }

  // 4. Everything else - Docker, gh, git - is doctor's to check and explain.
  console.log("\nChecking the whole setup:\n");
  await doctor(repoRoot);
};
