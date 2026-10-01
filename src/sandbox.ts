// Credentials, images and the sandbox every run uses.

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { CROSS_REVIEW } from "./agents.ts";
import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";

export const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

// Everything personal - tokens, machine-wide limits - lives here, never in the
// kit's own directory, so the kit repo can be public and still in daily use.
export const USER_CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sandcastle-kit");

// Machine-wide settings from USER_CONFIG/config.json; empty when there is none.
export const machineSettings = (): Record<string, unknown> => {
  const file = join(USER_CONFIG, "config.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};

export const sh = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd }).trim();

// A branch's own commits since the base: merges are left out, because the kit
// merges the base into a carried branch on each re-run and those merge-ins are
// not the ticket's work. Only for reporting - "carried" and "nochange" count
// every commit, merge or not.
export const ownCommits = (base: string, branch: string, cwd?: string) =>
  Number(sh("git", ["rev-list", "--count", "--no-merges", `${base}..${branch}`], cwd));

/**
 * Stops the sandboxes a killed run of this project left working. A run killed
 * outright (SIGKILL, a closed terminal) cannot close its containers, and their
 * agents went on spending the plan's allowance on work nobody would gate or
 * land. Call only while holding the project's run lock: then no live run owns
 * a container that mounts one of its agent worktrees. `sandcastle gates` uses
 * other worktrees and is never touched.
 */
export const reapOrphans = (project: Project) => {
  // Docker records a bind mount's source as it was given: either spelling.
  const root = realpathSync(project.root);
  const prefixes = [...new Set([root, project.root])].map((r) => join(r, ".sandcastle/worktrees/agent-issue-"));
  let ids: string[];
  try {
    ids = sh("docker", ["ps", "-q", "--filter", "name=^sandcastle-"]).split("\n").filter(Boolean);
  } catch {
    return; // Docker not up: nothing of ours can be running
  }
  for (const id of ids) {
    try {
      const mounts = sh("docker", ["inspect", id, "--format", "{{range .Mounts}}{{.Source}}\n{{end}}"]).split("\n");
      const worktree = mounts.find((m) => prefixes.some((p) => m.startsWith(p)));
      if (!worktree) continue;
      sh("docker", ["rm", "-f", id]);
      console.log(`Stopped a sandbox a killed run left working: ${relative(worktree.startsWith(root) ? root : project.root, worktree)}`);
    } catch {
      /* gone meanwhile */
    }
  }
};

/** A failed command's own last word (its stderr), not Node's "Command failed:" echo of the arguments - a close comment, whole. */
export const errorLine = (error: unknown) => {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const said = typeof stderr === "string" ? stderr.trim().split("\n").filter(Boolean).at(-1) : undefined;
  return (said ?? String(error).split("\n")[0]).slice(0, 160);
};

// ---------------------------------------------------------------------------
// Credentials: ~/.config/sandcastle-kit/.env for every project, then the
// project's own `.sandcastle/.env` on top, key by key.
//
// The container runs its agents with permission prompts off, so its GitHub
// token must be able to do nothing worse than the agents' job: read and
// comment on issues. A classic (ghp_) or OAuth (gho_, e.g. `gh auth token`)
// token can push, edit workflows and change repo settings, so it is refused -
// use a fine-grained token (github_pat_) with Issues read/write and Metadata
// read on the repos you run. An empty value is refused too: Sandcastle falls
// back to the host environment for empty keys, which could pull the host's
// ANTHROPIC_API_KEY into the container and bill API credits.
// ---------------------------------------------------------------------------

// Read on the host only; the sandbox's agents run unattended and never get them.
export const HOST_ONLY_KEYS = ["LINEAR_API_KEY"];

const readEnv = (file: string) => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {});

/**
 * Which key and file the Claude credential came from, for a message that names it (never the value):
 * the OAuth token if set, else the API key; the project's file when it defines the key (it overrides the user file).
 */
export const credentialSource = (project: Project): { key: string; file: string } | undefined => {
  const files = [join(USER_CONFIG, ".env"), join(project.root, ".sandcastle/.env")];
  const [user, local] = files.map(readEnv);
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (local[key]) return { key, file: files[1] };
    if (user[key]) return { key, file: files[0] };
  }
  return undefined;
};

export const credentials = (project: Project): Record<string, string> => {
  const files = [join(USER_CONFIG, ".env"), join(project.root, ".sandcastle/.env")];
  const env: Record<string, string | undefined> = { ...readEnv(files[0]), ...readEnv(files[1]) };
  for (const k of HOST_ONLY_KEYS) delete env[k];
  // Sandcastle forwards every key of the project's .sandcastle/.env into the
  // container by itself, past the filter above, so a host-only key cannot live there.
  const inProject = HOST_ONLY_KEYS.filter((k) => readEnv(files[1])[k]);
  if (inProject.length) throw new OperatorError(`${inProject.join(", ")} in ${files[1]} would reach the sandbox. Move it to ${files[0]}.`);
  const empty = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (empty.length) throw new OperatorError(`Empty ${empty.join(", ")} in ${files.join(" or ")} - remove the line or give it a value.`);
  const missing = [
    ...(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY ? [] : ["CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)"]),
    ...(env.GH_TOKEN || project.tracker.kind === "files" ? [] : ["GH_TOKEN"]),
  ];
  if (missing.length) throw new OperatorError(`Missing ${missing.join(", ")} in ${files[0]} (see .env.example in the kit).`);
  if (env.GH_TOKEN && !env.GH_TOKEN.startsWith("github_pat_") && process.env.SANDCASTLE_ALLOW_BROAD_TOKEN !== "1") {
    throw new OperatorError(
      "GH_TOKEN is not a fine-grained token (github_pat_...). Sandbox agents run unattended with " +
        "permission prompts off; a classic or OAuth token lets them push and edit workflows. Create one " +
        "at https://github.com/settings/personal-access-tokens/new with Issues read/write and Metadata " +
        "read on the repositories you run, and put it in " + files[0] + ".",
    );
  }
  return env as Record<string, string>;
};

// ---------------------------------------------------------------------------
// Images: `sandcastle-base` for everyone, `sandcastle-<name>` layered on it
// per project. Each tag is a hash of the Dockerfiles that made it, so a
// changed pin rebuilds exactly what depends on it and nothing else does.
// Both build with no context (Dockerfile on stdin): a project's .sandcastle/
// holds whole worktrees, which must never be sent to the Docker daemon.
// ---------------------------------------------------------------------------

const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);

const imageExists = (tag: string) => {
  try {
    sh("docker", ["image", "inspect", tag]);
    return true;
  } catch {
    return false;
  }
};

const build = (tag: string, dockerfile: string, args: Record<string, string>) => {
  console.log(`Building ${tag} ...`);
  execFileSync(
    "docker",
    [
      "build", "-t", tag,
      ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
      "-",
    ],
    { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] },
  );
};

// A superseded tag of the same repository is removed once its successor is
// built; these images are several GB each. An image a container still uses
// is left alone (docker refuses), and so is any other repository.
const prune = (repo: string, keep: string) => {
  const tags = sh("docker", ["image", "ls", repo, "--format", "{{.Repository}}:{{.Tag}}"]).split("\n").filter(Boolean);
  for (const t of tags.filter((t) => t !== keep && !t.endsWith(":latest"))) {
    try {
      sh("docker", ["image", "rm", t]);
    } catch {
      /* in use */
    }
  }
};

export const ensureImage = (project: Project, force = false): string => {
  const baseFile = readFileSync(join(KIT, "docker/base.Dockerfile"), "utf8");
  // The user ids are baked into the image, so they are part of its identity.
  const ids = { AGENT_UID: sh("id", ["-u"]), AGENT_GID: sh("id", ["-g"]) };
  const baseTag = `sandcastle-base:${hash(baseFile, ids.AGENT_UID, ids.AGENT_GID)}`;
  if (force || !imageExists(baseTag)) {
    build(baseTag, baseFile, ids);
    prune("sandcastle-base", baseTag);
  }
  // `latest` is only the default a layer's `ARG BASE` names; builds pass the hash.
  sh("docker", ["tag", baseTag, "sandcastle-base:latest"]);
  if (!project.dockerfile) return baseTag;

  const layerFile = readFileSync(join(project.root, project.dockerfile), "utf8");
  const repo = `sandcastle-${project.name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
  const tag = `${repo}:${hash(baseTag, layerFile)}`;
  if (force || !imageExists(tag)) {
    build(tag, layerFile, { BASE: baseTag });
    prune(repo, tag);
  }
  return tag;
};

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

// The cross-family review signs in with the host's ChatGPT login. The file is
// mounted read-only and copied, so a token refresh inside a container never
// writes back to the host. preflight() refreshes the host login first, which
// keeps the copies from needing a refresh of their own.
const CODEX_AUTH = "/home/agent/.codex-host/auth.json";

// `leanPlan` is the path of a JSON plan from lean.ts; the hook applies it to
// each fresh worktree before the agent sees it.
export const sandboxConfig = (project: Project, image: string, leanPlan: string) => ({
  sandbox: docker({
    imageName: image,
    env: credentials(project),
    mounts: [
      ...project.mounts,
      ...(CROSS_REVIEW
        ? [{ hostPath: "~/.codex/auth.json", sandboxPath: CODEX_AUTH, readonly: true }]
        : []),
    ],
  }),
  hooks: {
    host: {
      onWorktreeReady: [{ command: `"${KIT}/bin/sandcastle" lean-apply "${leanPlan}"` }],
    },
    sandbox: {
      onSandboxReady: [
        ...(CROSS_REVIEW
          ? [{ command: `mkdir -p ~/.codex && cp ${CODEX_AUTH} ~/.codex/auth.json` }]
          : []),
        ...project.setup.map((command) => ({ command })),
      ],
    },
  },
});
