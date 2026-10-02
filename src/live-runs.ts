// Live runs, one file per project holding its root, so the Herdr tab bar can show every run on
// the machine whichever pane has focus, and the Claude Code mod can find a run its session
// started in another directory. Written by the run itself (burndown.ts), with or without Herdr.
// A run that dies without its exit handler leaves its file; readers check the run's pid and drop it.

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `||`, not `??`: an empty XDG_CACHE_HOME is unset (the XDG rule, and the mod's shell reads it so).
export const RUNS_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sandcastle-kit", "runs");

/** The root with symlinks resolved (macOS: `/tmp` is `/private/tmp`), or as given when it cannot be. */
const real = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/** Named by the resolved root, so one project reached by two paths has one file. */
export const runFile = (root: string, dir = RUNS_DIR) => join(dir, createHash("sha1").update(real(root)).digest("hex").slice(0, 12));

const registered = new Set<string>();

/**
 * Registers this process's run of `root` and removes the file when the process exits. The file
 * holds the root as given: the tab bar compares it with the cwd Herdr reports. Once per file: an
 * autonomy run's next turn is the same process and the same run. Best effort - a cache directory
 * that cannot be written must not stop a run.
 */
export const registerRun = (root: string, dir = RUNS_DIR): void => {
  const file = runFile(root, dir);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, root);
  } catch {
    return;
  }
  if (registered.has(file)) return;
  registered.add(file);
  process.on("exit", () => rmSync(file, { force: true }));
};
