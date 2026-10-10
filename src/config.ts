// A project's `.sandcastle/config.ts`: everything that differs between repos.
// Everything else - default models, image base, orchestrator, prompts, status
// view - lives in this kit and is shared.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { configureModels, configureTools, type Effort } from "./agents.ts";
import { detectFromDocs, resolveTracker, type Resolved, type TrackerConfig } from "./tracker.ts";
import { CLAUDE_CODE_TOOLS, managedDenied, nearestTool } from "./claude-tools.ts";
import { nearest, OperatorError } from "./errors.ts";
import { isClaudeSetting } from "./versions.ts";

/** Tickets at once when neither `CONCURRENCY` nor the project's `concurrency` says. */
export const DEFAULT_CONCURRENCY = 4;

export type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean };

/** A `mounts` entry the loader refused; doctor tells it from other config errors to print it as a FIX. */
export class MountRefused extends OperatorError {}

// The path as Sandcastle will mount it (`~` expanded, a relative path from the working directory),
// with symlinks resolved on the longest part that exists, so a link into the project is no way around.
// `realpathSync.native` also gives the case the disk stores: the JS one keeps it as written, so on a
// case-insensitive disk (macOS) a mount written `.GIT` would not compare equal to `.git`.
const resolvedMountPath = (hostPath: string, from: string): string => {
  const expanded = hostPath === "~" ? homedir() : /^~[\\/]/.test(hostPath) ? join(homedir(), hostPath.slice(2)) : hostPath;
  const absolute = resolve(from, expanded);
  const tail: string[] = [];
  for (let dir = absolute; ; dir = dirname(dir)) {
    try {
      return join(realpathSync.native(dir), ...tail.reverse());
    } catch {
      if (dirname(dir) === dir) return absolute;
      tail.push(basename(dir));
    }
  }
};

// `..` as a whole segment, not a prefix: a project named `..app` is still inside its parent.
const within = (inner: string, outer: string) => {
  const rel = relative(outer, inner);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * Why a project mount may not be mounted, or undefined. A sandbox that could write the project root,
 * `.sandcastle/` or the shared `.git` could rewrite the run's own state: the start baseline, the
 * branch backup, the run lock. So a host path that equals or contains one of them, or lies inside
 * `.sandcastle/` or `.git`, is refused; anywhere else under the root (a cache directory) is fine.
 */
export const mountProblem = (root: string, mount: Mount): string | undefined => {
  const realRoot = resolvedMountPath(root, root);
  let gitDir: string | undefined;
  try {
    gitDir = resolvedMountPath(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), root);
  } catch {
    // Not a git repository (or no git): the root's own `.git` is the one a sandbox would see.
    gitDir = join(realRoot, ".git");
  }
  const guarded: [string, string][] = [["the project root", realRoot], [".sandcastle/", join(realRoot, ".sandcastle")], ["the shared .git", gitDir]];
  // Sandcastle resolves a relative path from the working directory, the kit's usual one is the root.
  for (const from of new Set([process.cwd(), root])) {
    const host = resolvedMountPath(mount.hostPath, from);
    for (const [what, path] of guarded) {
      if (within(path, host)) return `mounts ${JSON.stringify(mount.hostPath)} -> ${JSON.stringify(mount.sandboxPath)}: ${host === path ? "is" : "contains"} ${what} (${path}), which a sandbox must not be able to write.`;
      if (what !== "the project root" && within(host, path)) return `mounts ${JSON.stringify(mount.hostPath)} -> ${JSON.stringify(mount.sandboxPath)}: lies inside ${what} (${path}), which a sandbox must not be able to write.`;
    }
  }
  return undefined;
};

export type HookTest = { name: string; tool: string; input: Record<string, unknown>; expect: "block" | "allow" };

export type AgentConfig ={ model?: string; effort?: Effort; maxIterations?: number; idleTimeoutSeconds?: number };

export type ProjectConfig = {
  /** Names the project image (`sandcastle-<name>`) and labels the status view. */
  name: string;
  /** Branch agents branch from and green work merges into. Default `main`. */
  baseBranch?: string;
  /**
   * Where tickets live: `"github"` or `"files"` (or `{ type: "files", dir, done }` for a
   * directory other than `.scratch` and done-statuses other than done, closed, resolved,
   * wontfix). Unset, the kit reads docs/agents/issue-tracker.md (Matt Pocock's
   * setup skill writes it) and otherwise uses GitHub.
   */
  tracker?: TrackerConfig;
  /**
   * The queue label (GitHub) or `Status:` value (files). Default: the string
   * docs/agents/triage-labels.md maps `ready-for-agent` to, else `ready-for-agent`.
   */
  label?: string;
  /** Parallel sandboxes. Default 4. */
  concurrency?: number;
  /**
   * CPUs each sandbox container may use (`docker run --cpus`), its own test runs and a gate in it
   * alike, 0.01 or more (docker refuses less) and cut to the VM's CPUs. Unset: a ticket's sandbox gets
   * the VM's CPUs divided by the run's concurrency, a landing, base or verify gate's divided by
   * `maxGates`, each at least 2. `false`: no limit.
   */
  cpus?: number | false;
  /**
   * Inside Herdr, whether a run opens a pane per sandbox: `"none"` (default) leaves the run's tab
   * with the status view alone and reports the run as one agent on it, `"all"` adds a pane per
   * concurrent sandbox. `SANDBOX_PANES` overrides it for one run.
   */
  herdr?: { panes?: "none" | "all" };
  /**
   * Plan usage, in percent (1 to 100), at which a run pauses itself: when the 5-hour or the weekly window of a
   * provider the run uses reaches it, or an agent hits the limit anyway, the run takes the soft pause of
   * `sandcastle pause` and resumes by itself a minute after that window's reset. Unset: no pause, and a
   * limit an agent hits stops the queue. `USAGE_PAUSE` overrides it for one run.
   */
  usagePause?: number;
  /** Automatic re-runs in one `sandcastle run`: 0 none (default), 1 ask first, 2 one re-run, 3 up to two, "drain" until the queue is drained or a stop condition holds; `AUTONOMY_LEVEL` overrides it for one run. */
  autonomy?: 0 | 1 | 2 | 3 | "drain";
  /**
   * Which Claude Code the sandbox image installs: `"stable"` (default) or `"latest"`, the release
   * channels resolved on the host when the image is ensured, or an exact version such as `"2.1.285"`
   * to pin. The `CLAUDE_CODE_VERSION` env var overrides it for one command.
   */
  claudeCode?: "latest" | "stable" | (string & {});
  /** Project image layer, relative to the repo root. Starts `ARG BASE` / `FROM ${BASE}`. */
  dockerfile?: string;
  /** Extra bind mounts, e.g. a package-manager store. */
  mounts?: Mount[];
  /** Commands run in each sandbox once it is up, e.g. dependency install. */
  setup?: string[];
  /**
   * `true`: mount the host's pnpm store-dir (the parent of `pnpm store path`, asked of the host's
   * pnpm before each command) at `/home/agent/.pnpm-store` and point the sandbox's pnpm at it before `setup`, so
   * each sandbox's install hardlinks instead of downloading. The config holds no host path. Without
   * pnpm on the host the mount is skipped, with a note.
   */
  pnpmStore?: boolean;
  /**
   * Sandboxes load none of the repo's skills, agents, commands, MCP servers or
   * plugins unless `keep` names them (ids in src/lean.ts). Hooks are the
   * opposite: every hook in .claude/settings.json is kept, and `dropHooks`
   * removes those whose command contains one of its strings - host-only
   * conveniences, never guards. `sandcastle lean` shows both.
   */
  lean?: { keep?: string[]; dropHooks?: string[] };
  /** Run by the orchestrator after both agents, in order, stopping at the first red. */
  gates: { name: string; command: string }[];
  /**
   * Proof that the kept PreToolUse guards fire. Each test hands every kept
   * PreToolUse hook whose matcher takes `tool` a made-up call, in the base-gate
   * sandbox after setup, and expects at least one to block it (`block`) or
   * none to (`allow`). Nothing is written: the hook only sees the call.
   */
  hookTests?: HookTest[];
  /**
   * Extra path prefixes a branch may not change and still land automatically
   * (on top of hooks, CI, agent settings and install scripts - src/guard.ts).
   */
  protectedPaths?: string[];
  /**
   * How a green branch lands on the base branch. `merge` (default): a merge commit, the branch's
   * own commits kept. `squash`: one commit holding the branch's whole change, with the same
   * subject; the branch is deleted once landed. `sandcastle land` and a regenerating landing follow it too.
   */
  land?: "merge" | "squash";
  /**
   * Committed files a command writes (a minified stylesheet, a data file built from JSON). A merge
   * conflict confined to these paths is resolved by taking either side and running `regen` in the
   * sandbox, then committing; any other conflicting file still conflicts. A path is a file, or a
   * directory (with or without a trailing `/`) covering everything under it.
   */
  generated?: { paths: string[]; regen: string }[];
  /**
   * What an issue may wait for besides a GitHub issue (`Blocked by #12`), named in its body.
   * `linear`: team keys, so `Blocked by ENG-42` is read from Linear (LINEAR_API_KEY, host only).
   * `files`: a directory of ticket files (default: the files tracker's), so
   * `Blocked by .scratch/checkout/issues/03-pay.md` waits until that file on the base branch has
   * a `Status:` line (or front-matter `status:`) in `done`. A blocker that cannot be read counts as open.
   */
  blockers?: { linear?: string[]; files?: { dir: string; done?: string[] } };
  /** Markdown added to the implement, review and repair prompts under "Project rules", relative to the repo root. */
  rules?: string;
  /**
   * For a project whose rules keep agents out of its changelog: the implement and review prompts
   * ask for each changelog line in a `<changelog>` tag, and the closing summary gathers the lines
   * of the tickets that merged, grouped Added / Changed / Fixed, and any Upgrading line apart. Default false.
   */
  changelog?: boolean;
  /**
   * `model` and `effort` replace the kit's defaults for this project; the
   * IMPL_* / REVIEW_* env vars still override them for one run. Repair uses
   * the implementer's model and effort.
   */
  implement?: AgentConfig;
  review?: AgentConfig;
  /**
   * Passes the implementer's model gets to fix a red gate, fed that gate's
   * output, on the same sandbox. Default 1; 0 leaves a red branch as it is.
   */
  repair?: { attempts?: number; maxIterations?: number; idleTimeoutSeconds?: number };
};

export type Project = Required<Omit<ProjectConfig, "dockerfile" | "rules" | "protectedPaths" | "blockers" | "tracker" | "autonomy" | "claudeCode" | "herdr" | "pnpmStore" | "changelog" | "cpus" | "usagePause">> &
  Pick<ProjectConfig, "dockerfile" | "rules" | "protectedPaths" | "blockers" | "autonomy" | "claudeCode" | "herdr" | "changelog" | "cpus" | "usagePause"> & { root: string; tracker: Resolved };

export const CONFIG_PATH = ".sandcastle/config.ts";

export const PNPM_STORE_SANDBOX = "/home/agent/.pnpm-store";
export const PNPM_STORE_SETUP = `pnpm config set store-dir ${PNPM_STORE_SANDBOX}`;

/**
 * The host's pnpm store-dir, or undefined when pnpm is not on the host (or cannot say).
 * `pnpm store path` prints the versioned directory (`<store-dir>/v11`), and pnpm adds its own
 * version segment to any `store-dir` it is given: mounting the versioned path would make the
 * sandbox's store `<store-dir>/v11/v11`, a second store nested in the host's that no install of
 * the host ever fills. The parent is what the sandbox's `store-dir` must be, so its `<mount>/vN`
 * is the host's own store when the pnpm majors match (another major gets its own `vN` beside it).
 */
export const hostPnpmStore = (root: string): string | undefined => {
  let versioned: string;
  try {
    versioned = execFileSync("pnpm", ["store", "path"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim();
  } catch {
    return undefined;
  }
  if (!versioned) return undefined;
  // A path with no `vN` last segment is not one pnpm would add a segment to: mount it as it is.
  return /^v\d+$/.test(basename(versioned)) ? dirname(versioned) : versioned;
};

// Every key a config may hold, and those of its nested objects. An unknown one - a typo such as
// `concurency` - was ignored without a word, and the run went on with the default.
const KEYS = ["name", "baseBranch", "tracker", "label", "concurrency", "cpus", "herdr", "autonomy", "usagePause", "claudeCode", "dockerfile", "mounts", "setup", "pnpmStore", "lean", "gates",
  "hookTests", "protectedPaths", "land", "generated", "blockers", "rules", "changelog", "implement", "review", "repair"];
const NESTED: Record<string, string[]> = {
  lean: ["keep", "dropHooks"],
  implement: ["model", "effort", "maxIterations", "idleTimeoutSeconds"],
  review: ["model", "effort", "maxIterations", "idleTimeoutSeconds"],
  repair: ["attempts", "maxIterations", "idleTimeoutSeconds"],
  blockers: ["linear", "files"],
  herdr: ["panes"],
};

const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isCount = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;

/** Unknown keys and wrong types, refused with the key and what it takes, before anything runs. */
const checkShape = (config: ProjectConfig) => {
  const refuse = (what: string) => {
    throw new OperatorError(`${CONFIG_PATH}: ${what}`);
  };
  const unknown = (keys: string[], known: string[], at: string) => {
    for (const k of keys) {
      if (known.includes(k)) continue;
      const near = nearest(k, known);
      refuse(`unknown key \`${at}${k}\`${near ? ` - did you mean \`${at}${near}\`?` : ` (README -> Configuration lists the keys)`}`);
    }
  };
  unknown(Object.keys(config), KEYS, "");
  const c = config as Record<string, unknown>;
  for (const [key, known] of Object.entries(NESTED)) {
    if (c[key] === undefined) continue;
    if (typeof c[key] !== "object" || c[key] === null || Array.isArray(c[key])) refuse(`\`${key}\` must be an object ({ ${known.join(", ")} }).`);
    unknown(Object.keys(c[key] as object), known, `${key}.`);
  }
  for (const key of ["name", "baseBranch", "label", "dockerfile", "rules"]) {
    if (c[key] !== undefined && (typeof c[key] !== "string" || !c[key])) refuse(`\`${key}\` must be a non-empty string, not ${JSON.stringify(c[key])}.`);
  }
  for (const key of ["setup", "protectedPaths"]) if (c[key] !== undefined && !isStrings(c[key])) refuse(`\`${key}\` must be a list of strings, such as ["${key === "setup" ? "pnpm install" : ".github/"}"].`);
  for (const key of ["keep", "dropHooks"] as const) if (config.lean?.[key] !== undefined && !isStrings(config.lean[key])) refuse(`\`lean.${key}\` must be a list of strings.`);
  for (const entry of config.lean?.keep ?? []) {
    if (!entry.startsWith("tool:")) continue;
    const name = entry.slice("tool:".length);
    // Denied before misspelt: a denied name is a real tool, so the spelling is not what to fix.
    if (managedDenied().includes(name)) refuse(`\`lean.keep\` entry \`${entry}\`: the managed settings deny ${name} in every sandbox, so it could never be used.`);
    if (!CLAUDE_CODE_TOOLS.includes(name)) refuse(`\`lean.keep\` entry \`${entry}\` names no built-in Claude Code tool, and Claude Code would ignore it silently - did you mean \`tool:${nearestTool(name)}\`?`);
  }
  if (config.concurrency !== undefined && !isCount(config.concurrency, 1)) refuse(`\`concurrency\` must be a whole number of 1 or more, not ${JSON.stringify(config.concurrency)}.`);
  if (config.cpus !== undefined && config.cpus !== false && !(typeof config.cpus === "number" && Number.isFinite(config.cpus) && config.cpus >= 0.01)) {
    // docker's own range is 0.01 up to the VM's CPUs: below it `docker run --cpus` is refused, and no sandbox starts.
    refuse(`\`cpus\` must be a number of 0.01 or more (CPUs per sandbox) or false (no limit), not ${JSON.stringify(config.cpus)}.`);
  }
  if (config.changelog !== undefined && typeof config.changelog !== "boolean") refuse(`\`changelog\` must be true or false, not ${JSON.stringify(config.changelog)}.`);
  if (config.autonomy !== undefined && ![0, 1, 2, 3, "drain"].includes(config.autonomy)) refuse(`\`autonomy\` must be 0, 1, 2, 3 or "drain", not ${JSON.stringify(config.autonomy)}.`);
  if (config.usagePause !== undefined && !(typeof config.usagePause === "number" && config.usagePause >= 1 && config.usagePause <= 100)) {
    refuse(`\`usagePause\` must be a number from 1 to 100 (the percent of a plan window at which a run pauses), not ${JSON.stringify(config.usagePause)}.`);
  }
  if (config.herdr?.panes !== undefined && config.herdr.panes !== "none" && config.herdr.panes !== "all") {
    refuse(`\`herdr.panes\` must be "none" or "all", not ${JSON.stringify(config.herdr.panes)}.`);
  }
  if (config.repair?.attempts !== undefined && !isCount(config.repair.attempts, 0)) refuse(`\`repair.attempts\` must be a whole number of 0 or more (0 turns repair off), not ${JSON.stringify(config.repair.attempts)}.`);
  if (!Array.isArray(config.gates) || config.gates.some((g) => typeof g?.name !== "string" || !g.name || typeof g.command !== "string" || !g.command)) {
    refuse("each gate needs a `name` and a `command`, both strings: { name: \"test\", command: \"pnpm test\" }.");
  }
  if (config.pnpmStore !== undefined && typeof config.pnpmStore !== "boolean") refuse(`\`pnpmStore\` must be true or false, not ${JSON.stringify(config.pnpmStore)}.`);
  if (config.mounts !== undefined && (!Array.isArray(config.mounts) || config.mounts.some((m) => typeof m?.hostPath !== "string" || typeof m.sandboxPath !== "string"))) {
    refuse("each mount needs a `hostPath` and a `sandboxPath`, both strings.");
  }
};

// Node gives a syntax error's place only in the head of its stack - the file and line, the source
// line, then a caret under the column - so the message alone left the operator searching the file.
const syntaxErrorPlace = (error: unknown): string | undefined => {
  if (!(error instanceof SyntaxError)) return undefined;
  const [head, , caret] = (error.stack ?? "").split("\n");
  const line = head?.match(/\/\.sandcastle\/config\.ts:(\d+)$/)?.[1];
  const column = caret?.indexOf("^") ?? -1;
  return line && column >= 0 ? `${CONFIG_PATH}:${line}:${column + 1}` : undefined;
};

// Node takes a `.ts` file's module type from the nearest package.json, so a project whose
// package.json says "type": "commonjs" failed on its config's `export default`. The config is
// always an ES module, whatever the project around it says.
let configIsEsm = false;
const loadConfigAsEsm = () => {
  if (configIsEsm) return;
  configIsEsm = true;
  registerHooks({
    load: (url, context, nextLoad) => nextLoad(url, url.startsWith("file:") && new URL(url).pathname.endsWith(`/${CONFIG_PATH}`) ? { ...context, format: "module-typescript" } : context),
  });
};

/** A config file's default export, imported as the kit imports every project's: always an ES module. */
export const importConfig = async (file: string): Promise<ProjectConfig> => {
  loadConfigAsEsm();
  return (await import(pathToFileURL(file).href)).default as ProjectConfig;
};

export const loadProject = async (root = process.cwd()): Promise<Project> => {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) {
    throw new OperatorError(`No ${CONFIG_PATH} in ${root}. Run \`sandcastle init\` first.`);
  }
  // A syntax error reached the operator as a Node stack trace from the loader.
  let config: ProjectConfig;
  try {
    config = await importConfig(file);
  } catch (error) {
    const said = String((error as Error).message ?? error).split("\n").filter(Boolean).slice(0, 2).join(" ");
    const place = syntaxErrorPlace(error);
    throw new OperatorError(`${CONFIG_PATH} does not load: ${place ? `${place}: ERROR: ` : ""}${said.replace(/\S*\/\.sandcastle\/config\.ts/g, CONFIG_PATH)}`);
  }
  if (!config?.name || !config.gates?.length) {
    throw new OperatorError(`${CONFIG_PATH} must export default an object with \`name\` and at least one gate in \`gates\`.`);
  }
  checkShape(config);
  for (const m of config.mounts ?? []) {
    const problem = mountProblem(root, m);
    if (problem) throw new MountRefused(`${CONFIG_PATH}: ${problem}`);
  }
  if (config.land !== undefined && config.land !== "merge" && config.land !== "squash") {
    throw new OperatorError(`${CONFIG_PATH}: land must be "merge" or "squash", not ${JSON.stringify(config.land)}.`);
  }
  if (config.claudeCode !== undefined && !isClaudeSetting(config.claudeCode)) {
    throw new OperatorError(
      `${CONFIG_PATH}: claudeCode must be "latest", "stable" or a version like "2.1.285", not ${JSON.stringify(config.claudeCode)}.`,
    );
  }
  const generated = config.generated ?? [];
  if (
    !Array.isArray(generated) ||
    generated.some(
      (g) =>
        !Array.isArray(g?.paths) ||
        !g.paths.length ||
        g.paths.some((p) => typeof p !== "string" || !p) ||
        typeof g.regen !== "string" ||
        !g.regen,
    )
  ) {
    throw new OperatorError(
      `${CONFIG_PATH}: each \`generated\` entry needs \`paths\` (files, or directories) and \`regen\` (the command that writes them).`,
    );
  }
  configureModels(config);
  configureTools(config.lean?.keep ?? []);
  // Resolved here, on the host, so the committed config holds no path that exists on one machine
  // only. A literal mount of the same sandbox path (a config from before the key) wins: Docker
  // refuses two mounts at one path.
  let mounts = config.mounts ?? [];
  let setup = config.setup ?? [];
  if (config.pnpmStore) {
    const store = hostPnpmStore(root);
    if (!store) {
      console.warn("pnpmStore is set but pnpm is not on this host (`pnpm store path` failed): no store mounted, each sandbox's install downloads.");
    } else {
      if (!mounts.some((m) => m.sandboxPath === PNPM_STORE_SANDBOX)) {
        // A project `.npmrc` store-dir can point at the root, `.sandcastle/` or `.git`: the same check as a literal mount.
        const mount = { hostPath: store, sandboxPath: PNPM_STORE_SANDBOX };
        const problem = mountProblem(root, mount);
        if (problem) throw new MountRefused(`${CONFIG_PATH}: pnpmStore (\`pnpm store path\`): ${problem}`);
        mounts = [...mounts, mount];
      }
      if (!setup.includes(PNPM_STORE_SETUP)) setup = [PNPM_STORE_SETUP, ...setup];
    }
  }
  return {
    root,
    baseBranch: "main",
    concurrency: DEFAULT_CONCURRENCY,
    land: "merge",
    implement: {},
    review: {},
    repair: {},
    hookTests: [],
    ...config,
    mounts,
    setup,
    // Defaults to [] when unset; a leading ./ is stripped so a path compares equal to git's.
    generated: generated.map((g) => ({ ...g, paths: g.paths.map((p) => p.replace(/^\.\//, "")) })),
    label: config.label ?? detectFromDocs(root).labels?.["ready-for-agent"] ??"ready-for-agent",
    tracker: resolveTracker(root, config.tracker),
    lean: { keep: config.lean?.keep ?? [], dropHooks: config.lean?.dropHooks ?? [] },
  };
};
