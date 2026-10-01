// `sandcastle doctor` - one line per requirement, ok or the exact fix. Written
// to be read by a person or by a coding agent helping them set up.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { linearKey } from "./blockers.ts";
import { CONFIG_PATH, loadProject } from "./config.ts";
import { KIT, USER_CONFIG } from "./sandbox.ts";

export const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
};

export const doctor = async (repoRoot?: string) => {
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

  const envFile = join(USER_CONFIG, ".env");
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  check(existsSync(envFile), `credentials file ${envFile}`, "sandcastle setup   (or see docs/INSTALL.md to write it by hand)");
  // A run refuses empty values, so catch them here rather than hours later.
  const empty = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (empty.length) check(false, "no empty keys in the credentials file", `Delete the empty line(s) for ${empty.join(", ")}, or run sandcastle setup.`);
  check(!!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY), "Claude credential set (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)", "sandcastle setup   (or run `claude setup-token` and put the token in the credentials file)");
  check(!!env.GH_TOKEN?.startsWith("github_pat_"), "GH_TOKEN is a fine-grained token (github_pat_)" + (needsGh ? "" : " (not needed: this project keeps tickets in files)"), "sandcastle setup   (or create one at https://github.com/settings/personal-access-tokens/new - only the repos you run, Issues read/write, Metadata read)", !needsGh);
  check(!!run("sh", ["-c", "command -v codex"]), "Codex CLI (only for CROSS_REVIEW=1)", "npm install -g @openai/codex && codex login", true);
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
