// A project's `.sandcastle/config.ts`: everything that differs between repos.
// Everything else - models, image base, orchestrator, prompts, status view -
// lives in this kit and is shared.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean };

export type ProjectConfig = {
  /** Names the project image (`sandcastle-<name>`) and labels the status view. */
  name: string;
  /** Branch agents branch from and green work merges into. Default `main`. */
  baseBranch?: string;
  /** The queue label. Default `ready-for-agent`. */
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
   * Extra path prefixes a branch may not change and still land automatically
   * (on top of hooks, CI, agent settings and install scripts - src/guard.ts).
   */
  protectedPaths?: string[];
  /** Markdown added to both prompts under "Project rules", relative to the repo root. */
  rules?: string;
  implement?: { maxIterations?: number; idleTimeoutSeconds?: number };
  review?: { maxIterations?: number; idleTimeoutSeconds?: number };
};

export type Project = Required<Omit<ProjectConfig, "dockerfile" | "rules" | "protectedPaths">> &
  Pick<ProjectConfig, "dockerfile" | "rules" | "protectedPaths"> & { root: string };

export const CONFIG_PATH = ".sandcastle/config.ts";

export const loadProject = async (root = process.cwd()): Promise<Project> => {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) {
    throw new Error(`No ${CONFIG_PATH} in ${root}. Run \`sandcastle init\` first.`);
  }
  const config = (await import(pathToFileURL(file).href)).default as ProjectConfig;
  if (!config?.name || !config.gates?.length) {
    throw new Error(`${CONFIG_PATH} must export default an object with \`name\` and \`gates\`.`);
  }
  return {
    root,
    baseBranch: "main",
    label: "ready-for-agent",
    concurrency: 4,
    mounts: [],
    setup: [],
    implement: {},
    review: {},
    ...config,
    lean: { keep: config.lean?.keep ?? [], dropHooks: config.lean?.dropHooks ?? [] },
  };
};
