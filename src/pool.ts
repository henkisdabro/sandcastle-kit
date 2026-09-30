// Machine-wide limits, shared by every sandcastle run on this machine, so two
// projects running at once cannot oversubscribe it.
//
//   sandboxes - live sandboxes across all runs. Agents mostly wait on the
//               model, so this caps memory and the draw on a shared plan
//               allowance more than CPU. Default 6.
//   gates     - gate runs (build, tests) at once across all runs. Gates are
//               the CPU-heavy part: 12 sandboxes gating together on a 15-core
//               machine once pushed load to 33 and starved a test run into a
//               false red. Default 2.
//
// Set in ~/.config/sandcastle-kit/config.json ({"maxSandboxes": 6, "maxGates": 2})
// or SANDCASTLE_MAX_SANDBOXES / SANDCASTLE_MAX_GATES. A project's CONCURRENCY
// still applies inside the machine-wide cap.
//
// A slot is a lock file holding the owner's pid, created with O_EXCL. A slot
// whose pid is gone is stale and taken over, so a killed run never leaks one.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USER_CONFIG } from "./sandbox.ts";

export type PoolName = "sandboxes" | "gates";

const DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "sandcastle-kit", "slots");

const settings = (() => {
  const file = join(USER_CONFIG, "config.json");
  const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    sandboxes: Number(process.env.SANDCASTLE_MAX_SANDBOXES ?? json.maxSandboxes ?? 6),
    gates: Number(process.env.SANDCASTLE_MAX_GATES ?? json.maxGates ?? 2),
  };
})();

export const limit = (pool: PoolName) => settings[pool];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const held = new Set<string>();
process.on("exit", () => {
  for (const f of held) {
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
});

const tryAcquire = (pool: PoolName, label: string): string | undefined => {
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < limit(pool); i++) {
    const file = join(DIR, `${pool}-${i}.lock`);
    try {
      writeFileSync(file, `${process.pid} ${label}\n`, { flag: "wx" });
      return file;
    } catch {
      const pid = Number(readFileSync(file, "utf8").split(" ")[0]);
      if (!alive(pid)) {
        try {
          unlinkSync(file); // stale - its run was killed
          writeFileSync(file, `${process.pid} ${label}\n`, { flag: "wx" });
          return file;
        } catch {
          /* another run took it first */
        }
      }
    }
  }
  return undefined;
};

/** Waits for a slot, runs `fn`, frees the slot. */
export const withSlot = async <T>(pool: PoolName, label: string, fn: () => Promise<T>): Promise<T> => {
  let file = tryAcquire(pool, label);
  if (!file) console.log(`  ${label}: waiting for a machine-wide ${pool} slot (${limit(pool)} in use)`);
  while (!file) {
    await new Promise((r) => setTimeout(r, 5000));
    file = tryAcquire(pool, label);
  }
  held.add(file);
  try {
    return await fn();
  } finally {
    held.delete(file);
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
};

/** "sandboxes 3/6 · gates 1/2" - live slots only; read by status.sh too. */
export const usage = () =>
  (["sandboxes", "gates"] as const)
    .map((pool) => {
      const used = existsSync(DIR)
        ? readdirSync(DIR).filter((f) => {
            if (!f.startsWith(`${pool}-`)) return false;
            const pid = Number(readFileSync(join(DIR, f), "utf8").split(" ")[0]);
            return alive(pid);
          }).length
        : 0;
      return `${pool} ${used}/${limit(pool)}`;
    })
    .join(" · ");
