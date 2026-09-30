// sandcastle <command> - run from anywhere inside a project's git repository.
//
//   doctor           check this machine and (inside a repo) this project are
//                    set up; prints what is missing and how to fix it
//   run              burn down the queue: build images if stale, preflight,
//                    open the status pane (Herdr), implement/review/gate/merge
//   status [s] [collapse]   the live status view (refresh every s seconds, 0 = once)
//   build [--force]  build the base and project images
//   preflight        one reply from every model, nothing else
//   lean [--measure] what the repo's skills, agents, MCP servers and plugins
//                    would cost each sandbox, which hooks are kept and whether
//                    they can run in the image; --measure runs one real turn
//                    with and without the extras
//   init             scaffold .sandcastle/config.ts and rules.md, then the lean check
//
// Models, effort, ISSUES, CONCURRENCY, DRY_RUN, CROSS_REVIEW, SKIP_PREFLIGHT:
// environment variables, see README.md.

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { burndown } from "./burndown.ts";
import { CONFIG_PATH, loadProject } from "./config.ts";
import { apply as leanApply, checkHooks, measure as leanMeasure, plan as leanPlan, report as leanReport, reportHookCheck } from "./lean.ts";
import { limit } from "./pool.ts";
import { preflight } from "./run.ts";
import { ensureImage, KIT, sh } from "./sandbox.ts";
import { lockWorktree } from "./worktree-lock.ts";
import { doctor } from "./doctor.ts";

const [command = "help", ...args] = process.argv.slice(2);

// `doctor` also works outside a repository (fresh install).
const repoRoot = (() => {
  try {
    return sh("git", ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
})();
if (command === "doctor") {
  await doctor(repoRoot);
  process.exit(0);
}
if (command === "help" || command === "--help" || command === "-h") {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (!repoRoot) throw new Error("Not inside a git repository. Run sandcastle from inside the project you want it to work on.");
// Sandcastle resolves worktrees and logs from the working directory, so every
// command runs from the repository root, wherever it was typed.
const root = repoRoot;
process.chdir(root);

switch (command) {
  case "run": {
    await burndown(await loadProject(root));
    break;
  }
  case "status": {
    const project = await loadProject(root);
    const r = spawnSync(join(KIT, "status.sh"), args, {
      stdio: "inherit",
      env: {
        ...process.env,
        SANDCASTLE_PROJECT: root,
        SANDCASTLE_NAME: project.name,
        SANDCASTLE_LABEL: project.label,
        SANDCASTLE_BASE: project.baseBranch,
        SANDCASTLE_MAX_SANDBOXES: String(limit("sandboxes")),
        SANDCASTLE_MAX_GATES: String(limit("gates")),
      },
    });
    process.exit(r.status ?? 0);
  }
  case "build": {
    console.log(ensureImage(await loadProject(root), args.includes("--force")));
    break;
  }
  case "preflight": {
    const project = await loadProject(root);
    preflight(project, ensureImage(project));
    break;
  }
  case "lean": {
    const project = await loadProject(root);
    const p = leanPlan(project);
    leanReport(project, p);
    const image = ensureImage(project);
    reportHookCheck(checkHooks(project, image, p), p.hooks.length);
    if (args.includes("--measure")) leanMeasure(project, image, p);
    break;
  }
  case "lean-apply": {
    // Internal: the worktree hook. `root` is the fresh worktree here. Locked
    // straight away: Sandcastle's own setup (the dependency install) runs for
    // minutes before the pipeline gets the worktree, and an unlocked worktree
    // can be pruned by another sandbox meanwhile.
    leanApply(JSON.parse(readFileSync(args[0], "utf8")), root);
    lockWorktree(root);
    break;
  }
  case "init": {
    if (existsSync(CONFIG_PATH)) throw new Error(`${CONFIG_PATH} already exists.`);
    mkdirSync(".sandcastle", { recursive: true });
    copyFileSync(join(KIT, "templates/config.ts"), CONFIG_PATH);
    if (!existsSync(".sandcastle/rules.md")) copyFileSync(join(KIT, "templates/rules.md"), ".sandcastle/rules.md");
    // Sandcastle's working files never belong in the repo.
    const ignore = ".sandcastle/.gitignore";
    const want = [".env", "logs/", "worktrees/", ".run/"];
    const have = existsSync(ignore) ? readFileSync(ignore, "utf8").split("\n") : [];
    const add = want.filter((w) => !have.includes(w));
    if (add.length) appendFileSync(ignore, add.join("\n") + "\n");
    writeFileSync(1, `Wrote ${CONFIG_PATH} and .sandcastle/rules.md - fill in the gates and setup, then \`sandcastle build\`.\n\n`);
    // The lean check belongs to setup: what the repo would load into every
    // sandbox agent, all hidden until lean.keep names it.
    const project = await loadProject(root);
    leanReport(project, leanPlan(project));
    break;
  }
  default:
    throw new Error(`Unknown command "${command}". Run \`sandcastle help\`.`);
}
