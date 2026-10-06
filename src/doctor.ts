// `sandcastle doctor` - one line per requirement, ok or the exact fix. Written
// to be read by a person or by a coding agent helping them set up.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { parseEnv } from "node:util";
import { doctorApiKeyLine, red } from "./api-key.ts";
import { linearKey } from "./blockers.ts";
import { CONFIG_PATH, loadProject } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { clickHintLine, herdrSettingProblem, resolveClickHint } from "./click-hint.ts";
import { pluginState } from "./herdr-plugin.ts";
import { SANDCASTLE_IGNORES } from "./init.ts";
import { limit } from "./pool.ts";
import { poolWarningsNow, sizePointerNow } from "./size.ts";
import { apiKeySpend, baseImage, KIT, machineSettings, USER_CONFIG } from "./sandbox.ts";
import { kitVersion, upgradeLines } from "./upgrading.ts";
import { loginLocation, probeOAuth, usageToken, usageWhose } from "./usage.ts";
import { runtimeProblemNow } from "./runtime.ts";
import { resolveVersions } from "./versions.ts";

export const run = (cmd: string, args: string[], cwd?: string, timeout?: number) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd, timeout }).trim();
  } catch {
    return undefined;
  }
};

/**
 * Doctor's build-cache line, or undefined when Docker is down or slow. `docker system df` sizes every
 * container's files, and with a busy container (a test suite in one) it took over a minute: an info
 * line is not worth holding doctor for, so it gets a few seconds.
 */
export const buildCacheLine = (timeout = 5000) => buildCacheNote(run("docker", ["system", "df", "--format", "{{json .}}"], undefined, timeout) ?? "");

/** The first Claude Code that loads mods (plugins whose hooks run inside it). */
const MOD_MIN = [2, 1, 287];

/** The Claude Code on PATH and whether it is new enough to load the kit's mod; undefined with none. */
export const claudeCode = (): { version: string; mods: boolean } | undefined => {
  const v = run("claude", ["--version"])?.match(/(\d+)\.(\d+)\.(\d+)/);
  return v ? { version: v[0], mods: MOD_MIN.reduce((d, min, i) => d || Number(v[i + 1]) - min, 0) >= 0 } : undefined;
};

/**
 * Claude Code's own words when it would load no mod here ("turned off in this process: ..."),
 * or undefined when it would: a setting, an organisation's policy, or a switch on Claude
 * Code's side that nothing on the machine turns back on. `claude plugin test` in a folder
 * with no mod is how it says which.
 */
const modsOff = (): string | undefined => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-mods-"));
  // Removed once asked: every doctor run left one empty directory in the temp directory.
  const r = spawnSync("claude", ["plugin", "test"], { cwd, encoding: "utf8" });
  rmSync(cwd, { recursive: true, force: true });
  return `${r.stdout}${r.stderr}`.match(/hooks modules are (turned off[^\n]*)/)?.[1].replace(/, and a plugin's tests run only while it is on$/, "");
};

/** A path or label put into a command a person pastes: quoted only when it has to be, so a path with a space still runs. */
export const shellQuote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The fix for a missing or incomplete .sandcastle/.gitignore: a command that appends what init
 * would write. `sandcastle init` cannot be rerun for it - it refuses once a config exists.
 */
export const gitignoreFix = (root: string): string => {
  const file = join(root, ".sandcastle/.gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = text.split("\n");
  const missing = SANDCASTLE_IGNORES.filter((w) => !have.includes(w));
  if (!missing.length) return ".sandcastle/.gitignore lists them all, but another ignore rule un-ignores logs/: `git check-ignore -v .sandcastle/logs/x` names it.";
  // A last line with no newline would swallow the first entry (".env" becoming ".envlogs/"
  // un-ignores the credentials), so an empty first argument ends that line first.
  const entries = text && !text.endsWith("\n") ? ["''", ...missing] : missing;
  return `\`printf '%s\\n' ${entries.join(" ")} >> ${shellQuote(file)}\``;
};

/**
 * Whether the queue label exists on GitHub, asked of `gh` from inside the project (so it picks the
 * project's remote). Anything but a clear answer is "not checked": gh missing, signed out, no
 * remote and no network all look alike, and none of them says the label is absent.
 */
export const queueLabel = (root: string, label: string): { state: "ok" | "missing" | "not checked"; fix: string } => {
  const out = run("gh", ["label", "list", "--search", label, "--limit", "100", "--json", "name"], root);
  const fix = `\`gh label create ${shellQuote(label)} --description 'Queued for a Sandcastle agent run'\``;
  if (out === undefined) return { state: "not checked", fix };
  let names: unknown;
  try {
    // `gh label list --search` prints nothing at all, not `[]`, when no label matches.
    names = JSON.parse(out || "[]");
  } catch {
    return { state: "not checked", fix };
  }
  if (!Array.isArray(names)) return { state: "not checked", fix };
  // GitHub label names are case-insensitive.
  const found = names.some((n) => typeof n?.name === "string" && n.name.toLowerCase() === label.toLowerCase());
  return { state: found ? "ok" : "missing", fix };
};

// Asks GitHub who a token belongs to. Undefined means no answer at all (fetch
// rejected), which is not the same as a rejection.
export const probeGithubToken = async (token: string): Promise<{ ok: boolean; status: number; login: string } | undefined> => {
  const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "sandcastle-kit" }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!res) return undefined;
  const login = res.ok ? ((await res.json().catch(() => ({}))) as { login?: string }).login ?? "unknown" : "";
  return { ok: res.ok, status: res.status, login };
};

/**
 * Whether a token can write a repository's code, without writing anything: creating a branch at a
 * commit that cannot exist is refused with 403 when the token lacks Contents: write, and with 422
 * (no such object) when it has it. The sandbox's token is meant to do nothing worse than comment.
 */
export const probeGithubWrite = async (token: string, repo: string): Promise<number | undefined> => {
  const res = await fetch(`${process.env.SANDCASTLE_TEST_GITHUB_API || "https://api.github.com"}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "sandcastle-kit", "content-type": "application/json" },
    body: JSON.stringify({ ref: "refs/heads/sandcastle-doctor-probe-never-created", sha: "0".repeat(40) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  return res?.status;
};

/** The HTTP status Anthropic's model list gives an API key (401 for a bad one), undefined when there was no answer. Listing models is free: no model call, no tokens spent. */
/** Whether GitHub's API answers at all, signed in or not. SANDCASTLE_TEST_GITHUB_API points it elsewhere in tests. */
const githubReachable = async () =>
  !!(await fetch(process.env.SANDCASTLE_TEST_GITHUB_API || "https://api.github.com", { method: "HEAD", signal: AbortSignal.timeout(5_000) }).catch(() => undefined));

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

const STALE_IMAGE_DAYS = 30;

/**
 * A warning when the base image (`docker image inspect` `.Created`, RFC 3339) is more than 30 days old,
 * else undefined - also for a date that does not parse, so a changed format stays silent.
 */
export const staleImageWarning = (created: string, now: Date, tag = "sandcastle-base"): string | undefined => {
  const at = Date.parse(created.trim());
  if (Number.isNaN(at)) return undefined;
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  if (days <= STALE_IMAGE_DAYS) return undefined;
  return `base image ${tag} was built ${days} days ago - \`sandcastle build --force\` pulls Debian and Node security updates`;
};

/**
 * The info line for Docker's build cache, from `docker system df --format '{{json .}}'` (one JSON object
 * per line): its size, how much of it is reclaimable and the command that frees it. Builds pile up here
 * over days of runs (tens of GB) and nothing else prunes it. Undefined for output without a build-cache
 * row, so a changed format stays silent.
 */
export const buildCacheNote = (df: string): string | undefined => {
  for (const line of df.split("\n")) {
    try {
      const row = JSON.parse(line) as { Type?: unknown; Size?: unknown; Reclaimable?: unknown };
      if (row.Type !== "Build Cache" || typeof row.Size !== "string") continue;
      const reclaimable = typeof row.Reclaimable === "string" && row.Reclaimable ? ` (${row.Reclaimable} reclaimable)` : "";
      return `Docker build cache is ${row.Size}${reclaimable} - \`docker builder prune\` frees it`;
    } catch {
      /* not a row */
    }
  }
  return undefined;
};

/** Whether a directory is a checkout of the kit: its package name is the kit's, or it has the kit's entry script. */
export const isKitCheckout = (dir: string) => {
  try {
    if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "sandcastle-kit") return true;
  } catch {
    // No package.json, or one that does not parse: fall through to the entry script.
  }
  return existsSync(join(dir, "bin/sandcastle"));
};

/**
 * An info line when the project is another checkout of the kit than the running one: a bare
 * `sandcastle` runs the running kit's code, so a change in the project's checkout looks unapplied.
 * Undefined for any other project.
 */
export const otherKitCheckoutNote = (repoRoot: string, kit = KIT) => {
  if (!isKitCheckout(repoRoot)) return undefined;
  const here = realpathSync(repoRoot);
  const running = realpathSync(kit);
  if (here === running) return undefined;
  return `info This project is a different checkout of the kit (${here}) than the one running (${running}): \`sandcastle ...\` runs the other one; \`./bin/sandcastle\` runs this checkout.`;
};

/** The kit checkout a `sandcastle` on PATH resolves to (the parent of its bin/), or undefined for none or a non-kit. */
export const kitCheckoutOnPath = (onPath: string | undefined) => {
  if (!onPath) return undefined;
  try {
    const root = dirname(dirname(realpathSync(onPath)));
    // isKitCheckout alone would accept any script named bin/sandcastle, as it exists by construction here.
    return isKitCheckout(root) && existsSync(join(root, "src/cli.ts")) ? root : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether doctor checks `repoRoot` as a project. The kit's own checkout counts when it has a
 * project config (the kit burns down its own issues); only a bare kit clone is not a project, as
 * checking it would print a false FIX for the missing config.
 */
export const isProjectRoot = (repoRoot: string | undefined, kit = KIT): repoRoot is string =>
  !!repoRoot && (existsSync(join(repoRoot, CONFIG_PATH)) || realpathSync(repoRoot) !== realpathSync(kit));

/**
 * `pointToSize` is false for `sandcastle setup`, which runs doctor and prints the pointer itself
 * after it, so the line is not said twice.
 */
export const doctor = async (repoRoot?: string, verify = false, pointToSize = true) => {
  let bad = 0;
  const check = (ok: boolean, label: string, fix: string, optional = false) => {
    if (!ok && !optional) bad++;
    console.log(`${ok ? "ok  " : optional ? "opt " : "FIX "} ${label}${ok ? "" : `\n       -> ${fix}`}`);
  };
  // A credentials file written by hand (or copied) keeps the umask's 644: any local user reads the tokens.
  const privateFile = (file: string) => {
    if (!existsSync(file)) return;
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) check(false, `${file} is readable only by you (mode ${mode.toString(8)})`, `\`chmod 600 ${shellQuote(file)}\``);
  };

  console.log(`sandcastle-kit ${kitVersion()} at ${KIT}\n`);
  // Whether this project's tickets are GitHub Issues decides what GitHub access is required.
  const project =
    repoRoot && existsSync(join(repoRoot, CONFIG_PATH))
      ? await loadProject(repoRoot).catch(() => undefined)
      : undefined;
  const needsGh = project?.tracker.kind !== "files";
  // The commands that install things differ: Homebrew and `open -a` on macOS, the distribution's tools elsewhere.
  const mac = process.platform === "darwin";
  const node = Number(process.versions.node.split(".")[0]);
  check(node >= 22, `Node ${process.versions.node}`, `Install Node 22 or newer (24 LTS recommended): \`nvm install 24\`, \`mise use -g node@24\` or ${mac ? "`brew install node`" : "your distribution's package"}`);
  check(existsSync(join(KIT, "node_modules/@ai-hero/sandcastle")), "kit dependencies installed", `\`pnpm -C ${shellQuote(KIT)} install\``);
  // Not installed and not started need different fixes: "start OrbStack" to someone with no runtime sent them looking for an app they never had.
  const dockerInstalled = run("docker", ["--version"]) !== undefined;
  // The exit status alone: a `--format` field Podman lacks failed there, calling Podman "not running".
  const dockerRunning = run("docker", ["info"], undefined, 30_000) !== undefined;
  check(
    dockerRunning,
    dockerInstalled ? "Docker running" : "Docker installed",
    !dockerInstalled
      ? mac
        ? "Install a container runtime that provides `docker`: OrbStack (`brew install --cask orbstack`), Podman or Docker Desktop - see docs/INSTALL.md."
        : "Install Docker Engine (https://docs.docker.com/engine/install/) - see docs/INSTALL.md."
      : mac
      ? "Start your container runtime: `open -a OrbStack`, `open -a Docker` or `podman machine start` - then `docker info` must work in this shell."
      : "Start the Docker daemon: `sudo systemctl start docker` - then `docker info` must work in this shell.",
  );
  let runtime: ReturnType<typeof runtimeProblemNow>;
  try {
    runtime = runtimeProblemNow();
  } catch (error) {
    // A docker that does not answer in time is the `Docker running` line's to report; here it is no problem found, not a crash.
    if (!(error instanceof OperatorError)) throw error;
  }
  if (runtime) check(false, runtime.label, runtime.fix);
  const ghInstalled = run("gh", ["--version"]) !== undefined;
  const ghSignedIn = !!run("gh", ["auth", "status"]);
  // Offline, `gh auth status` calls a good token invalid; `gh auth login` would not help.
  const githubDown = ghInstalled && !ghSignedIn && !(await githubReachable());
  check(
    ghSignedIn,
    (githubDown ? "GitHub reachable (gh's sign-in could not be checked)" : ghInstalled ? "GitHub CLI signed in on this machine" : "GitHub CLI installed") +
      (needsGh ? "" : " (not needed: this project keeps tickets in files)"),
    githubDown
      ? "Check the network (or proxy) - api.github.com did not answer - then `sandcastle doctor` again."
      : ghInstalled ? "`gh auth login`" : mac ? "`brew install gh`, then `gh auth login`" : "Install it (https://cli.github.com), then `gh auth login`",
    !needsGh,
  );
  // Worktree commands the kit relies on need 2.31; an older git failed mid-run, not here.
  const gitVersion = run("git", ["--version"])?.match(/(\d+)\.(\d+)/);
  const gitOk = !!gitVersion && (Number(gitVersion[1]) > 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) >= 31));
  check(gitOk, gitVersion ? `git ${gitVersion[0]} (2.31 or newer)` : "git", mac ? "Install git 2.31 or newer: `xcode-select --install` or `brew install git`." : "Install git 2.31 or newer: `sudo apt install git` or `sudo dnf install git`.");
  // The operator is the author of the kit's merges and ticket commits. Without an identity git
  // refuses them at landing (after the run has spent its tokens) or signs them with a guessed
  // name and a hostname address.
  const identity = ["user.name", "user.email"].filter((k) => !run("git", ["config", k], repoRoot));
  check(!identity.length, "git identity (user.name, user.email)", identity.map((k) => `\`git config --global ${k} ${k === "user.name" ? '"Your Name"' : "you@example.com"}\``).join(", then "));
  check(!!run("jq", ["--version"]), "jq (status view)", mac ? "`brew install jq`" : "Install jq: `sudo apt install jq` or `sudo dnf install jq`.");
  // The status view trusts a run's pid only with its command (`ps -p <pid> -o command=`): a bare pid
  // may be some other process by now. Slim Linux images ship no procps, and there every live run
  // read as ended. macOS always has a ps that takes these flags.
  if (!mac) check(!!run("ps", ["-p", String(process.pid), "-o", "command="]), "ps (status view)", "Install procps: `sudo apt install procps` or `sudo dnf install procps-ng`.");

  const onPath = run("sh", ["-c", "command -v sandcastle"]);
  const linked = (() => {
    try {
      return !!onPath && realpathSync(onPath) === realpathSync(join(KIT, "bin/sandcastle"));
    } catch {
      return false;
    }
  })();
  // With no `sandcastle` on PATH, "run `sandcastle setup`" cannot work: name the kit's own script.
  const bin = shellQuote(join(KIT, "bin/sandcastle"));
  const setup = linked ? "sandcastle setup" : `${bin} setup`;
  // Another kit checkout on PATH (the installed kit, while this one is a clone or worktree) is a
  // fact, not a fault: relinking PATH to a development checkout would hijack the installed kit.
  const pathKit = linked ? undefined : kitCheckoutOnPath(onPath);
  if (pathKit) console.log(`info \`sandcastle\` on PATH runs another kit checkout (${pathKit}), not this one (${realpathSync(KIT)}): \`./bin/sandcastle\` runs this checkout.`);
  else check(linked, "`sandcastle` on PATH points at this kit", `\`${bin} setup\` (or: \`mkdir -p ~/.local/bin && ln -sf ${bin} ~/.local/bin/sandcastle\`, and put ~/.local/bin on PATH)`);

  const skill = join(homedir(), ".claude/skills/sandcastle");
  const skillOk = (() => {
    try {
      return realpathSync(skill) === realpathSync(join(KIT, "skill"));
    } catch {
      return false;
    }
  })();
  check(skillOk, "Claude Code skill /sandcastle installed", `\`mkdir -p ~/.claude/skills && ln -sfn ${shellQuote(join(KIT, "skill"))} ~/.claude/skills/sandcastle\``, true);

  // The mod is Claude Code's alone, so with no `claude` here nothing is said about it. It is
  // offered, never linked silently: it runs inside Claude Code with the user's permissions.
  const claude = claudeCode();
  if (claude) {
    const mod = join(homedir(), ".claude/skills/sandcastle-mod");
    const linked = (() => {
      try {
        return realpathSync(mod) === realpathSync(join(KIT, "mod"));
      } catch {
        return false;
      }
    })();
    const off = linked && claude.mods ? modsOff() : undefined;
    check(
      linked && claude.mods && !off,
      "Claude Code mod (optional: a live run above the prompt, a notice when a ticket needs you, a prompt when the run ends)",
      !claude.mods
        ? `Needs Claude Code ${MOD_MIN.join(".")} or newer (this is ${claude.version}): \`claude update\`, then \`sandcastle doctor\` again.`
        : off
        ? `Linked, but Claude Code says mods are ${off}. Until they are on again nothing is drawn, and the skill waits for the run's end its own way.`
        : `\`ln -sfn ${shellQuote(join(KIT, "mod"))} ~/.claude/skills/sandcastle-mod\` - it runs inside Claude Code with your permissions; the README's "The Claude Code mod" says what it reads. \`rm ~/.claude/skills/sandcastle-mod\` takes it out.`,
      true,
    );
  }

  // pool.ts reads the machine settings on first use, so a malformed file or a
  // bad limit lands here as a FIX line instead of crashing every command.
  const settingsFile = join(USER_CONFIG, "config.json");
  const settingsProblem = (() => {
    try {
      // limit() skips the file when an environment variable sets the limit, so read it here too.
      machineSettings();
      limit("sandboxes");
      limit("gates");
      // The mod reads this one and never reports it, so a typo would leave the mark on without a word.
      const idleMark = machineSettings().idleMark;
      if (idleMark !== undefined && typeof idleMark !== "boolean") return `"idleMark" in ${settingsFile} is ${JSON.stringify(idleMark)}, not true or false.`;
      // The status view falls back on a bad value without a word, so this is the one place it is said.
      return herdrSettingProblem(machineSettings().herdr, settingsFile);
    } catch (error) {
      return (error as Error).message;
    }
  })();
  const settingsName = settingsProblem?.match(/^SANDCASTLE_MAX_\w+/)?.[0];
  check(
    !settingsProblem,
    // The path alone read as a file that is there: name the defaults when it is not.
    `machine-wide settings (${existsSync(settingsFile) ? settingsFile : `defaults: no ${settingsFile}`}, SANDCASTLE_MAX_*)`,
    `${settingsProblem} ` +
      (settingsName
        ? `Unset it (\`unset ${settingsName}\`) or set it to a whole number of 1 or more.`
        : settingsProblem?.startsWith('"idleMark"')
          ? `Set it to \`false\` to turn the Claude Code mod's idle mark off, or delete the line to show it.`
          : settingsProblem?.startsWith('"herdr')
          ? `Set it to \`{"clickHint": "auto"}\` (or "ctrl" or "cmd"), or delete it to sense the terminal.`
          : `Fix the file, or delete it to use the defaults: \`rm ${shellQuote(settingsFile)}\`.`),
  );

  const envFile = join(USER_CONFIG, ".env");
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  check(existsSync(envFile), `credentials file ${envFile}`, `\`${setup}\` (or see docs/INSTALL.md to write it by hand)`);
  privateFile(envFile);
  // A run refuses empty values, so catch them here rather than hours later.
  const empty = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (empty.length) check(false, "no empty keys in the credentials file", `Delete the empty line(s) for ${empty.join(", ")} from ${envFile}, or run \`${setup}\`, which drops them whenever it writes the file.`);
  check(!!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY), "Claude credential set (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)", `\`${setup}\` (or run \`claude setup-token\` and put the token in ${envFile} as CLAUDE_CODE_OAUTH_TOKEN=...)`);
  // Never silent: an API key bills API credits, beside an OAuth token too (Claude Code spends it first),
  // from either file - the project's as well as this one, merged key by key as a run merges them.
  const spend = apiKeySpend([envFile, ...(isProjectRoot(repoRoot) ? [join(repoRoot, ".sandcastle/.env")] : [])]);
  if (spend) console.log(red(doctorApiKeyLine(spend)));
  // A missing token and a classic one are different problems; "is a fine-grained token" said the second for both.
  check(!!env.GH_TOKEN?.startsWith("github_pat_"), (env.GH_TOKEN ? "GH_TOKEN is a fine-grained token (github_pat_), not a classic one" : "GH_TOKEN set (a fine-grained token, github_pat_)") + (needsGh ? "" : " (not needed: this project keeps tickets in files)"), `\`${setup}\` (or create one at https://github.com/settings/personal-access-tokens/new - only the repos you run, Issues read/write, Metadata read - and put it in ${envFile} as GH_TOKEN=...)`, !needsGh);
  if (verify) {
    // The project's file overrides the shared one key by key, as credentials() in sandbox.ts does.
    const inProject = isProjectRoot(repoRoot);
    const files = [envFile, ...(inProject ? [join(repoRoot, ".sandcastle/.env")] : [])];
    const source = (key: string) => {
      let found: { value: string; file: string } | undefined;
      for (const file of files) {
        const value = existsSync(file) ? parseEnv(readFileSync(file, "utf8"))[key] : undefined;
        if (value) found = { value, file };
      }
      return found;
    };
    // The guard's own credential, which may not be a file's: it prefers the host's Claude Code login.
    const guardCredential = usageToken({ CLAUDE_CODE_OAUTH_TOKEN: source("CLAUDE_CODE_OAUTH_TOKEN")?.value, ANTHROPIC_API_KEY: source("ANTHROPIC_API_KEY")?.value });
    console.log("\ncredentials (live)");
    // The OAuth token's answer, kept for the guard's line: the usage endpoint is rate-limited, and a
    // second ask for the same token can draw a 429 that reads as a problem.
    let oauthStatus: number | undefined;
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GH_TOKEN"]) {
      const found = source(key);
      if (!found) continue;
      const print = fingerprint(key, found.value, found.file, statSync(found.file).mtimeMs);
      const gh = key === "GH_TOKEN" ? await probeGithubToken(found.value) : undefined;
      const status = key === "GH_TOKEN" ? gh?.status : key === "ANTHROPIC_API_KEY" ? await probeApiKey(found.value) : await probeOAuth(found.value);
      if (key === "CLAUDE_CODE_OAUTH_TOKEN") oauthStatus = status;
      const seen = verdict(status);
      if (seen === "ok") console.log(`ok   ${print} - accepted${gh?.login ? ` (${gh.login})` : ""}`);
      // In a project: the sandboxes get this token, and a prompt-injected agent has it too.
      const repo = key === "GH_TOKEN" && seen === "ok" && inProject ? run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot) : undefined;
      if (repo) {
        const write = await probeGithubWrite(found.value, repo);
        if (write === 422) check(false, `GH_TOKEN cannot push to ${repo}`, `It has Contents: write there, so an agent misled by a ticket could push code. Edit the token on GitHub (Settings -> Developer settings -> Fine-grained tokens) to Issues: read and write and Metadata: read only.`);
        else if (write === 403 || write === 404) console.log(`ok   GH_TOKEN cannot push to ${repo} (no Contents: write)`);
        else console.log(`opt  GH_TOKEN push access to ${repo} - not checked (${write === undefined ? "no connection" : `HTTP ${write}`})`);
      }
      else if (seen === "rejected") check(false, `${print} - rejected (HTTP ${status})`, `Make a new token and replace it in ${found.file}: \`${setup}\``);
      else console.log(`opt  ${print} - not checked (${status === undefined ? "no connection" : `HTTP ${status}`})`);
      // Apart from whether the token is accepted: any 403 from the usage endpoint means the guard cannot read this token's plan usage
      // - unless the guard reads with the Claude Code login instead, which the line after the loop reports.
      if (key === "CLAUDE_CODE_OAUTH_TOKEN" && status === 403 && guardCredential?.source === "CLAUDE_CODE_OAUTH_TOKEN") console.log("warn USAGE_CHECK=1 cannot work with this token: the usage endpoint answered HTTP 403, so the guard would be off for a run.");
    }
    // Only the source and the HTTP status are printed, never a character of a token.
    const usage = guardCredential;
    if (usage?.source === "api key") console.log("info usage guard (USAGE_CHECK=1) does not apply: the sandboxes spend ANTHROPIC_API_KEY (API credits, no plan), so there is no plan usage to read");
    else if (usage && "token" in usage) {
      const status = usage.source === "login" || oauthStatus === undefined ? await probeOAuth(usage.token) : oauthStatus;
      console.log(`${status !== undefined && status >= 200 && status < 300 ? "ok  " : "warn"} usage guard (USAGE_CHECK=1) would read plan usage with ${usage.source === "login" ? "the Claude Code login" : "CLAUDE_CODE_OAUTH_TOKEN"} - the usage endpoint answered ${status === undefined ? "nothing (no connection)" : `HTTP ${status}`} - ${usageWhose(usage.source)} - login looked up in ${loginLocation()}`);
    } else if (usage) console.log(`warn usage guard (USAGE_CHECK=1) would find the Claude Code login expired, so it would have no reading until Claude Code refreshes it (any use of Claude Code does) - login read from ${loginLocation()}`);
    else console.log("info usage guard (USAGE_CHECK=1) has no credential: the sandboxes spend no subscription token (CLAUDE_CODE_OAUTH_TOKEN is not set)");
    console.log();
  }
  check(!!run("sh", ["-c", "command -v codex"]), "Codex CLI (only for CROSS_REVIEW=1)", "`npm install -g @openai/codex && codex login`", true);
  // Info, and a warning on a fallback: never a FIX, since a run works with either. Resolved quietly,
  // as the fallback gets its own `warn` line here.
  const versions = await resolveVersions(project ?? {}, undefined, () => {}).catch((error: Error) => {
    console.log(`warn ${error.message}`);
    return undefined;
  });
  if (versions) {
    console.log(`info Sandbox images get Claude Code ${versions.claude} (${versions.channel}) and Codex ${versions.codex}`);
    if (versions.source !== "network") {
      console.log(`warn Could not reach the release channel; using ${versions.source === "cache" ? "the cached" : "the Dockerfile's default"} versions.\n       -> Fine while runs work. If preflight says a model needs a newer Claude Code, check the network and run \`sandcastle build\`, or pin one with \`claudeCode: "x.y.z"\` in ${CONFIG_PATH}.`);
    }
  }
  // A warn when the measured anonymous memory says the pool's limits need more than the VM has (the
  // owner's choice: never a FIX, a run still starts), and then in place of the pointer. From
  // `memory.peak` or the assumed figures it stays info: page cache inflates the one, the other is a
  // guess, and `size` is only the better number.
  const poolWarns = poolWarningsNow();
  for (const line of poolWarns) console.log(`warn ${line}`);
  const pointer = pointToSize && !poolWarns.length ? sizePointerNow() : undefined;
  if (pointer) console.log(`info ${pointer}`);
  check(process.env.HERDR_ENV === "1", "Herdr (optional: opens the status pane automatically)", "Without it, run `sandcastle status` in a second terminal.", true);
  if (process.env.HERDR_ENV === "1") {
    const plugin = pluginState();
    check(
      plugin.linkedHere && plugin.block,
      "Herdr plugin and sidebar rows (optional: the status view and report over any tab, Ctrl-click logs, run progress in the sidebar)",
      plugin.linkedFrom && !plugin.linkedHere
        ? `Linked from another checkout (${plugin.linkedFrom}): \`sandcastle herdr configure\` here links this one.`
        : "`sandcastle herdr configure` (shows what it adds and asks first).",
      true,
    );
    if (plugin.linkedFrom) console.log(clickHintLine(resolveClickHint()));
  }

  // A bare kit clone (no project config) is not a project; checking it would print a false FIX.
  if (isProjectRoot(repoRoot)) {
    console.log(`\nproject ${repoRoot}`);
    const otherKit = otherKitCheckoutNote(repoRoot);
    if (otherKit) console.log(otherKit);
    const hasConfig = existsSync(join(repoRoot, CONFIG_PATH));
    check(hasConfig, CONFIG_PATH, "`sandcastle init` (then fill in gates, setup and lean - see the kit README)");
    // A warning, never a FIX: a pulled kit still runs, but a note may ask this project to act.
    if (hasConfig) for (const line of upgradeLines(repoRoot)) console.log(line);
    if (project) {
      const t = project.tracker;
      check(!t.note, `tracker: ${t.kind} (${t.source === "config" ? "config.ts" : t.source === "docs/agents" ? "docs/agents/issue-tracker.md" : "default"}), queue "${project.label}"`, t.note ?? "", true);
      // A github tracker in a repository with no GitHub remote has nothing to read: say it here,
      // not as gh's "no git remotes found" from the first run.
      // Any remote passes: gh also knows GitHub Enterprise hosts.
      const remote = t.kind === "github" && !!run("git", ["-C", repoRoot, "remote"]);
      if (t.kind === "github") check(remote, "a git remote on GitHub (the github tracker reads its issues)", `\`git remote add origin <the repository's GitHub URL>\`, or keep tickets in files: \`tracker: "files"\` in ${CONFIG_PATH}`);
      if (t.kind === "github" && remote) {
        const q = queueLabel(repoRoot, project.label);
        const what = `queue label "${project.label}" exists on GitHub`;
        if (q.state === "not checked") console.log(`opt  queue label "${project.label}" on GitHub - not checked (gh could not list labels)`);
        else check(q.state === "ok", what, q.fix);
      }
    }
    if (project?.blockers?.linear?.length) {
      check(!!linearKey(), `LINEAR_API_KEY set (blockers.linear: ${project.blockers.linear.join(", ")})`, `Add LINEAR_API_KEY=<a Linear personal API key, read-only> to ${envFile}. It stays on the host; without it a Linear blocker counts as open.`);
    }
    const projectEnv = join(repoRoot, ".sandcastle/.env");
    privateFile(projectEnv);
    if (existsSync(projectEnv)) {
      const p = parseEnv(readFileSync(projectEnv, "utf8"));
      if (p.LINEAR_API_KEY) check(false, ".sandcastle/.env holds LINEAR_API_KEY", `Move the LINEAR_API_KEY line from ${projectEnv} to ${envFile}: Sandcastle would forward it into every sandbox.`);
      if (p.GH_TOKEN) check(p.GH_TOKEN.startsWith("github_pat_"), ".sandcastle/.env GH_TOKEN is fine-grained (it overrides the shared one)", `Replace it in ${projectEnv} with a fine-grained token, or delete its GH_TOKEN line to use the shared one.`);
    }
    // A warning, never a FIX. Silent when Docker is down or the image is not built yet.
    const staleImage = (() => {
      try {
        if (!versions) return undefined;
        const tag = baseImage(versions).tag;
        const created = run("docker", ["image", "inspect", tag, "--format", "{{.Created}}"]);
        return created ? staleImageWarning(created, new Date(), tag) : undefined;
      } catch {
        return undefined;
      }
    })();
    if (staleImage) console.log(`warn ${staleImage}`);
    // Info, never a FIX. Silent when Docker is down.
    const cache = buildCacheLine();
    if (cache) console.log(`info ${cache}`);
    const ignored = run("git", ["-C", repoRoot, "check-ignore", "-q", ".sandcastle/logs/x"]) !== undefined;
    if (hasConfig) check(ignored, ".sandcastle/logs is gitignored", gitignoreFix(repoRoot));
    // Ignoring a file does not untrack it: a .env added before the ignore line (or with -f) is in
    // every clone and, once pushed, on the remote.
    const tracked = run("git", ["-C", repoRoot, "ls-files", "--error-unmatch", ".sandcastle/.env"]) !== undefined;
    if (tracked) {
      check(false, ".sandcastle/.env is committed", `\`git rm --cached .sandcastle/.env\` and commit, then rotate every token in it: its values stay in the git history, and on the remote if it was pushed.`);
    } else if (hasConfig && existsSync(join(repoRoot, ".sandcastle/.env"))) {
      check(run("git", ["-C", repoRoot, "check-ignore", "-q", ".sandcastle/.env"]) !== undefined, ".sandcastle/.env is gitignored", gitignoreFix(repoRoot));
    }
  } else {
    console.log("\n(not inside a project - run doctor again from one to check it too)");
  }

  console.log(bad ? `\n${bad} thing(s) to fix.` : "\nAll required checks pass.");
};
