// sandcastle <command> - run from anywhere inside a project's git repository.
//
//   setup            interactive install: link the command and skill, write
//                    the credentials file, then run doctor
//   doctor           check this machine and (inside a repo) this project are
//                    set up; prints what is missing and how to fix it
//   run [TICKET ...] [--dry] [--concurrency N]
//                    burn down the queue: build images if stale, preflight,
//                    open the status pane (Herdr), implement/review/gate/merge;
//                    the arguments are the same as ISSUES, DRY_RUN and CONCURRENCY
//   report           the last run's closing summary: done, needs you, needs fixing,
//                    runnable now, local state, next step; no model calls
//   status [s] [all] the live status view (refresh every s seconds, 0 = once);
//                    it fits its pane unless given "all"
//   build [--force]  build the base and project images
//   preflight        one reply from every model, nothing else
//   queue [--json]   the queue and what holds each ticket back (the tracker in use:
//                    GitHub Issues or ticket files; see README, Trackers); no model calls
//   blockers         open queued issues whose comments say "blocked by" while the body
//                    does not (a run reads only the body); no model calls
//   gates            every gate on the base branch in a sandbox, as a run's
//                    first phase does; no model calls
//   lean [--measure] what the repo's skills, agents, MCP servers and plugins
//                    would cost each sandbox, which hooks are kept and whether
//                    they can run in the image; --measure runs one real turn
//                    with and without the extras
//   init             scaffold .sandcastle/ with gates guessed from the stack, then the lean check
//   clean [--all]    remove leftover sandbox worktrees and finished agent branches;
//                    --all also deletes unmerged agent branches (listed first)
//
// Models, effort, ISSUES, CONCURRENCY, DRY_RUN, CROSS_REVIEW, SKIP_PREFLIGHT, SKIP_BASE_GATES, USAGE_CHECK:
// environment variables, see README.md.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS_LINE } from "./agents.ts";
import { blockerResolver, commentBlockLine, commentOnlyBlocks, openBlockers, refLabel } from "./blockers.ts";
import { burndown } from "./burndown.ts";
import { loadProject } from "./config.ts";
import { requireGreenBase } from "./gates.ts";
import { assertGitUnchanged, disableHostGitHooks, gitFingerprint, lockRun } from "./guard.ts";
import { apply as leanApply, checkHooks, measure as leanMeasure, plan as leanPlan, report as leanReport, reportHookCheck, writePlan } from "./lean.ts";
import { limit } from "./pool.ts";
import { closingReport } from "./report.ts";
import { makeTracker } from "./tracker.ts";
import { archiveFinishedLogs, parseRunArgs, preflight } from "./run.ts";
import { ensureImage, KIT, reapOrphans, sh } from "./sandbox.ts";
import { lockWorktree, unlockAll } from "./worktree-lock.ts";
import { doctor } from "./doctor.ts";
import { OperatorError } from "./errors.ts";
import { init } from "./init.ts";
import { setup } from "./setup.ts";

const [command = "help", ...args] = process.argv.slice(2);

// A refusal the operator acts on is a message, not a crash: no stack trace. Anything else is a
// kit bug and keeps its stack.
try {
  // `setup` and `doctor` also work outside a repository (fresh install).
  const repoRoot = (() => {
    try {
      return sh("git", ["rev-parse", "--show-toplevel"]);
    } catch {
      return undefined;
    }
  })();
  if (command === "setup") {
    await setup(repoRoot);
    process.exit(0);
  }
  if (command === "doctor") {
    await doctor(repoRoot);
    process.exit(0);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(0);
  }
  if (!repoRoot) throw new OperatorError("Not inside a git repository. Run sandcastle from inside the project you want it to work on.");
  // Sandcastle resolves worktrees and logs from the working directory, so every
  // command runs from the repository root, wherever it was typed.
  const root = repoRoot;
  process.chdir(root);

  switch (command) {
    case "run": {
      // Parsed before anything that needs config or Docker, so a bad argument is refused for free.
      // An argument overrides the variable of the same name; burndown() reads them all at call time.
      const given = parseRunArgs(args);
      if (given.issues) process.env.ISSUES = given.issues.join(",");
      if (given.dry) process.env.DRY_RUN = "1";
      if (given.concurrency !== undefined) process.env.CONCURRENCY = String(given.concurrency);
      // An agent that started the run in another pane (Herdr's `pane run`) is
      // told nothing when it ends; its watcher waits for this line, printed on
      // every exit - a drained queue and a crash included.
      process.on("exit", (code) => console.log(`sandcastle run ended (exit ${code})`));
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
          SANDCASTLE_BIN: join(KIT, "bin/sandcastle"),
          SANDCASTLE_NAME: project.name,
          SANDCASTLE_BASE: project.baseBranch,
          // What the next run would use: between runs the view showed the last
          // run's models, which read as the current setting.
          SANDCASTLE_MODELS: MODELS_LINE,
          SANDCASTLE_MAX_SANDBOXES: String(limit("sandboxes")),
          SANDCASTLE_MAX_GATES: String(limit("gates")),
        },
      });
      process.exit(r.status ?? 0);
    }
    case "report": {
      console.log(await closingReport(await loadProject(root)));
      break;
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
    case "queue": {
      // The queue and what holds each ticket back; `--json` is what the status view reads.
      const project = await loadProject(root);
      const tracker = makeTracker(project);
      const queued = tracker.queued(false);
      const resolve = blockerResolver(project, tracker, new Set(queued.map((t) => t.id)));
      const rows = await Promise.all(
        queued.map(async (t) => ({
          id: t.id,
          title: t.title,
          updated: t.updated ?? null,
          blockedOn: (await openBlockers(project, tracker, resolve, t)).map(refLabel),
        })),
      );
      if (args.includes("--json")) console.log(JSON.stringify(rows));
      else {
        console.log(`${project.tracker.kind} tracker (${project.tracker.source}), queue "${project.label}":`);
        for (const r of rows) console.log(`  ${tracker.ref(r.id)} ${r.title}${r.blockedOn.length ? `  [waits for ${r.blockedOn.join(", ")}]` : ""}`);
        if (!rows.length) console.log("  (empty)");
      }
      break;
    }
    case "blockers": {
      const project = await loadProject(root);
      const tracker = makeTracker(project);
      // Every open ticket, not only the queued: earlier triage parked blocked ones
      // unqueued with a comment, and they need the line moved before they are queued.
      const queuedIds = new Set(tracker.queued(false).map((t) => t.id));
      const open = tracker.open();
      const found = await commentOnlyBlocks(project, tracker, open.map((t) => ({ ...t, queued: queuedIds.has(t.id) })));
      for (const f of found) console.log(commentBlockLine(f));
      console.log(found.length ? `\n${found.length} of ${open.length} open ticket(s) to look at.` : `No stale or unread blocker comments on ${open.length} open ticket(s).`);
      break;
    }
    case "gates": {
      // The sandbox shares the repo's .git, so the run's host guards apply.
      disableHostGitHooks();
      const project = await loadProject(root);
      const fingerprint = gitFingerprint(project);
      try {
        await requireGreenBase(project, ensureImage(project), writePlan(project).file, false);
      } finally {
        assertGitUnchanged(project, fingerprint, "after the gates");
      }
      console.log("All gates green on the base branch.");
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
      init(root);
      // The lean check belongs to setup: what the repo would load into every
      // sandbox agent, all hidden until lean.keep names it.
      const project = await loadProject(root);
      leanReport(project, leanPlan(project));
      break;
    }
    case "clean": {
      // Leftovers a run owns nobody: worktrees an interrupted or dirty sandbox
      // kept, and agent branches nothing reports once their row ages out. A
      // live run's own worktrees must survive, so this takes the run lock.
      disableHostGitHooks();
      const project = await loadProject(root);
      lockRun(project);
      reapOrphans(project);
      unlockAll();
      const worktrees = sh("git", ["worktree", "list", "--porcelain"])
        .split("\n\n")
        .map((e) => e.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length))
        .filter((p): p is string => !!p && p.startsWith(join(root, ".sandcastle/worktrees/")));
      for (const path of worktrees) {
        sh("git", ["worktree", "remove", "--force", path]);
        console.log(`removed worktree ${path}`);
      }
      sh("git", ["worktree", "prune"]);
      const base = project.baseBranch;
      const all = args.includes("--all");
      const standing: string[] = [];
      let deleted = 0;
      for (const branch of sh("git", ["branch", "--format=%(refname:short)", "--list", "agent/*", "sandcastle/*"]).split("\n").filter(Boolean)) {
        // A base-gate or verify branch is always scratch. An agent branch is
        // finished when every commit is on base, merged or as an equal patch.
        const finished = branch.startsWith("sandcastle/") || !sh("git", ["cherry", base, branch]).split("\n").some((l) => l.startsWith("+"));
        if (finished || all) {
          sh("git", ["branch", "-D", branch]);
          deleted++;
          console.log(`deleted ${branch}${finished ? "" : " (unmerged)"}`);
        } else {
          standing.push(`${branch} (${sh("git", ["rev-list", "--count", `${base}..${branch}`])} commit(s) not on ${base})`);
        }
      }
      archiveFinishedLogs(project);
      if (standing.length) {
        console.log(`\nUnmerged, kept:\n  ${standing.join("\n  ")}\n\`sandcastle clean --all\` deletes them too - their work is lost.`);
      }
      if (!worktrees.length && !deleted && !standing.length) console.log("Nothing to clean.");
      break;
    }
    default:
      throw new OperatorError(`Unknown command "${command}". Run \`sandcastle help\`.`);
  }
} catch (error) {
  if (!(error instanceof OperatorError)) throw error;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
