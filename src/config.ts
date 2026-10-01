// A project's `.sandcastle/config.ts`: everything that differs between repos.
// Everything else - default models, image base, orchestrator, prompts, status
// view - lives in this kit and is shared.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configureModels, type Effort } from "./agents.ts";
import { detectFromDocs, resolveTracker, type Resolved, type TrackerConfig } from "./tracker.ts";
import { OperatorError } from "./errors.ts";

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
  /** Project image layer, relative to the repo root. Starts `ARG BASE` / `FROM ${BASE}`. */
  dockerfile?: string;
  /** Extra bind mounts, e.g. a package-manager store. */
  mounts?: Mount[];
  /** Commands run in each sandbox once it is up, e.g. dependency install. */
  setup?: string[];
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
   * What an issue may wait for besides a GitHub issue (`Blocked by #12`), named in its body.
   * `linear`: team keys, so `Blocked by ENG-42` is read from Linear (LINEAR_API_KEY, host only).
   * `files`: a directory of ticket files (default: the files tracker's), so
   * `Blocked by .scratch/checkout/issues/03-pay.md` waits until that file on the base branch has
   * a `Status:` line (or front-matter `status:`) in `done`. A blocker that cannot be read counts as open.
   */
  blockers?: { linear?: string[]; files?: { dir: string; done?: string[] } };
  /** Markdown added to both prompts under "Project rules", relative to the repo root. */
  rules?: string;
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

export type Project = Required<Omit<ProjectConfig, "dockerfile" | "rules" | "protectedPaths" | "blockers" | "tracker">> &
  Pick<ProjectConfig, "dockerfile" | "rules" | "protectedPaths" | "blockers"> & { root: string; tracker: Resolved };

export const CONFIG_PATH = ".sandcastle/config.ts";

export const loadProject = async (root = process.cwd()): Promise<Project> => {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) {
    throw new OperatorError(`No ${CONFIG_PATH} in ${root}. Run \`sandcastle init\` first.`);
  }
  const config = (await import(pathToFileURL(file).href)).default as ProjectConfig;
  if (!config?.name || !config.gates?.length) {
    throw new OperatorError(`${CONFIG_PATH} must export default an object with \`name\` and \`gates\`.`);
  }
  configureModels(config);
  return {
    root,
    baseBranch: "main",
    concurrency: 4,
    mounts: [],
    setup: [],
    implement: {},
    review: {},
    repair: {},
    hookTests: [],
    ...config,
    label: config.label ?? detectFromDocs(root).label ?? "ready-for-agent",
    tracker: resolveTracker(root, config.tracker),
    lean: { keep: config.lean?.keep ?? [], dropHooks: config.lean?.dropHooks ?? [] },
  };
};
