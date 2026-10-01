// `sandcastle doctor` - one line per requirement, ok or the exact fix. Written
// to be read by a person or by a coding agent helping them set up.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { parseEnv } from "node:util";
import { linearKey } from "./blockers.ts";
import { CONFIG_PATH, loadProject } from "./config.ts";
import { limit } from "./pool.ts";
import { KIT, USER_CONFIG } from "./sandbox.ts";
import { probeOAuth } from "./usage.ts";

export const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
};

// Asks GitHub who a token belongs to. Undefined means no answer at all (fetch
// rejected), which is not the same as a rejection.
export const probeGithubToken = async (token: string): Promise<{ ok: boolean; status: number; login: string } | undefined> => {
  const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "sandcastle-kit" }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!res) return undefined;
  const login = res.ok ? ((await res.json().catch(() => ({}))) as { login?: string }).login ?? "unknown" : "";
  return { ok: res.ok, status: res.status, login };
};

/** The HTTP status Anthropic's model list gives an API key (401 for a bad one), undefined when there was no answer. Listing models is free: no model call, no tokens spent. */
export const probeApiKey = async (key: string): Promise<number | undefined> => {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  return res?.status;
};

/** `<KEY> from <file>, <prefix>..., <n> chars, file written <N> day(s) ago` - never a character of the value past the known prefix. */
export const fingerprint = (key: string, value: string, file: string, mtimeMs: number, now = Date.now()) => {
  const prefix = value.match(/^(sk-ant-[a-z]+\d*-|github_pat_)/)?.[0];
  const home = homedir();
  const shown = file === home || file.startsWith(home + sep) ? "~" + file.slice(home.length) : file;
  const days = Math.max(0, Math.floor((now - mtimeMs) / 86_400_000));
  return `${key} from ${shown}, ${prefix ? `${prefix}...` : "unknown prefix"}, ${value.length} chars, file written ${days} day${days === 1 ? "" : "s"} ago`;
};

/**
 * What an HTTP status says about a token. Only 401 is a plain no. A 403 is not: GitHub answers
 * its rate limit with one, and Anthropic's usage endpoint can answer a working token that lacks a
 * scope it wants - telling the user to replace a good token is the false alarm this must not raise.
 * Anything else (429, 5xx, no connection, a proxy Node's fetch ignores) proves nothing either.
 */
export const verdict = (status: number | undefined): "ok" | "rejected" | "not checked" =>
  status !== undefined && status >= 200 && status < 300 ? "ok" : status === 401 ? "rejected" : "not checked";

/**
 * A warning when the host's Claude Code is newer than the pin in docker/base.Dockerfile, else
 * undefined (also when either version cannot be read). Compared part by part as numbers: 2.1.1000
 * is newer than 2.1.285, which a string comparison gets wrong.
 */
export const claudePinWarning = (dockerfile: string, hostVersion: string | undefined): string | undefined => {
  const pin = dockerfile.match(/^ARG CLAUDE_CODE_VERSION=(\d+(?:\.\d+)*)\s*$/m)?.[1];
  const host = hostVersion?.match(/\d+\.\d+\.\d+/)?.[0];
  if (!pin || !host) return undefined;
  const a = host.split(".").map(Number);
  const b = pin.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? `Claude Code here is ${host}, newer than the sandbox image's pin ${pin} (docker/base.Dockerfile)` : undefined;
  }
  return undefined;
};

export const doctor = async (repoRoot?: string, verify = false) => {
  let bad = 0;
  const check = (ok: boolean, label: string, fix: string, optional = false) => {
    if (!ok && !optional) bad++;
    console.log(`${ok ? "ok  " : optional ? "opt " : "FIX "} ${label}${ok ? "" : `\n       -> ${fix}`}`);
  };

  console.log(`sandcastle-kit at ${KIT}\n`);
  // Whether this project's tickets are GitHub Issues decides what GitHub access is required.
  const project =
    repoRoot && existsSync(join(repoRoot, CONFIG_PATH)) && realpathSync(repoRoot) !== realpathSync(KIT)
      ? await loadProject(repoRoot).catch(() => undefined)
      : undefined;
  const needsGh = project?.tracker.kind !== "files";
  const node = Number(process.versions.node.split(".")[0]);
  check(node >= 22, `Node ${process.versions.node}`, "Install Node 22 or newer (24 LTS recommended).");
  check(existsSync(join(KIT, "node_modules/@ai-hero/sandcastle")), "kit dependencies installed", `cd ${KIT} && pnpm install`);
  check(!!run("docker", ["info", "--format", "{{.ServerVersion}}"]), "Docker running", "Start your container runtime (OrbStack, Podman machine, Docker Desktop or the Docker daemon) - `docker info` must work in this shell.");
  check(!!run("gh", ["auth", "status"]), "GitHub CLI signed in on this machine" + (needsGh ? "" : " (not needed: this project keeps tickets in files)"), "gh auth login", !needsGh);
  check(!!run("git", ["--version"]), "git", "Install git 2.31 or newer.");
  check(!!run("jq", ["--version"]), "jq (status view)", "Install jq: apt install jq, dnf install jq, or brew install jq.");

  const onPath = run("sh", ["-c", "command -v sandcastle"]);
  const linked = (() => {
    try {
      return !!onPath && realpathSync(onPath) === realpathSync(join(KIT, "bin/sandcastle"));
    } catch {
      return false;
    }
  })();
  check(linked, "`sandcastle` on PATH points at this kit", `sandcastle setup   (or: ln -sf ${join(KIT, "bin/sandcastle")} ~/.local/bin/sandcastle, and put ~/.local/bin on PATH)`);

  const skill = join(homedir(), ".claude/skills/sandcastle");
  const skillOk = (() => {
    try {
      return realpathSync(skill) === realpathSync(join(KIT, "skill"));
    } catch {
      return false;
    }
  })();
  check(skillOk, "Claude Code skill /sandcastle installed", `ln -sfn ${join(KIT, "skill")} ~/.claude/skills/sandcastle`, true);

  // pool.ts reads the machine settings on first use, so a malformed file or a
  // bad limit lands here as a FIX line instead of crashing every command.
  const settingsProblem = (() => {
    try {
      limit("sandboxes");
      limit("gates");
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  })();
  check(!settingsProblem, `machine-wide settings (${join(USER_CONFIG, "config.json")}, SANDCASTLE_MAX_*)`, `${settingsProblem} Fix or delete it.`);

  const envFile = join(USER_CONFIG, ".env");
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  check(existsSync(envFile), `credentials file ${envFile}`, "sandcastle setup   (or see docs/INSTALL.md to write it by hand)");
  // A run refuses empty values, so catch them here rather than hours later.
  const empty = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (empty.length) check(false, "no empty keys in the credentials file", `Delete the empty line(s) for ${empty.join(", ")}, or run sandcastle setup.`);
  check(!!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY), "Claude credential set (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)", "sandcastle setup   (or run `claude setup-token` and put the token in the credentials file)");
  check(!!env.GH_TOKEN?.startsWith("github_pat_"), "GH_TOKEN is a fine-grained token (github_pat_)" + (needsGh ? "" : " (not needed: this project keeps tickets in files)"), "sandcastle setup   (or create one at https://github.com/settings/personal-access-tokens/new - only the repos you run, Issues read/write, Metadata read)", !needsGh);
  if (verify) {
    // The project's file overrides the shared one key by key, as credentials() in sandbox.ts does.
    const inProject = !!repoRoot && realpathSync(repoRoot) !== realpathSync(KIT);
    const files = [envFile, ...(inProject ? [join(repoRoot, ".sandcastle/.env")] : [])];
    const source = (key: string) => {
      let found: { value: string; file: string } | undefined;
      for (const file of files) {
        const value = existsSync(file) ? parseEnv(readFileSync(file, "utf8"))[key] : undefined;
        if (value) found = { value, file };
      }
      return found;
    };
    console.log("\ncredentials (live)");
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GH_TOKEN"]) {
      const found = source(key);
      if (!found) continue;
      const print = fingerprint(key, found.value, found.file, statSync(found.file).mtimeMs);
      const gh = key === "GH_TOKEN" ? await probeGithubToken(found.value) : undefined;
      const status = key === "GH_TOKEN" ? gh?.status : key === "ANTHROPIC_API_KEY" ? await probeApiKey(found.value) : await probeOAuth(found.value);
      const seen = verdict(status);
      if (seen === "ok") console.log(`ok   ${print} - accepted${gh?.login ? ` (${gh.login})` : ""}`);
      else if (seen === "rejected") check(false, `${print} - rejected (HTTP ${status})`, `Make a new token and replace it in ${found.file}: \`sandcastle setup\``);
      else console.log(`opt  ${print} - not checked (${status === undefined ? "no connection" : `HTTP ${status}`})`);
    }
    console.log();
  }
  check(!!run("sh", ["-c", "command -v codex"]), "Codex CLI (only for CROSS_REVIEW=1)", "npm install -g @openai/codex && codex login", true);
  // A warning, never a FIX: host and sandbox need not match, so it does not touch `bad`.
  const pinWarning = (() => {
    try {
      return claudePinWarning(readFileSync(join(KIT, "docker/base.Dockerfile"), "utf8"), run("claude", ["--version"]));
    } catch {
      return undefined;
    }
  })();
  if (pinWarning) console.log(`warn ${pinWarning}\n       -> Fine while runs work: host and sandbox need not match. If preflight says a model needs a newer Claude Code, update the kit (/sandcastle update), or raise CLAUDE_CODE_VERSION in docker/base.Dockerfile, then \`sandcastle build\`.`);
  check(process.env.HERDR_ENV === "1", "Herdr (optional: opens the status pane automatically)", "Without it, run `sandcastle status` in a second terminal.", true);

  // The kit's own clone is not a project; checking it would print a false FIX.
  if (repoRoot && realpathSync(repoRoot) !== realpathSync(KIT)) {
    console.log(`\nproject ${repoRoot}`);
    const hasConfig = existsSync(join(repoRoot, CONFIG_PATH));
    check(hasConfig, CONFIG_PATH, "sandcastle init   (then fill in gates, setup and lean - see the kit README)");
    if (project) {
      const t = project.tracker;
      check(!t.note, `issue tracker: ${t.kind} (${t.source === "config" ? "config.ts" : t.source === "docs/agents" ? "docs/agents/issue-tracker.md" : "default"}), queue "${project.label}"`, t.note ?? "", true);
    }
    if (project?.blockers?.linear?.length) {
      check(!!linearKey(), `LINEAR_API_KEY set (blockers.linear: ${project.blockers.linear.join(", ")})`, "Put a Linear personal API key (read-only) as LINEAR_API_KEY in the credentials file. It stays on the host; without it a Linear blocker counts as open.");
    }
    const projectEnv = join(repoRoot, ".sandcastle/.env");
    if (existsSync(projectEnv)) {
      const p = parseEnv(readFileSync(projectEnv, "utf8"));
      if (p.LINEAR_API_KEY) check(false, ".sandcastle/.env holds LINEAR_API_KEY", "Sandcastle would forward it into every sandbox. Move it to the credentials file in ~/.config/sandcastle-kit/.env.");
      if (p.GH_TOKEN) check(p.GH_TOKEN.startsWith("github_pat_"), ".sandcastle/.env GH_TOKEN is fine-grained (it overrides the shared one)", "Replace it with a fine-grained token, or delete the line to use the shared one.");
    }
    const ignored = run("git", ["-C", repoRoot, "check-ignore", "-q", ".sandcastle/logs/x"]) !== undefined;
    if (hasConfig) check(ignored, ".sandcastle/logs is gitignored", "Run `sandcastle init` again or add logs/, worktrees/, .run/, .env to .sandcastle/.gitignore");
  } else {
    console.log("\n(not inside a project - run doctor again from one to check it too)");
  }

  console.log(bad ? `\n${bad} thing(s) to fix.` : "\nAll required checks pass.");
};
