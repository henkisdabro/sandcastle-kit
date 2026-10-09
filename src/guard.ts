// Host safety. Sandbox agents run unattended with permission prompts off, and
// Sandcastle bind-mounts the repo's whole `.git` into every container, so
// what a sandbox writes can reach the host in three ways. Each is closed here.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Project } from "./config.ts";
import { releaseLock, takeLock } from "./pool.ts";
import { DockerAnswerError, removeSandboxContainer, sh, stopSandboxContainer } from "./sandbox.ts";
import { OperatorError } from "./errors.ts";
import { expandTouches, parseTouches } from "./touches.ts";

// ---------------------------------------------------------------------------
// 1. Git hooks on the host. `git merge --no-verify` still runs post-merge, and
// Sandcastle's host-side `git worktree add` runs post-checkout - from the
// BRANCH's own hook files, so a branch that adds `.husky/post-merge` would run
// on the host when it lands. This process and every git it starts (Sandcastle's
// included) runs with hooks off. The container never sees this environment, so
// the repo's hooks still run on agent commits inside the sandbox.
// ---------------------------------------------------------------------------

// One more `GIT_CONFIG_*` pair for this process and every git it starts. Not added twice: each
// turn of an autonomy run calls this again, and the first value stays - a later turn reads a
// config that sandboxes have had their hands on.
const hostGitConfig = (key: string, value: string) => {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < n; i++) if (process.env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === key.toLowerCase()) return;
  process.env[`GIT_CONFIG_KEY_${n}`] = key;
  process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
};

export const disableHostGitHooks = () => hostGitConfig("core.hooksPath", "/dev/null");

// A landing merge on the host runs while sandboxes add and remove worktrees. Since git 2.29 the
// commands that used to start an auto gc start `git maintenance run --auto`, which only
// `maintenance.auto=false` stops before a process starts; from git 2.54 the default tasks of that
// process (geometric repack, worktree prune, ref pack, reflog expiry) do not read `gc.auto`, so
// they could run in the shared `.git` beside the sandboxes. `gc.auto=0` stays for an auto gc
// started directly.
export const disableHostGitGc = () => {
  hostGitConfig("gc.auto", "0");
  hostGitConfig("maintenance.auto", "false");
};

// Config keys that make the host's git run a program. A sandbox can write `.git/config` at any
// moment, and the `.git` check before each host write leaves a gap of milliseconds before the git
// call; command-scope config (`GIT_CONFIG_*`) wins over every config file, so a value pinned here
// is the one git uses whatever lands in the file. Signing is off: a host merge or commit would run
// `gpg.program`. Drivers and programs the config names at the start keep that value, so a planted
// replacement never runs. A driver named in `.gitattributes` with no config at the start is not
// pinned - an empty value breaks git's built-in drivers (`merge=union`) - and is left to the check.
const COMMAND_KEYS =
  "^(filter\\.[^.]+\\.(clean|smudge|process)|merge\\.[^.]+\\.driver|diff\\.[^.]+\\.(command|textconv)|diff\\.external" +
  "|core\\.(pager|editor|askpass|sshcommand)|gpg\\.(.+\\.)?program|sequence\\.editor)$";

export const pinHostGitConfig = (root: string) => {
  hostGitConfig("core.fsmonitor", "false");
  hostGitConfig("commit.gpgSign", "false");
  hostGitConfig("tag.gpgSign", "false");
  let entries = "";
  try {
    entries = sh("git", ["config", "-z", "--get-regexp", COMMAND_KEYS], root);
  } catch {
    // Exit 1: none of the keys is set.
  }
  for (const entry of entries.split("\0").filter(Boolean)) {
    const at = entry.indexOf("\n");
    if (at > 0) hostGitConfig(entry.slice(0, at), entry.slice(at + 1));
  }
};

// ---------------------------------------------------------------------------
// 2. The shared `.git`. A container can rewrite `.git/config` (a
// `core.fsmonitor` command runs on the host's next `git status`), the files in
// `.git/info/`, plant a hook in `.git/hooks/` (it runs on the operator's next
// checkout or commit, long after the run's own hooks-off environment is gone),
// or move the base branch. Fingerprinted at start and checked before every
// sandbox opens, before every sandbox closes and before landing; any change stops the run before
// the host runs another git command in the repo. A sandbox's own worktree record
// is held to what git writes instead (below, `assertWorktreeRecords`).
// ---------------------------------------------------------------------------

// `files` maps each fingerprinted path to its content's hash, so a change can name the file.
// `base` is the base tip the run expects: the landing worker moves it with its own writes
// (landing.ts), so anything else that moves the base still stops the run. "" is a base ref that
// does not exist.
// `branches` is the tip of every `agent/issue-*` branch the run expects, and `flying` the ones whose
// pipeline runs now (the agent is committing): a branch in it may move, and only has to exist. The
// kit moves both with its own writes - `begin`, `settle` and `forget` in landing.ts - so a branch
// it deleted itself (a landed branch) is never "restored". Every pipeline and the landing worker
// check the same two objects, hence the sharing in `gitFingerprint`.
// `config` is `.git/config` as the list of its `key\nvalue` entries (null when git cannot read it as
// config), kept beside its hash so a change can be told apart by key: see `configChange`.
// `worktreeConfig` is the main worktree's `.git/config.worktree` the same way (no entries when absent).
// `files` also holds the shared `.git/modules/` (see `moduleFiles`), whose repositories a host git reaches through a gitlink.
export type Fingerprint = { files: Record<string, string>; config: ConfigReading; worktreeConfig: ConfigReading; base: string; branches: Record<string, string>; flying: Set<string> };

type ConfigReading = { path: string; entries: string[] | null };

const AGENT_BRANCH = /^agent\/issue-/;

/**
 * The shared `.git/modules/`: each submodule's git directory, which a host `git status` that recurses into a gitlink reads
 * the config and attributes of. Sandcastle never initialises a submodule, so the directory is absent in the ordinary run,
 * and a sandbox that makes one is a difference from the run's start. Every file and directory under it, keyed by path,
 * except what git reads as data and a host's own use of a submodule rewrites (`objects/`, `refs/`, `logs/`, `index`,
 * `packed-refs`, `HEAD`, `FETCH_HEAD`, `ORIG_HEAD`): a symlink is its target, a directory a marker, a file its hash.
 */
const MODULE_DATA = new Set(["objects", "refs", "logs", "index", "packed-refs", "HEAD", "FETCH_HEAD", "ORIG_HEAD"]);
const moduleFiles = (modules: string, hashOf: (f: string) => string): Record<string, string> => {
  const found: Record<string, string> = {};
  const top = lstatSync(modules, { throwIfNoEntry: false });
  if (!top) return found;
  // `container`: a directory of modules, whose entries are module names (a module may be named `objects`), not a git
  // directory's own, whose data names are left out.
  const visit = (dir: string, container: boolean) => {
    found[dir] = "directory";
    for (const name of readdirSync(dir).sort()) {
      if (!container && MODULE_DATA.has(name)) continue;
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) found[path] = `link ${readlinkSync(path)}`;
      else if (info.isDirectory()) visit(path, !container && name === "modules");
      else found[path] = hashOf(path);
    }
  };
  if (top.isDirectory()) visit(modules, true);
  else found[modules] = top.isSymbolicLink() ? `link ${readlinkSync(modules)}` : hashOf(modules);
  return found;
};

const commonDir = (root: string) => sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], root);

/** A ref's tip, or "" when it does not exist: a deleted ref is something to report, not a raw git error. */
export const tipOf = (root: string, ref: string) => {
  try {
    return sh("git", ["rev-parse", "--verify", "-q", ref], root);
  } catch {
    return "";
  }
};

const agentBranches = (root: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const line of sh("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/agent/"], root).split("\n")) {
    const at = line.indexOf(" ");
    const name = line.slice(at + 1).replace(/^refs\/heads\//, "");
    if (at > 0 && AGENT_BRANCH.test(name)) found[name] = line.slice(0, at);
  }
  return found;
};

/**
 * With `share` (the run's own fingerprint), the branches and the in-flight set are that one's, not a
 * fresh reading: a check that a landing makes while pipelines run must not take an agent's commits,
 * or a pipeline that ended meanwhile, for a branch that moved.
 */
export const gitFingerprint = (project: Project, share?: Pick<Fingerprint, "branches" | "flying">): Fingerprint => {
  const dir = commonDir(project.root);
  const inside = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).map((f) => join(dir, sub, f)) : []);
  // HEAD too: a sandbox that repoints it makes the host's landing merge commit on another branch,
  // while the base - and so the check - stays where it was.
  // Not info/refs: `git repack` rewrites it (an auto gc in a sandbox's commit does), it is only an
  // index for the dumb HTTP transport and runs nothing - fingerprinted, it read as tampering.
  // Not info/exclude either: ignore patterns only, nothing runs from it, and the kit never writes it,
  // but the host's own tools do (Claude Code adds its runtime block to it while a session in the
  // checkout schedules a wake-up) - fingerprinted, a person watching the run stopped it. Still watched:
  // info/attributes (maps paths to filter, merge and diff drivers), grafts, sparse-checkout, any new file.
  const unwatched = new Set([join(dir, "info", "refs"), join(dir, "info", "exclude")]);
  const info = inside("info").filter((f) => !unwatched.has(f));
  // config.worktree: the main worktree's config, which git reads on top of `config` once
  // `extensions.worktreeConfig` is on (a sandbox can turn that on in `config`, itself watched, but a file
  // already there waits for it). Listed only while it exists, so creating one, even an empty one, differs
  // from its absence, which an empty file's hash would not.
  const worktreeConfigPath = join(dir, "config.worktree");
  const paths = [join(dir, "config"), join(dir, "HEAD"), ...info, ...inside("hooks"), ...(existsSync(worktreeConfigPath) ? [worktreeConfigPath] : [])];
  const files: Record<string, string> = {};
  const hashOf = (f: string) => createHash("sha256").update(existsSync(f) ? readFileSync(f) : "").digest("hex");
  for (const f of paths) files[f] = hashOf(f);
  Object.assign(files, moduleFiles(join(dir, "modules"), hashOf));
  // The entries are read between two hashes of the file: one a sandbox rewrote meanwhile would
  // otherwise leave the entries newer than the hash, and the change would never be compared.
  const readEntries = (path: string): ConfigReading => {
    if (!(path in files)) return { path, entries: [] };
    let entries: string[] | null = null;
    for (let attempt = 0; attempt < 3 && !entries; attempt++) {
      try {
        const listed = sh("git", ["config", "--file", path, "-z", "--list"], project.root).split("\0").filter(Boolean);
        const again = hashOf(path);
        if (again === files[path]) entries = listed;
        else files[path] = again;
      } catch {
        break;
      }
    }
    return { path, entries };
  };
  const config = readEntries(join(dir, "config"));
  const worktreeConfig = readEntries(worktreeConfigPath);
  return {
    files,
    config,
    worktreeConfig,
    base: tipOf(project.root, `refs/heads/${project.baseBranch}`),
    branches: share?.branches ?? agentBranches(project.root),
    flying: share?.flying ?? new Set(),
  };
};

const changedFiles = (before: Fingerprint["files"], now: Fingerprint["files"]) =>
  [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((f) => before[f] !== now[f]).sort();

// What a change to `.git/config` is, told by key. A person's own work in another worktree of the
// repo (`git worktree add` from a remote branch, `git push -u`, `git branch -u`, `gh pr create`)
// gives a branch an upstream: `branch.<name>.remote` and `.merge`, which run no program. That alone,
// for a branch that is neither the base nor a ticket's, is benign. `rebase` and `pushRemote` are not
// listed (conservative, as the ticket decided), and neither is any other key: it stops the run.
// The values are held too: a remote is a plain name or `.` (a value with `:` or `/` is a URL or a
// path, and `ext::` runs a program), a merge is a ref. A key's values are compared as a list, in order.
const UPSTREAM_KEY = /^branch\.(.+)\.(remote|merge)$/;
const PLAIN_REMOTE = /^[A-Za-z0-9._-]+$/;

// Keys whose values are not shown: they run a program or load more config, and the value is the
// sandbox's to choose. The others show old and new (a URL's credentials hidden).
const COMMAND_KEY = new RegExp(`${COMMAND_KEYS}|^(core\\.(fsmonitor|hookspath)|include\\.path|includeif\\..+\\.path|alias\\..+)$`, "i");

// Keys whose values are not shown because they carry credentials: an `extraHeader` (an Authorization
// header), a credential helper's settings, and any key named for a password, token, secret or cookie
// (`sendemail.smtpPass`, a tool's `oauthtoken`). A key's name can carry a token too
// (`url.https://<token>@host/.insteadOf`), which `hidden` hides.
const SECRET_KEY = /^(http\.(.+\.)?extraheader|credential\..+)$|pass|token|secret|cookie/i;

// A URL's user and password, wherever it sits (a value, a key name), with or without a scheme
// (`url.<token>@host:.insteadOf`), and a token in a query string.
const hidden = (t: string) =>
  clean(t)
    .replace(/\/\/[^/@\s]*@/g, "//***@")
    .replace(/(^|[\s.])[^\s/@.:]+(:[^\s/@]*)?@/g, "$1***@")
    .replace(/([?&](?:access_token|token|auth|key|password|secret)=)[^&\s]+/gi, "$1***");

const shown = (value: string | null) => {
  if (value === null) return "(no value)";
  const text = hidden(value);
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}...` : text);
};

const configChange = (project: Project, before: Fingerprint["config"]["entries"], now: Fingerprint["config"]["entries"]) => {
  if (!before || !now) return { benign: [] as string[], words: ["it cannot be read as git config"] };
  // A key with no value (`[core] bare`, true) is not one with an empty value (`bare =`, false).
  const values = (entries: string[]) => {
    const by = new Map<string, (string | null)[]>();
    for (const e of entries) {
      const at = e.indexOf("\n");
      const key = at < 0 ? e : e.slice(0, at);
      by.set(key, [...(by.get(key) ?? []), at < 0 ? null : e.slice(at + 1)]);
    }
    return by;
  };
  const was = values(before);
  const is = values(now);
  const benign: string[] = [];
  const words: string[] = [];
  let allBenign = true;
  for (const key of [...new Set([...was.keys(), ...is.keys()])].sort()) {
    const old = was.get(key) ?? [];
    const next = is.get(key) ?? [];
    if (old.length === next.length && old.every((v, i) => v === next[i])) continue;
    const upstream = UPSTREAM_KEY.exec(key);
    const valid = next.every((v) => v !== null && (upstream?.[2] === "remote" ? PLAIN_REMOTE.test(v) : /^refs\/\S+$/.test(v)));
    if (upstream && upstream[1] !== project.baseBranch && !AGENT_BRANCH.test(upstream[1]) && valid) benign.push(key);
    else allBenign = false;
    const name = hidden(key);
    if (COMMAND_KEY.test(key) || SECRET_KEY.test(key)) words.push(`${name} ${!old.length ? "added" : !next.length ? "removed" : "changed"}`);
    else if (!old.length) words.push(`${name} added: ${next.map(shown).join(", ")}`);
    else if (!next.length) words.push(`${name} removed (was ${old.map(shown).join(", ")})`);
    else words.push(`${name}: ${old.map(shown).join(", ")} -> ${next.map(shown).join(", ")}`);
  }
  return { benign: allBenign ? benign : [], words };
};

// ---------------------------------------------------------------------------
// The start baseline. The pins and the fingerprint both take the shared `.git/config` as they find it
// when a run starts, so whatever a sandbox wrote there in a run that was killed before any check (Ctrl-C
// at the wrong moment, a crash, a machine asleep) would be that run's baseline and never reported.
// The program-running part of the config - the keys that make git run something, and `info/attributes`,
// which maps paths to them - is therefore recorded when a run starts and again when it ends cleanly, in
// the project's gitignored `.sandcastle/.run/`, and compared before anything is pinned: a difference
// from the previous run's record is a refusal, until a person says it is theirs.
// ---------------------------------------------------------------------------

// Every key that runs a program or loads more config. All of `filter.*` (its `required` decides whether
// a failing filter stops git), the other drivers and commands, and every `include` key.
const PROGRAM_KEYS = /^(filter\..+|merge\..+\.driver|diff\..+\.(textconv|command)|core\.(fsmonitor|hookspath|sshcommand)|include.*)$/i;

type ProgramConfig = { entries: string[]; attributes: string };
type BaselineRecord = ProgramConfig & { clean: boolean };

const baselineFile = (project: Project) => join(project.root, ".sandcastle", ".run", "git-config-baseline.json");

/** The shared `.git/config`'s program-running entries (`key\nvalue`, sorted) and the hash of `info/attributes` ("" when absent). */
const programConfig = (project: Project): ProgramConfig => {
  const dir = commonDir(project.root);
  let listed: string[];
  try {
    // `--file`: only this file, not the user's or the system's, which a sandbox cannot write.
    listed = existsSync(join(dir, "config")) ? sh("git", ["config", "--file", join(dir, "config"), "-z", "--list"], project.root).split("\0").filter(Boolean) : [];
  } catch (error) {
    throw new OperatorError(`NOT STARTED: git cannot read ${relative(realpathSync(project.root), join(dir, "config"))} as config, so the program-running keys a sandbox may have planted there cannot be checked. Inspect it before running any other git command there.`, { cause: error });
  }
  const attributes = join(dir, "info", "attributes");
  return {
    entries: listed.filter((e) => PROGRAM_KEYS.test(e.split("\n")[0])).sort(),
    attributes: existsSync(attributes) ? createHash("sha256").update(readFileSync(attributes)).digest("hex") : "",
  };
};

const readBaseline = (project: Project): BaselineRecord | undefined => {
  try {
    const record = JSON.parse(readFileSync(baselineFile(project), "utf8"));
    if (Array.isArray(record.entries) && record.entries.every((e: unknown) => typeof e === "string") && typeof record.attributes === "string") {
      return { entries: record.entries, attributes: record.attributes, clean: record.clean === true };
    }
  } catch {
    // No record, or one that cannot be read: the first run under this kit, as far as it can tell.
  }
  return undefined;
};

const writeBaseline = (project: Project, record: BaselineRecord) => {
  mkdirSync(dirname(baselineFile(project)), { recursive: true });
  writeFileSync(baselineFile(project), `${JSON.stringify(record, null, 2)}\n`);
};

/**
 * Before a run, `land` or `gates` pins anything: holds the shared `.git/config`'s program-running keys
 * and `info/attributes` to what the previous run recorded. A difference throws an `OperatorError` that
 * names each added, changed or removed key (no value for a key that runs a program, as the `.git` stop
 * says it) and how to go on: remove it, or `<command> --accept-git-config` when it is the operator's
 * own. No record (the first run under this kit) is no difference. A previous run that never ended
 * cleanly says so in the refusal, since a sandbox may have written the difference. Writes nothing:
 * `recordGitConfigStart` does, once the run holds its lock. Returns the state it read.
 */
export const assertGitConfigBaseline = (project: Project, command: string, accept = false): ProgramConfig => {
  const now = programConfig(project);
  const was = readBaseline(project);
  if (!was || accept) return now;
  const { words } = configChange(project, was.entries, now.entries);
  if (was.attributes !== now.attributes) words.push(`info/attributes ${!was.attributes ? "added" : !now.attributes ? "removed" : "changed"}`);
  if (!words.length) return now;
  const root = project.root;
  throw new OperatorError(
    `NOT STARTED: the shared .git/config holds program-running keys that differ from the ones the last run left: ${words.join("; ")}. ` +
      `${was.clean ? "Something wrote them between the runs." : "The last run did not end cleanly (it was killed, or stopped), so a sandbox may have written them."} ` +
      `Inspect \`git -C ${root} config --local --list\` and .git/info/attributes. Remove what is not yours (\`git -C ${root} config --local --unset-all <key>\`), ` +
      `or, if it is your own, start again with \`${command} --accept-git-config\`, which records the present state as the new baseline.`,
  );
};

/** Under the run lock: records what `assertGitConfigBaseline` read as the baseline of this run, not yet cleanly ended. */
export const recordGitConfigStart = (project: Project, state: ProgramConfig) => writeBaseline(project, { ...state, clean: false });

/**
 * At a run's clean end: marks the record clean when the config still holds what the run started
 * with. A key a sandbox wrote after the last check stays different from the record, so the next start
 * refuses it: the end never records a state it did not check.
 */
export const recordGitConfigEnd = (project: Project) => {
  const was = readBaseline(project);
  if (!was) return;
  const now = programConfig(project);
  if (now.attributes === was.attributes && now.entries.length === was.entries.length && now.entries.every((e, i) => e === was.entries[i])) writeBaseline(project, { ...was, clean: true });
};

// Names, subjects and paths are the sandbox's to choose: shown without
// control characters, so a planted subject cannot rewrite the terminal.
const clean = (t: string) => t.replace(/[\x00-\x1f\x7f]/g, "");

// ---------------------------------------------------------------------------
// The agent branches' second copy. A container can delete a branch no live worktree holds, and a
// `reflog expire` plus `gc --prune=now` there removes its commits for good, so the recorded tip
// alone cannot bring it back. A pipeline that ends hands its branch to a bare repo under
// `.sandcastle/`, which no sandbox mounts (Sandcastle mounts a sandbox's own worktree, the shared
// `.git` and the user's `mounts`; `test/backup-branches.test.ts` holds that), and a vanished
// branch is fetched back from it. Never bundles: a bundle is a file to keep in step, a ref in a
// repo is one fetch.
// ---------------------------------------------------------------------------

// Not under refs/heads: `restoreBranch` and the "no agent branch left" check read only branches.
const BASE_REF = "refs/base";

export const backupRepo = (project: Project) => join(project.root, ".sandcastle", "backup.git");

// `--git-dir` explicit: no discovery of the enclosing project (its config is the sandboxes' to
// write), and `safe.bareRepository=explicit` in a user's config does not refuse it.
// Background maintenance is off: a `fetch` ends by starting a detached `git maintenance run --auto`,
// and when a user's or runner's config makes that a `gc --auto`, it holds `gc.pid` while `dropBackup`
// runs its own `gc`, which then refuses ("gc is already running"), is swallowed there, and leaves the
// dropped work's pack beside the base's. Cruft packs are off too: the prune must leave one pack, not
// a second holding what it kept for a grace period.
const BACKUP_GIT_CONFIG = ["maintenance.auto=false", "gc.auto=0", "gc.autoDetach=false", "gc.cruftPacks=false"];
const backupGit = (project: Project, args: string[]) =>
  sh("git", [...BACKUP_GIT_CONFIG.flatMap((c) => ["-c", c]), "--git-dir", backupRepo(project), ...args], join(project.root, ".sandcastle"));

const backupTip = (project: Project, branch: string) => {
  if (!existsSync(join(backupRepo(project), "HEAD"))) return "";
  try {
    return backupGit(project, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  } catch {
    return "";
  }
};

/** Copy the branch's tip into the backup repo, creating it. Throws on a git failure: the caller says so and goes on. */
export const backupBranch = (project: Project, branch: string) => {
  const dir = backupRepo(project);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(join(project.root, ".sandcastle"), { recursive: true });
    sh("git", ["init", "--bare", "-q", dir], join(project.root, ".sandcastle"));
    // The project's `.sandcastle/.gitignore` may predate this directory, and an untracked repo in
    // the checkout would make `git status` dirty: the repo ignores itself.
    writeFileSync(join(dir, ".gitignore"), "*\n");
  }
  // The base branch rides along under `refs/base`: with no ref the backup advertises nothing as
  // already held, and every fetch sends the whole history as a pack of its own. It is a copy, not
  // an alternate: the backup must outlive a `gc --prune=now` in the shared `.git`, which an
  // alternates link would take its commits down with.
  backupGit(project, [
    "fetch", "-q", "--no-tags", "--no-write-fetch-head", project.root,
    `+refs/heads/${branch}:refs/heads/${branch}`,
    `+refs/heads/${project.baseBranch}:${BASE_REF}`,
  ]);
};

/**
 * Drop a branch's entry once its ticket has landed. Never throws: a failure leaves the entry
 * (and its objects) for the next drop, or for the next run's start, which `pruneBackup` sweeps.
 * With no agent branch left the backup is pruned (`gc --prune=now`, in the backup only, never the
 * shared `.git`): a deleted ref alone frees nothing, and every run's packs would stay for good.
 */
export const dropBackup = (project: Project, branch: string) => {
  try {
    if (backupTip(project, branch)) backupGit(project, ["update-ref", "-d", `refs/heads/${branch}`]);
    pruneWhenEmpty(project);
  } catch {
    /* the entry or its objects stay */
  }
};

const pruneWhenEmpty = (project: Project) => {
  if (existsSync(join(backupRepo(project), "HEAD")) && !backupGit(project, ["for-each-ref", "--count=1", "refs/heads/"])) backupGit(project, ["gc", "-q", "--prune=now"]);
};

/**
 * Drops the entry of each branch the kit never got to drop, because it did not land or clean it: a
 * held branch a person merged by hand, or one a person deleted. `dropBackup` runs only when the kit
 * lands a branch, so without this the backup's entries and objects only grow. An entry goes only when
 * its tip is already in the base (every commit it holds is on the base, so nothing is lost), whether
 * or not its branch still exists. An unmerged branch's entry stays even once the branch is gone: a
 * branch a killed run's sandbox deleted, or one a person deleted by mistake, has no other copy, and
 * the backup is there for exactly that. So does one the test cannot decide (a base that does not
 * exist, a tip git cannot compare). `goneToo` (`sandcastle clean --all`, which deletes unmerged
 * branches knowing their work is lost) also drops the entry of every branch that no longer exists.
 * Then `dropBackup`'s own prune runs when no entry is left. Returns the branches dropped. Never
 * throws: what a failure leaves stays for the next run. Call it only while holding the run lock.
 */
export const pruneBackup = (project: Project, { goneToo = false }: { goneToo?: boolean } = {}): string[] => {
  const dropped: string[] = [];
  if (!existsSync(join(backupRepo(project), "HEAD"))) return dropped;
  try {
    const root = project.root;
    const base = tipOf(root, `refs/heads/${project.baseBranch}`);
    for (const line of backupGit(project, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"]).split("\n").filter(Boolean)) {
      const at = line.indexOf(" ");
      const tip = line.slice(0, at);
      const branch = line.slice(at + 1).replace(/^refs\/heads\//, "");
      if (!(base && inBase(root, tip, base)) && !(goneToo && !tipOf(root, `refs/heads/${branch}`))) continue;
      try {
        backupGit(project, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
        dropped.push(branch);
      } catch {
        /* the entry stays */
      }
    }
    if (dropped.length) pruneWhenEmpty(project);
  } catch {
    /* the entries and their objects stay */
  }
  return dropped;
};

// Exit 1 is "not an ancestor", and 128 a commit the project's `.git` no longer holds (a branch
// rewritten since the copy): neither is a tip that is in the base, so the entry stays.
const inBase = (root: string, tip: string, base: string) => {
  try {
    sh("git", ["merge-base", "--is-ancestor", tip, base], root);
    return true;
  } catch {
    return false;
  }
};

const hasCommit = (root: string, sha: string) => {
  try {
    sh("git", ["cat-file", "-e", `${sha}^{commit}`], root);
    return true;
  } catch {
    return false;
  }
};

/**
 * A stop the `.git` guard raised. `what` is the cause in a few words (`main moved while sandboxes
 * ran`), which a skipped ticket's note and the stop's headline carry; `detail` is what a person
 * needs to see it for themselves (the commits, the files), after `what` in the headline only.
 */
export class GuardStop extends OperatorError {
  readonly what: string;
  readonly detail: string;
  constructor(message: string, words: { what: string; detail?: string }, options?: ErrorOptions) {
    super(message, options);
    this.what = words.what;
    this.detail = words.detail ?? "";
  }
}

/** Said of a stop whose error is not the guard's own, so no note names it wrongly. */
const UNNAMED = "the shared .git changed";

/** What a stop's error says changed: the guard's own words, or those of the error it wraps. */
export const guardWords = (error: unknown): { what: string; detail: string } => {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) if (e instanceof GuardStop) return { what: e.what, detail: e.detail };
  return { what: UNNAMED, detail: "" };
};

// Puts a vanished branch back where the run expected it, and says so. The copy in the backup repo
// first when it is that tip (the objects may be gone from the shared `.git`), then the recorded
// commit if it still resolves, then whatever the backup holds; no copy at all stops the run.
const restoreBranch = (project: Project, name: string, want: string, when: string): string => {
  const root = project.root;
  const ref = `refs/heads/${name}`;
  const kept = backupTip(project, name);
  // `--update-head-ok`: a ticket in flight has its worktree on this branch, which fetch refuses to update.
  const fromBackup = () => sh("git", ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--update-head-ok", backupRepo(project), `+${ref}:${ref}`], root);
  let source: string;
  if (kept && kept === want) {
    fromBackup();
    source = "the backup";
  } else if (hasCommit(root, want)) {
    sh("git", ["update-ref", ref, want, ""], root);
    source = "its recorded tip";
  } else if (kept) {
    fromBackup();
    source = "an older backup";
  } else {
    throw new GuardStop(
      `STOPPED ${when}: ${clean(name)} was deleted while sandboxes ran, and no copy of its commits survives (it was last at ${want.slice(0, 12)}, which the shared .git no longer holds, and ${relative(root, backupRepo(project))} has no entry). ` +
        `A sandbox may have deleted it and removed its commits.`,
      { what: `${clean(name)} was deleted while sandboxes ran, with no copy of its commits`, detail: `(it was last at ${want.slice(0, 12)})` },
    );
  }
  const tip = tipOf(root, ref);
  console.log(`${clean(name)} was deleted from the shared .git while sandboxes ran; restored from ${source} (${tip.slice(0, 12)}). A sandbox may have deleted it - the run goes on.`);
  return tip;
};

// A sandbox's worktree record names the worktree by its host path. `git worktree repair` run in a
// container rewrites it to the container path, and the host then cannot find that sandbox.
// Kit-made worktrees only (`agent-issue-*`, and `sandcastle-*` for a landing's scratch): a person's
// own worktrees live where they like.
const rewrittenWorktrees = (project: Project): string[] => {
  const records = join(commonDir(project.root), "worktrees");
  if (!existsSync(records)) return [];
  const under = [...new Set([project.root, realpathSync(project.root)])].map((r) => join(r, ".sandcastle", "worktrees") + sep);
  return readdirSync(records)
    .filter((name) => /^(agent-issue-|sandcastle-)/.test(name) && existsSync(join(records, name, "gitdir")))
    .filter((name) => {
      // `worktree.useRelativePaths` (git 2.48+) writes the path relative to the record's own
      // directory: read as it stands, every kit worktree would look rewritten.
      const at = resolve(join(records, name), readFileSync(join(records, name, "gitdir"), "utf8").trim());
      return !under.some((u) => at.startsWith(u));
    })
    .sort();
};

// The three are told apart. A changed config can run a command on the host's
// next git call, so nothing reads the repo after it. A moved base branch is
// more often a person's own commit (a ticket-file edit, a quick fix) than a
// sandbox's; the run cannot tell which, so it lands nothing - but it says
// what moved, instead of calling every commit tampering. An agent branch that vanished is
// restored (the work is the kit's and the copy is exact); one that moved while its ticket was not
// running is a stop.
export const assertGitUnchanged = (project: Project, before: Fingerprint, when: string) => {
  const now = gitFingerprint(project);
  const base = project.baseBranch;
  const root = project.root;
  let changed = changedFiles(before.files, now.files);
  let configWords: string[] = [];
  if (changed.includes(now.config.path)) {
    const { benign, words } = configChange(project, before.config.entries, now.config.entries);
    configWords = words;
    // No key differs but the bytes do (a comment, spacing, an order across keys): git reads the same
    // config, so nothing to say. Unreadable config (null entries) always has a word.
    if (benign.length || !words.length) {
      changed = changed.filter((f) => f !== now.config.path);
      // The new state is the run's expectation from here on, so the line is said once and a later
      // change is judged against it.
      before.files[now.config.path] = now.files[now.config.path];
      before.config = now.config;
    }
    if (benign.length) {
      console.log(`${benign.map(hidden).join(", ")} changed in the shared .git/config while sandboxes ran: an upstream for a branch that is neither ${base} nor a ticket's, which runs nothing (another worktree's own work, say) - the run goes on.`);
    }
  }
  // No benign key here: nothing a person's own work adds to a worktree's config is let through. An empty
  // file created or removed has no key to name, so the word says that.
  const worktreeWords = changed.includes(now.worktreeConfig.path)
    ? (() => {
        const { words } = configChange(project, before.worktreeConfig.entries, now.worktreeConfig.entries);
        if (words.length) return words;
        const had = before.worktreeConfig.path in before.files;
        const has = now.worktreeConfig.path in now.files;
        return [!had ? "created, with no key" : !has ? "removed" : "rewritten, with the same keys"];
      })()
    : [];
  if (changed.length) {
    const names = changed.map((f) => relative(realpathSync(root), f)).join(", ");
    const keys = changed.includes(now.config.path) && configWords.length ? ` In .git/config: ${configWords.join("; ")}.` : "";
    const worktreeKeys = changed.includes(now.worktreeConfig.path) ? ` In .git/config.worktree: ${worktreeWords.join("; ")}.` : "";
    throw new GuardStop(
      `STOPPED ${when}: ${names} changed while sandboxes ran. A sandbox may have tampered with the shared .git.${keys}${worktreeKeys} ` +
        `Inspect \`git -C ${root} config --local --list\` and .git/info/${worktreeKeys && ", and .git/config.worktree,"} before running any other git command there.`,
      { what: "the shared .git changed while sandboxes ran", detail: `(${names}${keys && `; ${configWords.join("; ")}`}${worktreeKeys && `; config.worktree: ${worktreeWords.join("; ")}`})` },
    );
  }
  const rewritten = rewrittenWorktrees(project);
  if (rewritten.length) {
    throw new GuardStop(
      `STOPPED ${when}: the worktree record of ${rewritten.join(", ")} no longer holds its host path under .sandcastle/worktrees/ (\`git worktree repair\` in a sandbox writes its container path). ` +
        `The host cannot find ${rewritten.length === 1 ? "that sandbox" : "those sandboxes"} now. Once nothing runs, \`git -C ${root} worktree repair <path>\` for each worktree under .sandcastle/worktrees/ puts the records right.`,
      { what: "a sandbox's worktree record was rewritten", detail: `(${rewritten.join(", ")})` },
    );
  }
  if (before.base && !now.base) {
    throw new GuardStop(
      `STOPPED ${when}: ${base} was deleted while sandboxes ran. It may be a person's doing, so the run lands nothing more. ` +
        `Put it back with \`git -C ${root} update-ref refs/heads/${base} ${before.base}\` (it fails if ${base} exists by then), then \`sandcastle run\` again.`,
      { what: `${base} was deleted while sandboxes ran` },
    );
  }
  if (now.base !== before.base) {
    // A moved base can leave its old tip unreachable after a gc: no log, but still the clean message.
    const lines = (args: string[]) => {
      try {
        return sh("git", args, root).split("\n").filter(Boolean).map(clean);
      } catch {
        return [];
      }
    };
    const range = `${before.base}..${now.base}`;
    const commits = lines(["log", "--format=%h by %cn, %cr: %s", "-5", range]);
    const files = lines(["diff", "--name-only", range]);
    const detail =
      `(${commits.join("; ") || `${before.base.slice(0, 7)} -> ${now.base.slice(0, 7)}, not a fast-forward`}` +
      `${files.length ? `; changes ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}` : ""})`;
    throw new GuardStop(
      `STOPPED ${when}: ${base} moved while sandboxes ran ${detail}. ` +
        `A run cannot tell a person's commit from a sandbox's, so it lands nothing more. Check the commits are yours - a sandbox can ` +
        `set any name - with \`git show --stat ${before.base.slice(0, 9)}..${now.base.slice(0, 9)}\`; if they are, \`sandcastle run\` again and each branch starts from where it stopped. ` +
        `If they are not, \`git -C ${root} update-ref refs/heads/${base} ${before.base} ${now.base}\` puts ${base} back (it fails if ${base} moved again).`,
      { what: `${base} moved while sandboxes ran`, detail },
    );
  }
  const moved: string[] = [];
  for (const [name, tip] of Object.entries(before.branches)) {
    const at = now.branches[name];
    if (at === undefined) before.branches[name] = restoreBranch(project, name, tip, when);
    else if (at !== tip && !before.flying.has(name)) moved.push(`${clean(name)} ${tip.slice(0, 12)} -> ${at.slice(0, 12)}`);
  }
  if (moved.length) {
    throw new GuardStop(
      `STOPPED ${when}: ${moved.join(", ")} moved while its ticket was not running. A sandbox may have rewritten another ticket's branch; nothing else touches a branch between its pipeline and its landing. ` +
        `The commit it had is still in the object store unless a gc ran: \`git -C ${root} update-ref refs/heads/<branch> <old tip>\` puts a branch back, and ${relative(root, backupRepo(project))} holds a copy of each branch a pipeline ended with.`,
      { what: "an agent branch moved while its ticket was not running", detail: `(${moved.join(", ")})` },
    );
  }
};

// ---------------------------------------------------------------------------
// The worktree records, and the check before a sandbox closes. A sandbox works in a linked worktree of the shared
// `.git`: the worktree's `.git` file names its record, `<common>/worktrees/<name>`, and the record's `commondir`
// names the directory whose config git reads (and `config.worktree` beside it, under `extensions.worktreeConfig`).
// The sandbox can write all three, and the host runs git in that worktree: Sandcastle's close (`git status`, then
// `git worktree remove`), Sandcastle's reuse of a kept worktree as the next sandbox opens (`git status`,
// `git fetch`, `git merge --ff-only`), and the pipeline's cut of a stale branch in a kept worktree. A record that
// names another common directory, or carries a `config.worktree`, has that git read config no check has seen, and a
// filter there runs on the host, past the pins. A kept worktree can be an earlier run's, whose change a fingerprint
// taken at this run's start would take as its baseline, so a record is held to what git itself writes, not compared
// with a reading.
// ---------------------------------------------------------------------------

/** What differs from what git writes in the records of the worktree at `path`, in a few words; undefined when nothing. */
const recordProblem = (project: Project, path: string): string | undefined => {
  const common = realpathSync(commonDir(project.root));
  const record = join(common, "worktrees", basename(path));
  const shown = relative(realpathSync(project.root), record) || record;
  const entry = (p: string) => lstatSync(p, { throwIfNoEntry: false });
  // A symlink in place of either directory has git read whatever it points at.
  if (!entry(join(common, "worktrees"))?.isDirectory() || !entry(record)?.isDirectory()) return `${shown} is not a directory`;
  const pointer = join(path, ".git");
  if (!entry(pointer)?.isFile()) return "the worktree's .git is not a file";
  // Git strips only the line ends; `worktree.useRelativePaths` (git 2.48+) writes the path relative to the worktree.
  const text = readFileSync(pointer, "utf8").replace(/[\r\n]+$/, "");
  if (!text.startsWith("gitdir: ")) return "the worktree's .git names no git directory";
  let named = "";
  try {
    named = realpathSync(resolve(path, text.slice("gitdir: ".length)));
  } catch {
    /* names nothing that exists */
  }
  const names = clean(text.slice("gitdir: ".length));
  if (named !== record) return `the worktree's .git names ${JSON.stringify(names.length > 200 ? `${names.slice(0, 200)}...` : names)}, not ${shown}`;
  // Git strips only the line end and reads what is left as a path relative to the record, so `../.. ` (a trailing
  // space) names a directory `.. ` the sandbox made there: compare as git reads it, never trimmed further. With no
  // file at all git takes the record itself for the common directory, and would read a `config` the sandbox put there.
  const commondir = join(record, "commondir");
  if (!entry(commondir)?.isFile() || readFileSync(commondir, "utf8").replace(/[\r\n]+$/, "") !== "../..") return `${shown}/commondir no longer names the shared .git (git writes ../..)`;
  if (entry(join(record, "config.worktree"))) return `${shown}/config.worktree exists, which git reads as that worktree's config`;
  return undefined;
};

/** Most entries a stop names: a tree full of them says no more. */
const NESTED_SHOWN = 5;

/**
 * The paths below the worktree's root, relative to it, of every `.git` entry (file, directory or link) other than the
 * root's own `.git`, in any case: a repository nested in the worktree. The tree is walked, never read through git, and no link is
 * followed. A found `.git` directory is not walked into.
 */
const nestedGit = (path: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // gone or unreadable: nothing git could read either
    }
    for (const name of names) {
      const at = rel ? `${rel}/${name}` : name;
      // Any case: on a case-insensitive disk (macOS's default) a host git opening `sub/.git` finds a `.GIT` a sandbox made.
      if (name.toLowerCase() === ".git") {
        if (rel) found.push(at);
        continue;
      }
      if (found.length >= NESTED_SHOWN) return;
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(join(dir, name), at);
    }
  };
  walk(path, "");
  return found;
};

/**
 * Holds the records of the worktree at `path` to what git writes (above): its `.git` file names
 * `<common>/worktrees/<name>`, that record's `commondir` is `../..`, and it has no `config.worktree`. A difference
 * throws a `GuardStop` naming it. So does a repository nested in the worktree (`nestedGit`): a host `git status` recurses
 * into a gitlink and reads that repository's own config and attributes, past the pins and the fingerprint. Before every
 * host git command in a sandbox's worktree.
 */
export const assertWorktreeRecords = (project: Project, path: string, when: string) => {
  const problem = recordProblem(project, path);
  const name = clean(basename(path));
  if (problem) {
    throw new GuardStop(
      `STOPPED ${when}: the worktree record of ${name} is not the one git wrote: ${problem}. A sandbox may have tampered with it, and a git command run in that worktree would read config no check has seen, so the kit runs none there. ` +
        `Inspect .git/worktrees/${name} and the worktree's .git file before running any git command in ${clean(path)}.`,
      { what: "a sandbox's worktree record was changed", detail: `(${name}: ${problem})` },
    );
  }
  const nested = nestedGit(path);
  if (!nested.length) return;
  const named = nested.map((p) => clean(p)).join(", ");
  throw new GuardStop(
    `STOPPED ${when}: ${named} in the worktree of ${name} ${nested.length === 1 ? "marks a git repository" : "mark git repositories"} nested in it. A host \`git status\` there looks into a nested repository and reads its own config and attributes, so a filter in it would run on the host; submodules are not supported in sandboxes. ` +
      `Inspect ${nested.length === 1 ? "it" : "them"} and remove ${nested.length === 1 ? "it" : "them"} (or the gitlink that points there) before running any git command in ${clean(path)}.`,
    { what: "a sandbox nested a git repository in its worktree", detail: `(${name}: ${named})` },
  );
};

/**
 * The check before a sandbox closes. Sandcastle's close stops the container, then runs `git status` on the host in its
 * worktree with this process's environment, so a filter planted in the shared `.git/config` (the pins hold only the
 * drivers configured at the start) or in config a changed record names would run there. The container is stopped
 * first (`stopSandboxContainer`), so nothing the sandbox left running writes after the check; one Docker cannot stop,
 * or gives no answer about in time (30 s; the stop's grace plus 30 s), fails it. `check` is the site's `.git` check; the worktree's records and any repository nested in it follow. On a failure the container is removed
 * here, without that close - the caller must not call it - the worktree is left as it stands for a person, and the
 * error is thrown.
 */
export const checkBeforeClose = async (project: Project, worktree: string, when: string, check: () => unknown): Promise<void> => {
  try {
    const [running] = await stopSandboxContainer(worktree).catch((e) => {
      if (!(e instanceof DockerAnswerError)) throw e;
      const name = clean(basename(worktree));
      const said = clean(e.message).slice(0, 200);
      throw new GuardStop(
        `STOPPED ${when}: Docker did not say whether the container of ${name} is stopped (${said}), so a process left running there could still write the shared .git after the check. ` +
          `Make sure no container of it runs (docker ps, docker rm -f), then inspect .git/config, .git/info/ and .git/worktrees/${name} before running any git command in ${clean(worktree)}.`,
        { what: "Docker gave no answer on a sandbox's container", detail: `(${name}: ${said})` },
        { cause: e },
      );
    });
    if (running) {
      const name = clean(basename(worktree));
      const said = clean(running.said).slice(0, 200);
      throw new GuardStop(
        `STOPPED ${when}: the container of ${name} could not be stopped (${said}), so a process left running there could still write the shared .git after the check. ` +
          `Make sure it is gone (docker rm -f ${running.id}), then inspect .git/config, .git/info/ and .git/worktrees/${name} before running any git command in ${clean(worktree)}.`,
        { what: "a sandbox's container could not be stopped", detail: `(${name}: ${said})` },
      );
    }
    await check();
    assertWorktreeRecords(project, worktree, when);
  } catch (error) {
    removeSandboxContainer(worktree);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// 3. What lands. A green branch that changes how the repo executes - hooks,
// CI, agent settings, install scripts - is never merged automatically: the
// gates ran the branch's own scripts, so they cannot vouch for it. It is left
// standing for a human merge.
// ---------------------------------------------------------------------------

const DEFAULT_PROTECTED = [
  ".husky/", ".githooks/", ".github/", ".gitmodules", ".gitattributes",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/",
  ".mcp.json", ".codex/", ".agents/", ".sandcastle/",
  ".npmrc", "pnpm-workspace.yaml", ".yarnrc.yml",
  ".lintstagedrc", "lint-staged.config.", ".pre-commit-config.yaml", "lefthook.yml",
];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"];

/** The files among `files` that lie in a protected path: the default set and the project's `protectedPaths`. */
export const protectedAmong = (project: Project, files: string[]): string[] => {
  const prefixes = [...DEFAULT_PROTECTED, ...(project.protectedPaths ?? [])];
  return files.filter((f) => prefixes.some((p) => f === p || f.startsWith(p)));
};

/**
 * The protected files a ticket body's `Touches:` line names, read against the base branch's tree.
 * A branch holds for these however good its work, so a ticket that declares one is warned about
 * before it costs a pipeline. Only a hint: the line is agent-written, and `package.json`'s
 * install scripts cannot be read from it.
 */
export const protectedTouches = (project: Project, body: string): string[] =>
  protectedAmong(project, expandTouches(project.root, project.baseBranch, parseTouches(body)));

/**
 * `protectedTouches`, and the protected files the ticket's kept branch `agent/issue-<id>` changes:
 * the paths a requeue's earlier hold was for, which the Touches line may never have named.
 */
export const protectedForTicket = (project: Project, id: string, body: string): string[] => {
  const paths = protectedTouches(project, body);
  const branch = `agent/issue-${id}`;
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], project.root);
    for (const p of protectedChanges(project, branch)) if (!paths.includes(p)) paths.push(p);
  } catch {
    // No branch, or an unreadable one: the Touches line alone.
  }
  return paths;
};

/** What `queue --lint` and `requeue` say of a ticket whose work lies in a protected path. */
export const protectedWarning = (paths: string[]) =>
  `will always be held; merge by hand: ${paths.join(", ")} is protected, so a run holds the branch for a person however good the work, and a re-run holds it again`;

/**
 * What the start of a run says of each ticket whose Touches line names a protected path: it still
 * runs, only its merge is a person's. A body with no Touches line reads no tree.
 */
export const protectedPlanLines = (project: Project, tickets: { id: string; body?: string }[], ref: (id: string) => string): string[] =>
  tickets.flatMap((t) => {
    const paths = parseTouches(t.body ?? "").length ? protectedTouches(project, t.body ?? "") : [];
    return paths.length ? [`${ref(t.id)} will be held for a person to merge (${paths.join(", ")})`] : [];
  });

export const protectedChanges = (project: Project, branch: string) => {
  const base = project.baseBranch;
  const changed = sh("git", ["diff", "--name-only", `${base}...${branch}`], project.root).split("\n").filter(Boolean);
  const hits = protectedAmong(project, changed);
  // package.json only when an install-time script changed.
  for (const f of changed.filter((f) => f === "package.json" || f.endsWith("/package.json"))) {
    const scripts = (ref: string) => {
      try {
        return JSON.parse(sh("git", ["show", `${ref}:${f}`], project.root)).scripts ?? {};
      } catch {
        return {};
      }
    };
    const [a, b] = [scripts(base), scripts(branch)];
    const moved = INSTALL_SCRIPTS.filter((s) => a[s] !== b[s]);
    if (moved.length) hits.push(`${f} (scripts: ${moved.join(", ")})`);
  }
  return hits;
};

// GitHub warns on a file over 50 MB and refuses a push with one over 100 MB, and a blob that size
// stays in the history for good. A branch that adds or grows one is held like a protected path.
const LARGE_BYTES = 50 * 1024 * 1024;
export const largeFiles = (project: Project, branch: string): string[] =>
  sh("git", ["diff", "--name-only", "--diff-filter=AM", `${project.baseBranch}...${branch}`], project.root)
    .split("\n")
    .filter(Boolean)
    .flatMap((f) => {
      const bytes = Number(sh("git", ["cat-file", "-s", `${branch}:${f}`], project.root));
      return bytes > LARGE_BYTES ? [`${f} (${Math.round(bytes / 1024 / 1024)} MB)`] : [];
    });

/** Why a large file needs a person, and what else to do with it. */
export const largeFilesNote = (files: string[]) =>
  `adds ${files.join(", ")}, over GitHub's 50 MB file warning (it refuses a push with a file over 100 MB), and a file that size stays in the history for good. Merge it by hand if it belongs in git; otherwise keep it out (Git LFS, or a step that downloads it)`;

// ---------------------------------------------------------------------------
// One run per project at a time: two would take the same queue, the same
// branches and merge into the same checkout.
// ---------------------------------------------------------------------------

// Held by this process: a second turn of one `sandcastle run` would otherwise find its own
// live pid in the lock and refuse.
const heldLocks = new Set<string>();

export const lockRun = (project: Project) => {
  const file = join(project.root, ".sandcastle/logs/run.lock");
  if (heldLocks.has(file)) return;
  // A project's first run has no logs/ yet - init does not create it.
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  const { mine, owner } = takeLock(file, project.name);
  if (!mine) {
    throw new OperatorError(
      owner
        ? `Another sandcastle run of this project is live (pid ${owner}). One run per project at a time: wait for it to end (\`sandcastle status\` shows it), or stop it with Ctrl-C in its terminal, then try again.`
        : "Another sandcastle run of this project is starting. One run per project at a time: try again once it has started (`sandcastle status` shows it).",
    );
  }
  heldLocks.add(file);
  process.on("exit", () => releaseLock(file, mine));
};
