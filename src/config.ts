// A project's `.sandcastle/config.ts`: everything that differs between repos.
// Everything else - default models, image base, orchestrator, prompts, status
// view - lives in this kit and is shared.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { configureModels, type Effort } from "./agents.ts";
import { detectFromDocs, resolveTracker, type Resolved, type TrackerConfig } from "./tracker.ts";
import { nearest, OperatorError } from "./errors.ts";
import { isClaudeSetting } from "./versions.ts";

/** Tickets at once when neither `CONCURRENCY` nor the project's `concurrency` says. */
export const DEFAULT_CONCURRENCY = 4;

export type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean };

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
   * Inside Herdr, whether a run opens a pane per sandbox: `"none"` (default) leaves the run's tab
   * with the status view alone and reports the run as one agent on it, `"all"` adds a pane per
   * concurrent sandbox. `SANDBOX_PANES` overrides it for one run.
   */
  herdr?: { panes?: "none" | "all" };
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
   * of the tickets that merged, grouped Added / Changed / Fixed. Default false.
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

export type Project = Required<Omit<ProjectConfig, "dockerfile" | "rules" | "protectedPaths" | "blockers" | "tracker" | "autonomy" | "claudeCode" | "herdr" | "pnpmStore" | "changelog">> &
  Pick<ProjectConfig, "dockerfile" | "rules" | "protectedPaths" | "blockers" | "autonomy" | "claudeCode" | "herdr" | "changelog"> & { root: string; tracker: Resolved };

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
const KEYS = ["name", "baseBranch", "tracker", "label", "concurrency", "herdr", "autonomy", "claudeCode", "dockerfile", "mounts", "setup", "pnpmStore", "lean", "gates",
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
  if (config.concurrency !== undefined && !isCount(config.concurrency, 1)) refuse(`\`concurrency\` must be a whole number of 1 or more, not ${JSON.stringify(config.concurrency)}.`);
  if (config.changelog !== undefined && typeof config.changelog !== "boolean") refuse(`\`changelog\` must be true or false, not ${JSON.stringify(config.changelog)}.`);
  if (config.autonomy !== undefined && ![0, 1, 2, 3, "drain"].includes(config.autonomy)) refuse(`\`autonomy\` must be 0, 1, 2, 3 or "drain", not ${JSON.stringify(config.autonomy)}.`);
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

export const loadProject = async (root = process.cwd()): Promise<Project> => {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) {
    throw new OperatorError(`No ${CONFIG_PATH} in ${root}. Run \`sandcastle init\` first.`);
  }
  // A syntax error reached the operator as a Node stack trace from the loader.
  let config: ProjectConfig;
  try {
    config = (await import(pathToFileURL(file).href)).default as ProjectConfig;
  } catch (error) {
    const said = String((error as Error).message ?? error).split("\n").filter((l) => l && !/^Transform failed/.test(l)).slice(0, 2).join(" ");
    throw new OperatorError(`${CONFIG_PATH} does not load: ${said.replace(/\S*\/\.sandcastle\/config\.ts/g, CONFIG_PATH)}`);
  }
  if (!config?.name || !config.gates?.length) {
    throw new OperatorError(`${CONFIG_PATH} must export default an object with \`name\` and at least one gate in \`gates\`.`);
  }
  checkShape(config);
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
      if (!mounts.some((m) => m.sandboxPath === PNPM_STORE_SANDBOX)) mounts = [...mounts, { hostPath: store, sandboxPath: PNPM_STORE_SANDBOX }];
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
