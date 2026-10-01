// `sandcastle doctor` - one line per requirement, ok or the exact fix. Written
// to be read by a person or by a coding agent helping them set up.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { parseEnv } from "node:util";
import { linearKey } from "./blockers.ts";
import { CONFIG_PATH, loadProject } from "./config.ts";
import { SANDCASTLE_IGNORES } from "./init.ts";
import { limit } from "./pool.ts";
import { baseImage, KIT, USER_CONFIG } from "./sandbox.ts";
import { probeOAuth } from "./usage.ts";
import { resolveVersions } from "./versions.ts";

export const run = (cmd: string, args: string[], cwd?: string) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }).trim();
  } catch {
    return undefined;
  }
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

export const doctor = async (repoRoot?: string, verify = false) => {
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

  console.log(`sandcastle-kit at ${KIT}\n`);
  // Whether this project's tickets are GitHub Issues decides what GitHub access is required.
  const project =
    repoRoot && existsSync(join(repoRoot, CONFIG_PATH)) && realpathSync(repoRoot) !== realpathSync(KIT)
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
  check(
    !!run("docker", ["info", "--format", "{{.ServerVersion}}"]),
    dockerInstalled ? "Docker running" : "Docker installed",
    !dockerInstalled
      ? mac
        ? "Install a container runtime that provides `docker`: OrbStack (`brew install --cask orbstack`), Podman or Docker Desktop - see docs/INSTALL.md."
        : "Install Docker Engine (https://docs.docker.com/engine/install/) or Podman with `podman-docker` - see docs/INSTALL.md."
      : mac
      ? "Start your container runtime: `open -a OrbStack`, `open -a Docker` or `podman machine start` - then `docker info` must work in this shell."
      : "Start the Docker daemon: `sudo systemctl start docker` (or `podman machine start`) - then `docker info` must work in this shell.",
  );
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
  check(linked, "`sandcastle` on PATH points at this kit", `\`${bin} setup\` (or: \`mkdir -p ~/.local/bin && ln -sf ${bin} ~/.local/bin/sandcastle\`, and put ~/.local/bin on PATH)`);

  const skill = join(homedir(), ".claude/skills/sandcastle");
  const skillOk = (() => {
    try {
      return realpathSync(skill) === realpathSync(join(KIT, "skill"));
    } catch {
      return false;
    }
  })();
  check(skillOk, "Claude Code skill /sandcastle installed", `\`mkdir -p ~/.claude/skills && ln -sfn ${shellQuote(join(KIT, "skill"))} ~/.claude/skills/sandcastle\``, true);

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
  const settingsFile = join(USER_CONFIG, "config.json");
  const settingsName = settingsProblem?.match(/^SANDCASTLE_MAX_\w+/)?.[0];
  check(
    !settingsProblem,
    `machine-wide settings (${settingsFile}, SANDCASTLE_MAX_*)`,
    `${settingsProblem} ` +
      (settingsName
        ? `Unset it (\`unset ${settingsName}\`) or set it to a whole number of 1 or more.`
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
  // A missing token and a classic one are different problems; "is a fine-grained token" said the second for both.
  check(!!env.GH_TOKEN?.startsWith("github_pat_"), (env.GH_TOKEN ? "GH_TOKEN is a fine-grained token (github_pat_), not a classic one" : "GH_TOKEN set (a fine-grained token, github_pat_)") + (needsGh ? "" : " (not needed: this project keeps tickets in files)"), `\`${setup}\` (or create one at https://github.com/settings/personal-access-tokens/new - only the repos you run, Issues read/write, Metadata read - and put it in ${envFile} as GH_TOKEN=...)`, !needsGh);
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
    }
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
  check(process.env.HERDR_ENV === "1", "Herdr (optional: opens the status pane automatically)", "Without it, run `sandcastle status` in a second terminal.", true);

  // The kit's own clone is not a project; checking it would print a false FIX.
  if (repoRoot && realpathSync(repoRoot) !== realpathSync(KIT)) {
    console.log(`\nproject ${repoRoot}`);
    const hasConfig = existsSync(join(repoRoot, CONFIG_PATH));
    check(hasConfig, CONFIG_PATH, "`sandcastle init` (then fill in gates, setup and lean - see the kit README)");
    if (project) {
      const t = project.tracker;
      check(!t.note, `issue tracker: ${t.kind} (${t.source === "config" ? "config.ts" : t.source === "docs/agents" ? "docs/agents/issue-tracker.md" : "default"}), queue "${project.label}"`, t.note ?? "", true);
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
