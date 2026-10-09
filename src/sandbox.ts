// Credentials, images and the sandbox every run uses.

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { CROSS_REVIEW } from "./agents.ts";
import type { Project } from "./config.ts";
import { nearest, OperatorError } from "./errors.ts";
import { hostIdentityParts, shq } from "./generated.ts";
import { commandOf, KIT_CACHE } from "./live-runs.ts";
import { kitRunning } from "../mod/hooks/run-live.ts";
import { withLock } from "./pool.ts";
import { hideFromGates, KIT_CREDENTIALS, unlockWorktree } from "./worktree-lock.ts";
import { resolveVersions, type Versions } from "./versions.ts";

export const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

// Everything personal - tokens, machine-wide limits - lives here, never in the
// kit's own directory, so the kit repo can be public and still in daily use.
export const USER_CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sandcastle-kit");

// Every key the personal config.json holds. An unknown one - a typo such as `keepawake` - was
// ignored without a word, and the setting the person meant never applied.
const MACHINE_KEYS = ["maxSandboxes", "maxGates", "keepAwake", "notify", "idleMark", "herdr"];

// Machine-wide settings from USER_CONFIG/config.json; empty when there is none.
export const machineSettings = (): Record<string, unknown> => {
  const file = join(USER_CONFIG, "config.json");
  if (!existsSync(file)) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new OperatorError(`${file} is not valid JSON: ${(error as Error).message}.`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new OperatorError(`${file} is not a JSON object.`);
  }
  for (const key of Object.keys(settings)) {
    if (MACHINE_KEYS.includes(key)) continue;
    const near = nearest(key, MACHINE_KEYS);
    throw new OperatorError(`${file}: unknown key \`${key}\`${near ? ` - did you mean \`${near}\`?` : ` (README -> Personal settings lists the keys)`}`);
  }
  return settings as Record<string, unknown>;
};

// stderr is captured, never passed through: a failing gh or git printed its raw line ("no git
// remotes found", "HTTP 502") above the kit's own explanation of it. It stays on the thrown
// error's `stderr` for the caller to explain.
//
// `maxBuffer` is raised from execFileSync's 1 MiB: a path list (`git diff --name-only`, `ls-tree`,
// `status`) grows with the tree, and a vendored directory or a mass rename passes 1 MiB, which
// threw ENOBUFS on a merge that was fine. The size matches the other whole-tree listings.
export const MAX_OUTPUT = 256 * 1024 * 1024;
export const sh = (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT, ...(env && { env: { ...process.env, ...env } }) }).trim();

// Who git records as the committer of a sandbox's commits and the kit's merges. Only the
// committer: the operator stays the author (git leaves that to config), so ownership stays
// clear while `git log --format='%an / %cn'` tells the agents' commits from the operator's
// own. `.invalid` is a reserved top-level domain (RFC 2606), so the address can never belong
// to a person or map to a GitHub account, as a users.noreply.github.com address would.
export const AGENT_COMMITTER = {
  GIT_COMMITTER_NAME: "Sandcastle agent",
  GIT_COMMITTER_EMAIL: "agent@sandcastle.invalid",
} as const;

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

const WORKTREE_MARK = ".sandcastle/worktrees/agent-issue-";

/**
 * Removes the exited sandbox containers a run left behind (`sandcastle-<uuid>`, exit 137 after a kill):
 * running ones are reapOrphans' business. A container is ours when it mounts an agent worktree of this
 * project, or one whose directory no longer exists (a project deleted since, which nothing else will
 * ever clean up). One that mounts another project's worktree still on disk is left alone. Returns the
 * ids removed. Call only while holding the project's run lock, like reapOrphans.
 */
export const removeExitedSandboxes = (project: Project): string[] => {
  const root = realpathSync(project.root);
  const prefixes = [...new Set([root, project.root])].map((r) => join(r, WORKTREE_MARK));
  let ids: string[];
  try {
    ids = sh("docker", ["ps", "-aq", "--filter", "status=exited", "--filter", "name=^sandcastle-"]).split("\n").filter(Boolean);
  } catch {
    return []; // Docker not up: nothing to remove
  }
  const removed: string[] = [];
  for (const id of ids) {
    try {
      const mounts = sh("docker", ["inspect", id, "--format", "{{range .Mounts}}{{.Source}}\n{{end}}"]).split("\n");
      // The worktree is the mount's path up to its `agent-issue-<n>` directory, which is what may be gone.
      const worktrees = mounts.filter((m) => m.includes(WORKTREE_MARK)).map((m) => {
        const end = m.indexOf("/", m.indexOf(WORKTREE_MARK) + WORKTREE_MARK.length);
        return end === -1 ? m : m.slice(0, end);
      });
      if (!worktrees.some((w) => prefixes.some((p) => w.startsWith(p)) || !existsSync(w))) continue;
      sh("docker", ["rm", id]);
      removed.push(id);
    } catch {
      /* gone meanwhile */
    }
  }
  return removed;
};

/**
 * Removes the kit's dangling images: a rebuilt image (a newer Claude Code, a changed Dockerfile) leaves
 * its predecessor untagged, and `prune` below only finds tagged ones. Only images carrying the kit's
 * label, so another project's dangling image is never touched; one still in use is refused by docker
 * and kept. Returns the ids removed.
 */
export const removeDanglingImages = (): string[] => {
  let ids: string[];
  try {
    ids = sh("docker", ["image", "ls", "-q", "--filter", "dangling=true", "--filter", `label=${KIT_LABEL}`]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const id of new Set(ids)) {
    try {
      sh("docker", ["image", "rm", id]);
      removed.push(id);
    } catch {
      /* in use */
    }
  }
  return removed;
};

export type CleanResult = {
  /** Exited sandbox containers that were removed (ids). */
  containers: string[];
  /** Dangling kit images that were removed (ids). */
  images: string[];
  /** Worktrees under `.sandcastle/worktrees/` that were removed. */
  worktrees: string[];
  /** Branches deleted; `unmerged` when `all` took one that still had commits off base. */
  deleted: { branch: string; unmerged: boolean }[];
  /** Agent branches kept because they hold work: `ahead` is the count of commits not on base. */
  kept: { branch: string; ahead: number }[];
};

/**
 * `sandcastle clean`: removes the worktrees under `.sandcastle/worktrees/` and deletes the agent
 * branches that are finished (and, with `all`, the unmerged ones too). Call only while holding
 * the project's run lock, and keep holding it until this returns: a run started meanwhile would
 * lose the worktrees it had just made. A worktree's own git lock (worktree-lock.ts) is released
 * just before that worktree is removed, never earlier and never for one outside the directory.
 */
export const cleanProject = (project: Project, all: boolean): CleanResult => {
  const cwd = project.root;
  reapOrphans(project);
  const containers = removeExitedSandboxes(project);
  const images = removeDanglingImages();
  const underWorktrees = join(project.root, ".sandcastle/worktrees/");
  const worktrees = sh("git", ["worktree", "list", "--porcelain"], cwd)
    .split("\n\n")
    .map((e) => e.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length))
    .filter((p): p is string => !!p && p.startsWith(underWorktrees));
  for (const path of worktrees) {
    // `worktree remove` refuses a locked worktree (a killed run left its lock behind).
    unlockWorktree(path, cwd);
    sh("git", ["worktree", "remove", "--force", path], cwd);
  }
  sh("git", ["worktree", "prune"], cwd);
  const base = project.baseBranch;
  const deleted: CleanResult["deleted"] = [];
  const kept: CleanResult["kept"] = [];
  for (const branch of sh("git", ["branch", "--format=%(refname:short)", "--list", "agent/*", "sandcastle/*"], cwd).split("\n").filter(Boolean)) {
    // A base-gate or verify branch is always scratch. An agent branch is
    // finished when every commit is on base, merged or as an equal patch.
    const finished = branch.startsWith("sandcastle/") || !sh("git", ["cherry", base, branch], cwd).split("\n").some((l) => l.startsWith("+"));
    if (finished || all) {
      sh("git", ["branch", "-D", branch], cwd);
      deleted.push({ branch, unmerged: !finished });
    } else {
      kept.push({ branch, ahead: Number(sh("git", ["rev-list", "--count", `${base}..${branch}`], cwd)) });
    }
  }
  return { containers, images, worktrees, deleted, kept };
};

/** A failed command's own closing line (its stderr), not Node's "Command failed:" echo of the arguments - a close comment, whole. */
export const errorLine = (error: unknown) => {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const said = typeof stderr === "string" ? stderr.trim().split("\n").filter(Boolean).at(-1) : undefined;
  // The message, not String(error): its "Error: " prefix reached the summary's lines.
  const line = (said ?? (error instanceof Error ? error.message : String(error)).split("\n")[0]).slice(0, 160);
  // With commit signing on and its agent locked, git says only "failed to write commit object".
  const all = `${typeof stderr === "string" ? stderr : ""}\n${error instanceof Error ? error.message : String(error)}`;
  return /failed to write commit object|gpg failed to sign|signing failed|error: (?:1Password|ssh-keygen|couldn't sign)/i.test(all)
    ? `${line} - git could not sign the commit (commit.gpgsign is on): unlock your signing agent (1Password, gpg-agent), then try again`
    : line;
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

/** The credentials files, in the order `credentials` merges them: the user file, then the project's on top. */
const credentialFiles = (project: Project) => [join(USER_CONFIG, ".env"), join(project.root, ".sandcastle/.env")];

/**
 * Which key and file the Claude credential the sandboxes spend came from, for a message that names it
 * (never the value): the API key if set, else the OAuth token - Claude Code's own order, so with both
 * set the key named is the one billed; the project's file when it defines the key (it overrides the user file).
 */
export const credentialSource = (project: Project): { key: string; file: string } | undefined => {
  const files = credentialFiles(project);
  const [user, local] = files.map(readEnv);
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (local[key]) return { key, file: files[1] };
    if (user[key]) return { key, file: files[0] };
  }
  return undefined;
};

/**
 * An API key the sandboxes would spend: `file` is the one its value comes from (the last of `files`
 * that sets it), `files` every one that sets it (removing it means removing it from each), and
 * `oauth` the file of a `CLAUDE_CODE_OAUTH_TOKEN` beside it, which Claude Code then ignores.
 */
export type ApiKeySpend = { file: string; files: string[]; oauth?: string };

/** The API key `files` (merged key by key, later over earlier) would put in a sandbox, or undefined when none would. */
export const apiKeySpend = (files: string[]): ApiKeySpend | undefined => {
  const read = files.map((file) => ({ file, env: readEnv(file) }));
  const setting = (key: string) => read.filter((r) => r.env[key]).map((r) => r.file);
  const keyFiles = setting("ANTHROPIC_API_KEY");
  if (!keyFiles.length) return undefined;
  const oauth = setting("CLAUDE_CODE_OAUTH_TOKEN").at(-1);
  return { file: keyFiles.at(-1)!, files: keyFiles, ...(oauth ? { oauth } : {}) };
};

/** The Claude credentials of the project's two files as `credentials` merges them, with none of its checks: a read-only command needs no GitHub token or a valid shape to say what the sandboxes would spend. */
export const claudeCredentials = (project: Project): Record<string, string | undefined> => {
  const [user, local] = credentialFiles(project).map(readEnv);
  return { ANTHROPIC_API_KEY: local!.ANTHROPIC_API_KEY || user!.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: local!.CLAUDE_CODE_OAUTH_TOKEN || user!.CLAUDE_CODE_OAUTH_TOKEN };
};

/** The GH_TOKEN a run would hand the sandboxes (the project's file over the shared one), read without the checks `credentials` makes. */
export const githubToken = (project: Project): string | undefined => {
  const [user, local] = credentialFiles(project).map(readEnv);
  return local!.GH_TOKEN || user!.GH_TOKEN || undefined;
};

/** `apiKeySpend` over the project's two credentials files, as `credentials` reads them. */
export const projectApiKeySpend = (project: Project) => apiKeySpend(credentialFiles(project));

export const credentials = (project: Project): Record<string, string> => {
  const files = credentialFiles(project);
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
  if (missing.length) throw new OperatorError(`Missing ${missing.join(", ")} in ${files[0]}. Run \`sandcastle setup\`, or \`sandcastle doctor\` to see what is set (docs/INSTALL.md covers writing it by hand).`);
  if (env.GH_TOKEN && !env.GH_TOKEN.startsWith("github_pat_") && process.env.SANDCASTLE_ALLOW_BROAD_TOKEN !== "1") {
    throw new OperatorError(
      "GH_TOKEN is not a fine-grained token (github_pat_...). Sandbox agents run unattended with " +
        "permission prompts off; a classic or OAuth token lets them push and edit workflows. Create one " +
        "at https://github.com/settings/personal-access-tokens/new with Issues read/write and Metadata " +
        "read on the repositories you run, and put it in " + files[0] + ".",
    );
  }
  hideFromGates(KIT_CREDENTIALS.map((k) => env[k]));
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

/** The label every image the kit builds carries, so `sandcastle clean` finds its dangling ones and no one else's. */
export const KIT_LABEL = "sandcastle-kit=1";

/** The `docker build` argv. `--pull` makes the daemon fetch the FROM image afresh instead of reusing its local copy. */
export const buildArgs = (tag: string, args: Record<string, string>, pull: boolean): string[] => [
  "build",
  ...(pull ? ["--pull"] : []),
  "-t", tag,
  "--label", KIT_LABEL,
  ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
  "-",
];

/**
 * Reads docker's build output as it arrives and decides whether it is worth showing. BuildKit's plain
 * progress (what docker prints when its output is a pipe) says `#<n> CACHED` for a step it did not run, and
 * `#<n> DONE` or `#<n> <seconds> <output>` for one it did. A build in which every step was cached is a
 * re-tag, about 85 lines of nothing; the output is held until a step does real work, then shown from its
 * first line on. Output of any other shape (the classic builder, Podman) never shows a cached step, so it
 * is never collapsed. `FROM` steps are left out of the decision: a cached build still resolves them, with a
 * `DONE`, and a base that was really pulled makes the `RUN` steps after it real.
 */
const watchBuild = (show: (text: string) => void) => {
  const names = new Map<number, "from" | "step">();
  const partial = ["", ""];
  let held = "";
  let real = false;
  let cached = 0;
  const line = (text: string) => {
    const step = /^#(\d+) \[(?:\S+ )?\d+\/\d+\] (.*)/.exec(text);
    if (step) names.set(Number(step[1]), step[2]!.startsWith("FROM ") ? "from" : "step");
    const work = /^#(\d+) (?:DONE|ERROR|\d+\.\d+ )/.exec(text);
    if (work && names.get(Number(work[1])) === "step") real = true;
    if (/^#\d+ CACHED/.test(text)) cached++;
    if (!real) {
      held += `${text}\n`;
      return;
    }
    show(held + `${text}\n`);
    held = "";
  };
  return {
    feed: (stream: 0 | 1, chunk: string) => {
      const parts = (partial[stream] + chunk).split("\n");
      partial[stream] = parts.pop()!;
      parts.forEach(line);
    },
    // `ok`: docker exited 0. A build that failed shows everything it said.
    end: (ok: boolean) => {
      partial.filter(Boolean).forEach(line);
      const collapsed = ok && !real && cached > 0;
      if (!collapsed) show(held);
      return collapsed;
    },
  };
};

// `fix` is the next step when the build fails: docker's own output above says what broke, but not
// which file to change, and a stack trace under it buried that output.
const build = async (tag: string, dockerfile: string, args: Record<string, string>, pull: boolean, fix: string) => {
  // The start line waits for the watcher's first output: printed up front, a cached build said
  // `Building` and then that it re-tagged, two lines where one is the whole story.
  let started = false;
  const watch = watchBuild((text) => {
    if (!started) console.log(`Building ${tag} ...`);
    started = true;
    process.stderr.write(text);
  });
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("docker", buildArgs(tag, args, pull), { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (d: string) => watch.feed(0, d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => watch.feed(1, d));
    child.once("error", () => resolve(null));
    // Docker may exit before reading the Dockerfile; the exit code says why.
    child.stdin.on("error", () => {});
    child.stdin.end(dockerfile);
    child.once("close", resolve);
  });
  if (watch.end(code === 0)) console.log(`Image ${tag} re-tagged from cache`);
  if (code !== 0) {
    throw new OperatorError(`Building ${tag} failed${code ? ` (docker build exited ${code})` : ""} - the step that failed is in docker's output above. ${fix}`);
  }
};

// A docker call that fails is a refusal naming what it was doing and docker's own message, not the
// stack trace of the exec error.
const dockerCall = (what: string, args: string[]) => {
  try {
    return sh("docker", args);
  } catch (e) {
    const { stderr, message } = e as { stderr?: string | Buffer; message: string };
    const said = String(stderr ?? "").trim() || message;
    throw new OperatorError(`Docker failed ${what} (docker ${args.join(" ")}): ${said}`);
  }
};

/** One small file per image tag, written by `ensureImage`: docker keeps no "last used" time, so the kit does. */
export const IMAGE_USE_DIR = join(KIT_CACHE, "image-use");

/**
 * A tag nobody has used or built for this many days may be pruned. Several checkouts of the kit, or of one
 * project, hash different Dockerfiles and so different tags: pruning every tag but its own made each
 * checkout delete the others' images, and rebuild its own at the next run.
 */
export const IMAGE_KEEP_DAYS = 14;

type Use = { at: number; pids: number[] };

const useFile = (tag: string) => join(IMAGE_USE_DIR, tag.replace(/[^A-Za-z0-9_.-]/g, "_"));

const readUse = (tag: string): Use | undefined => {
  try {
    const { at, pids } = JSON.parse(readFileSync(useFile(tag), "utf8")) as Partial<Use>;
    if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
    return { at, pids: Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p)) : [] };
  } catch {
    return undefined;
  }
};

const liveUsers = (pids: number[]) => pids.filter((p) => kitRunning(p, commandOf));

/**
 * Records that this process uses `tag` now, and keeps the pids of the kit processes that still run and
 * used it: a run that outlasts `IMAGE_KEEP_DAYS` keeps its image. Best effort - a cache directory that
 * cannot be written must not stop a build.
 */
const noteUse = (tag: string, now = Date.now(), user = true) => {
  try {
    mkdirSync(IMAGE_USE_DIR, { recursive: true });
    const pids = [...new Set([...liveUsers(readUse(tag)?.pids ?? []), ...(user ? [process.pid] : [])])];
    writeFileSync(useFile(tag), JSON.stringify({ at: now, pids }));
  } catch {
    /* the tag simply looks unused, and is kept for a while from the first prune that sees it */
  }
};

// A tag of the same repository that has not been used for IMAGE_KEEP_DAYS, and that no live kit process
// used, is removed once its successor is built; these images are several GB each. A tag with no use stamp
// (built before the kit kept them) starts its days at the first prune that sees it. An image a container
// still uses is left alone (docker refuses), and so is any other repository.
const prune = (repo: string, keep: string, now = Date.now()) => {
  const tags = dockerCall("listing the images of " + repo, ["image", "ls", repo, "--format", "{{.Repository}}:{{.Tag}}"]).split("\n").filter(Boolean);
  for (const t of tags.filter((t) => t !== keep && !t.endsWith(":latest"))) {
    const use = readUse(t);
    if (!use) {
      // Seen, not used: naming this process would keep the tag for as long as this run lasts.
      noteUse(t, now, false);
      continue;
    }
    if (now - use.at < IMAGE_KEEP_DAYS * 24 * 60 * 60 * 1000 || liveUsers(use.pids).length > 0) continue;
    try {
      sh("docker", ["image", "rm", t]);
      rmSync(useFile(t), { force: true });
    } catch {
      /* in use */
    }
  }
};

/** The base image's tag and what it builds from, in one place so doctor finds the image `ensureImage` made. */
export const baseImage = (versions: Pick<Versions, "claude" | "codex">) => {
  const file = readFileSync(join(KIT, "docker/base.Dockerfile"), "utf8");
  // The user ids and the agents' versions are baked into the image, so they are part of its identity:
  // a release rebuilds once, and a Dockerfile that never changes still gets a new tag.
  const ids = {
    AGENT_UID: sh("id", ["-u"]),
    AGENT_GID: sh("id", ["-g"]),
    CLAUDE_CODE_VERSION: versions.claude,
    CODEX_VERSION: versions.codex,
  };
  return { file, ids, tag: `sandcastle-base:${hash(file, ...Object.values(ids))}` };
};

/** The lock the base image's build, prune and tag, and the project layer built on it, are taken under, machine-wide. */
export const BASE_LOCK = join(KIT_CACHE, "locks", "base-image.lock");

/** `versions` is what the caller already resolved and showed; left out, they are resolved here. */
export const ensureImage = async (project: Project, force = false, versions?: Versions): Promise<string> => {
  const { file: baseFile, ids, tag: baseTag } = baseImage(versions ?? (await resolveVersions(project)));
  // The base step and the project layer's build are one machine-wide critical section, for any base tag:
  // projects share the images, and every project rebuilds after an update. Two builds of one tag race
  // to `docker tag` an image the other is still making, and two tags (each project's Claude Code version
  // is in it) have each prune the other's fresh image. The second waits, then finds the image built. The
  // layer build is inside too: its `FROM` names the base tag, which another project's base build would
  // otherwise prune before the layer's `docker build` resolved it.
  return withLock(
    BASE_LOCK,
    `${project.name} ${baseTag}`,
    async () => {
      if (force || !imageExists(baseTag)) {
        // Only the base is pulled: the floating FROM tag never refreshes otherwise (the image tag hashes the
        // Dockerfile text). A project layer builds FROM the local base, which a pull would not find.
        await build(baseTag, baseFile, ids, force, "The base image fails most often on the network (a download or `apt-get`): check it, then `sandcastle build` again.");
        prune("sandcastle-base", baseTag);
      }
      noteUse(baseTag);
      // `latest` is only the default a layer's `ARG BASE` names; builds pass the hash.
      dockerCall(`tagging ${baseTag} as sandcastle-base:latest`, ["tag", baseTag, "sandcastle-base:latest"]);

      if (!project.dockerfile) {
        // Written by hand from the template, it does nothing until the config names it.
        if (existsSync(join(project.root, ".sandcastle/Dockerfile"))) {
          console.log('Not built: .sandcastle/Dockerfile - the config names no `dockerfile`. Add `dockerfile: ".sandcastle/Dockerfile"` to .sandcastle/config.ts to build it.');
        }
        return baseTag;
      }

      const layerFile = readFileSync(join(project.root, project.dockerfile), "utf8");
      const repo = `sandcastle-${project.name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
      const tag = `${repo}:${hash(baseTag, layerFile)}`;
      if (force || !imageExists(tag)) {
        await build(tag, layerFile, { BASE: baseTag }, false, `Fix ${project.dockerfile}, then \`sandcastle build\` again.`);
        prune(repo, tag);
      }
      noteUse(tag);
      return tag;
    },
    (owner) => console.log(`Waiting for another sandcastle build of the base image${owner ? ` (pid ${owner})` : ""} to finish ...`),
  );
};

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

// The cross-family review signs in with the host's ChatGPT login. The file is
// mounted read-only and copied, so a token refresh inside a container never
// writes back to the host. preflight() refreshes the host login first, which
// keeps the copies from needing a refresh of their own.
const CODEX_AUTH = "/home/agent/.codex-host/auth.json";

// An agent's commit or merge ends by starting `git maintenance run --auto` (from git 2.29), which
// can run `git gc --auto`: a detached repack and prune in the `.git` every sandbox shares, in a
// container that may be stopped before it ends. The prompt and `git-guard.sh` forbid `git gc` by
// hand; these pairs stop git starting it on its own, as `disableHostGitGc` does for the host (the
// host's `GIT_CONFIG_*` never reach a container). Command-scope config wins over every config
// file, so a project's own `.git/config` cannot turn it back on. In the environment, not the
// image: no rebuild, and a project layer is covered too.
export const SANDBOX_GIT_MAINTENANCE_OFF = [["gc.auto", "0"], ["maintenance.auto", "false"]] as const;

/** `env` with the maintenance-off pairs appended after any `GIT_CONFIG_*` pairs it already carries. */
const withGitMaintenanceOff = (env: Record<string, string>): Record<string, string> => {
  const count = Number(env.GIT_CONFIG_COUNT);
  const n = Number.isInteger(count) && count >= 0 ? count : 0;
  const pairs = SANDBOX_GIT_MAINTENANCE_OFF.flatMap(([key, value], i) => [
    [`GIT_CONFIG_KEY_${n + i}`, key],
    [`GIT_CONFIG_VALUE_${n + i}`, value],
  ]);
  return { ...env, ...Object.fromEntries(pairs), GIT_CONFIG_COUNT: String(n + SANDBOX_GIT_MAINTENANCE_OFF.length) };
};

// Not part of credentials(): doctor and the token checks read that as what the user configured.
// Every sandbox - a ticket's, a landing's, a gate-only one - is built from this through `sandboxConfig`.
export const sandboxEnv = (project: Project): Record<string, string> =>
  withGitMaintenanceOff({ ...credentials(project), ...AGENT_COMMITTER });

// Claude Code reads /etc/claude-code/managed-settings.json above user and project settings, so a
// branch's own `disableAllHooks` cannot switch the git guard off. A read-only *directory* mount
// cannot be written to, edited or removed from inside; a file mount outside the sandbox home is
// refused by Sandcastle. No image rebuild: the guard travels with the kit.
export const MANAGED_SETTINGS = "/etc/claude-code";

export const sandboxMounts = (project: Project) => [
  ...project.mounts,
  { hostPath: join(KIT, "container"), sandboxPath: MANAGED_SETTINGS, readonly: true },
  ...(CROSS_REVIEW
    ? [{ hostPath: "~/.codex/auth.json", sandboxPath: CODEX_AUTH, readonly: true }]
    : []),
];

// Sandcastle runs the ready hooks all at once, so this one races the project's setup: written to
// git's XDG global file rather than `~/.gitconfig`, it never meets a setup step's `git config
// --global` at `~/.gitconfig.lock` (which would fail that step), and an identity the setup sets
// there still wins, being read after this file.
export const gitIdentityCommand = (root: string) => {
  const { name, email } = hostIdentityParts(root);
  const dir = "${XDG_CONFIG_HOME:-$HOME/.config}/git";
  const set = (key: string, value: string) => `git config --file "${dir}/config" ${key} ${shq(value)}`;
  return `mkdir -p "${dir}" && ${set("user.name", name)} && ${set("user.email", email)}`;
};

/** What a sandbox is for: a `ticket`'s (an agent works in it), or `gate`-only (a landing, the base and verify gates, `sandcastle gates` and `land`). */
export type SandboxKind = "ticket" | "gate";

/**
 * The CPUs a sandbox container of `kind` may use (`docker run --cpus`), or undefined for no limit.
 * An agent runs the project's whole suite in its own sandbox as often as it likes, outside
 * `maxGates`, so several suites at once starved one another and every gate beside them: a ticket's
 * sandbox gets the VM's CPUs (`docker info`'s NCPU) divided by the run's concurrency. A gate-only
 * sandbox runs one gate pass, and landings go one at a time on the one worker that sets the run's
 * end, so it gets them divided by `maxGates` instead (the passes that can run at once). Either is at least 2
 * and never more than the VM has. The project's `cpus` wins for both: a number is the limit (no
 * more than the VM has), `false` none. `docker info` failing (or reporting no NCPU) sets none
 * rather than guessing. The one rule for a run, `sandcastle gates` and `sandcastle land` alike.
 */
export const sandboxCpus = (
  project: Pick<Project, "cpus">,
  kind: SandboxKind,
  pool: { concurrency: number; maxGates: number },
  dockerInfo: () => string | undefined,
): number | undefined => {
  if (project.cpus === false) return undefined;
  let ncpu: number;
  try {
    ncpu = Number((JSON.parse(dockerInfo() ?? "{}") as { NCPU?: unknown }).NCPU);
  } catch {
    ncpu = NaN;
  }
  const known = Number.isInteger(ncpu) && ncpu >= 1;
  // `docker run --cpus` above the VM's CPUs is refused, so a config written on a larger machine
  // would stop every sandbox from starting on a smaller one.
  if (typeof project.cpus === "number") return known ? Math.min(project.cpus, ncpu) : project.cpus;
  if (!known) return undefined;
  const sharers = kind === "gate" ? pool.maxGates : pool.concurrency;
  return Math.min(ncpu, Math.max(2, Math.floor(ncpu / Math.max(1, sharers))));
};

/** The run's start line for the limits `sandboxCpus` chose: a ticket's sandbox, then a gate-only one when it differs. */
export const cpusLine = (project: Pick<Project, "cpus">, ticket: number | undefined, gate: number | undefined) =>
  ticket === undefined
    ? `Sandbox CPUs: no limit${project.cpus === false ? " (cpus: false)" : " (docker info gave no CPU count)"}`
    : `Sandbox CPUs: ${ticket} each${gate === undefined || gate === ticket ? "" : `, ${gate} for landing and base gates`}${
        typeof project.cpus !== "number" ? "" : ticket < project.cpus ? ` (cpus ${project.cpus} in the project config, but the VM has ${ticket})` : " (cpus in the project config)"
      }`;

// `leanPlan` is the path of a JSON plan from lean.ts; the hook applies it to
// each fresh worktree before the agent sees it. A numeric `project.cpus` caps each container: a
// run, `sandcastle gates` and `sandcastle land` set it from `sandboxCpus` (per kind of sandbox)
// before their first sandbox, so gates.ts and land.ts take no argument for it.
export const sandboxConfig = (project: Project, image: string, leanPlan: string) => ({
  sandbox: docker({
    imageName: image,
    env: sandboxEnv(project),
    mounts: sandboxMounts(project),
    ...(typeof project.cpus === "number" ? { cpus: project.cpus } : {}),
  }),
  hooks: {
    host: {
      onWorktreeReady: [{ command: `"${KIT}/bin/sandcastle" lean-apply "${leanPlan}"` }],
    },
    sandbox: {
      onSandboxReady: [
        // `createSandbox` returns once every ready hook has ended, so before any gate: a test that
        // commits needs an identity in a sandbox no agent has worked in. Global config, not
        // GIT_AUTHOR_* in the environment, which would make the agent the author (see AGENT_COMMITTER).
        { command: gitIdentityCommand(project.root) },
        ...(CROSS_REVIEW
          ? [{ command: `mkdir -p ~/.codex && cp ${CODEX_AUTH} ~/.codex/auth.json` }]
          : []),
        // Sandcastle runs the ready hooks all at once, so setup's steps share one hook to keep their
        // order: pnpmStore's store-dir step raced the install, which then filled a store of its own.
        // A subshell each, ended on a line of its own so a step's trailing comment cannot eat it.
        ...(project.setup.length ? [{ command: project.setup.map((c) => `(${c}\n)`).join(" && ") }] : []),
      ],
    },
  },
});
