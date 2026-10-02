// sandcastle <command> - run from anywhere inside a project's git repository.
//
//   setup            interactive install: link the command and skill, write
//                    the credentials file, then run doctor
//   doctor [--verify]
//                    check this machine and (inside a repo) this project are
//                    set up; prints what is missing and how to fix it;
//                    --verify also asks GitHub and Anthropic whether the tokens are accepted
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
//   queue --lint     the queue's shape before a run: blocker chain, Touches overlaps, wide
//                    tickets, hot and unmergeable files, a rough turn count; read-only, exit 0
//   requeue <ticket> [--note TEXT]
//                    put a ticket back in the queue (needs-human off) with an optional
//                    note for the next run; on a queued ticket, only adds the note
//   blockers         open issues whose comments say "blocked by" while the body does not
//                    (a run reads only the body), and queued ones whose blockers can never
//                    close (missing, a cycle) or are ignored; no model calls
//   gates            every gate on the base branch in a sandbox, as a run's
//                    first phase does; no model calls
//   land <ticket>    merge one agent branch with the kit's message, gate the merge in the
//                    project image, then close the ticket; nothing is merged on a red gate
//                    or a conflict; no model calls
//   preview          dry-merge every unlanded agent branch onto the base, oldest first,
//                    in the project image; lists clean and conflicting branches with their
//                    files; merges nothing; no model calls
//   lean [--measure] what the repo's skills, agents, MCP servers and plugins
//                    would cost each sandbox, which hooks are kept and whether
//                    they can run in the image; --measure runs one real turn
//                    with and without the extras
//   init             scaffold .sandcastle/ with gates guessed from the stack, then the lean check
//   clean [--all]    remove leftover sandbox worktrees and finished agent branches,
//                    and list unmerged ones; --all deletes those too, without asking
//   herdr configure [--remove]
//                    link the kit's Herdr plugin and add its sidebar rows, tab bar entry
//                    and keys to Herdr's config (shows them and asks first); --remove
//                    takes all of it out. Works from anywhere
//
// Models, effort, ISSUES, CONCURRENCY, DRY_RUN, CROSS_REVIEW, SKIP_PREFLIGHT, SKIP_BASE_GATES, USAGE_CHECK:
// environment variables, see README.md.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS_LINE } from "./agents.ts";
import { blockerProblems, blockerResolver, commentBlockLine, commentOnlyBlocks, openBlockers, refLabel } from "./blockers.ts";
import { autonomyLevel, confirm, nextTurn, type Rerun, rerunList, rerunnable } from "./autonomy.ts";
import { burndown } from "./burndown.ts";
import { loadProject } from "./config.ts";
import { landTicket, sandboxOpener } from "./land.ts";
import { requireGreenBase } from "./gates.ts";
import { assertGitUnchanged, disableHostGitHooks, gitFingerprint, lockRun, pinHostGitConfig } from "./guard.ts";
import { apply as leanApply, checkHooks, measure as leanMeasure, plan as leanPlan, report as leanReport, reportHookCheck, writePlan } from "./lean.ts";
import { lintQueue } from "./lint.ts";
import { limit } from "./pool.ts";
import { dockerRunner, preview, previewLines, unlanded } from "./preview.ts";
import { closingReport, gather, summary } from "./report.ts";
import { makeTracker, parseRequeueArgs, requeueTicket } from "./tracker.ts";
import { archiveFinishedLogs, assertCleanBase, exitOnSignal, forgetHead, parseRunArgs, preflight, rewordLibraryLines } from "./run.ts";
import { ensureImage, KIT, reapOrphans, sh } from "./sandbox.ts";
import { checkUsageSettings } from "./usage.ts";
import { resolveVersions, versionsLine } from "./versions.ts";
import { lockWorktree, unlockAll } from "./worktree-lock.ts";
import { doctor } from "./doctor.ts";
import { askingInPane } from "./herdr.ts";
import { herdrCommand } from "./herdr-plugin.ts";
import { nearest, OperatorError } from "./errors.ts";
import { init } from "./init.ts";
import { setup } from "./setup.ts";

const [command = "help", ...args] = process.argv.slice(2);
const HELP = readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3));
// Every command the help names, and the internal hook. Checked before the repository is, so a
// typo typed outside one was told "Not inside a git repository" instead of what it was.
const COMMANDS = [...HELP.flatMap((l) => /^  ([a-z][a-z-]*)/.exec(l)?.[1] ?? []), "lean-apply"];

// A refusal the operator acts on is a message, not a crash: no stack trace. Anything else is a
// kit bug and keeps its stack.
try {
  if (!["help", "--help", "-h", ...COMMANDS].includes(command)) {
    const near = nearest(command, COMMANDS.filter((c) => c !== "lean-apply"));
    throw new OperatorError(`Unknown command "${command}".${near ? ` Did you mean \`sandcastle ${near}\`?` : ""} Run \`sandcastle help\` for the list.`);
  }
  // `setup` and `doctor` also work outside a repository (fresh install). Git's own
  // "fatal: not a git repository" is not shown: it preceded every command, help included.
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const repoRoot = top.status === 0 ? top.stdout.trim() : undefined;
  if (command === "setup") {
    await setup(repoRoot);
    process.exit(0);
  }
  if (command === "doctor") {
    await doctor(repoRoot, args.includes("--verify"));
    process.exit(0);
  }
  // bin/sandcastle sends `herdr` straight to its module; this is for src/cli.ts run directly.
  if (command === "herdr") {
    await herdrCommand(args);
    process.exit(process.exitCode ?? 0);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP.join("\n"));
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
      process.on("exit", (code) => {
        if (summary.due && !summary.printed) {
          console.log("The run ended before its summary: `sandcastle report` shows what it did, and `sandcastle run` again picks up its tickets.");
        }
        console.log(`sandcastle run ended (exit ${code})`);
      });
      exitOnSignal();
      rewordLibraryLines();
      // Read before burndown, so a bad level is refused before Docker or any spend.
      const project = await loadProject(root);
      const level = autonomyLevel(process.env.AUTONOMY_LEVEL, project.autonomy);
      checkUsageSettings();
      for (let turn = 1; await burndown(project); turn++) {
        if (level === 0) break;
        const again = rerunnable(await gather(project));
        if (!again) break;
        // A ticket closed by hand since the turn would make the ISSUES path throw.
        const tracker = makeTracker(project);
        const open = (id: string) => {
          try {
            return tracker.get(id).open;
          } catch {
            return false;
          }
        };
        const left: Rerun = { conflicted: again.conflicted.filter(open), unblocked: again.unblocked.filter(open) };
        const ids = [...left.conflicted, ...left.unblocked];
        const list = rerunList(left, tracker.ref);
        const verdict = nextTurn(level, turn, left);
        if (verdict === "stop") break;
        const many = `${ids.length} ticket(s) can`;
        const manual = `\`sandcastle run ${ids.join(" ")}\``;
        if (verdict === "cap") {
          console.log(`Autonomy level ${level}: ${level} turn(s) done, the cap; ${many} still run again - ${list}. ${manual} runs them.`);
          break;
        }
        if (verdict === "ask") {
          const yes = await askingInPane(`asks whether to run ${ids.length} ticket(s) again`, () =>
            confirm(`Autonomy level 1: ${many} run again - ${list}. Run again now? [y/N] `),
          );
          if (yes === undefined) {
            console.log(`Autonomy level 1: ${many} run again - ${list}. Not a terminal, so nothing re-runs: ${manual} runs them.`);
            break;
          }
          if (!yes) {
            console.log(`Not running again. ${manual} runs them.`);
            break;
          }
          console.log(`Running again (turn ${turn + 1}) for ${list}.`);
        } else {
          console.log(`Autonomy level ${level}: running again (turn ${turn + 1} of ${level}) for ${list}.`);
        }
        // Exactly the re-runnable tickets, never the whole queue: red ones still queued stay out.
        process.env.ISSUES = ids.join(",");
      }
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
      const project = await loadProject(root);
      const versions = await resolveVersions(project);
      console.log(versionsLine(versions));
      console.log(await ensureImage(project, args.includes("--force"), versions));
      break;
    }
    case "preflight": {
      const project = await loadProject(root);
      await preflight(project, await ensureImage(project));
      break;
    }
    case "queue": {
      // The queue and what holds each ticket back; `--json` is what the status view reads.
      const project = await loadProject(root);
      const tracker = makeTracker(project);
      const queued = tracker.queued(false);
      if (args.includes("--lint")) {
        // Advice only: exit 0 whatever it finds.
        for (const line of await lintQueue(project, tracker, queued)) console.log(line);
        break;
      }
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
        for (const line of await blockerProblems(project, tracker, queued)) console.log(`  warning: ${line}`);
        if (!rows.length) {
          // A queue is empty when nothing is labelled, not only when nothing is open: say how many
          // are waiting and where work comes from. A tracker that cannot be read keeps the bare line.
          let open: number | undefined;
          try {
            open = tracker.open(false).length;
          } catch {}
          const noun = tracker.kind === "files" ? "ticket(s)" : "issue(s)";
          console.log(
            open === undefined
              ? "  (empty)"
              : `  (empty) - ${open} open ${noun} not in the queue. File issues for the work, or run /sandcastle queue to triage the open ones.`,
          );
        }
      }
      break;
    }
    case "requeue": {
      const project = await loadProject(root);
      const tracker = makeTracker(project);
      // A ticket-file requeue commits to the base branch, and a live run that sees the base move lands nothing.
      if (tracker.kind === "files") lockRun(project);
      const message = requeueTicket(tracker, project.label, args);
      console.log(message);
      // A requeue asks for new work: without this, a kept green branch would land on the next run unread.
      const { id } = parseRequeueArgs(args);
      if (forgetHead(project.root, id)) console.log(`${tracker.ref(id)}: its recorded green head was dropped, so the next run re-implements it.`);
      break;
    }
    case "blockers": {
      const project = await loadProject(root);
      const tracker = makeTracker(project);
      // Every open ticket, not only the queued: earlier triage parked blocked ones
      // unqueued with a comment, and they need the line moved before they are queued.
      const queued = tracker.queued(false);
      const queuedIds = new Set(queued.map((t) => t.id));
      const open = tracker.open();
      const found = await commentOnlyBlocks(project, tracker, open.map((t) => ({ ...t, queued: queuedIds.has(t.id) })));
      for (const f of found) console.log(commentBlockLine(f));
      // Queued tickets that would wait for ever, or start at once, because of how a blocker is written.
      const problems = await blockerProblems(project, tracker, queued);
      for (const line of problems) console.log(line);
      const n = found.length + problems.length;
      console.log(n ? `\n${n} thing(s) to look at, across ${open.length} open ticket(s).` : `No stale, unread or unworkable blockers on ${open.length} open ticket(s).`);
      break;
    }
    case "gates": {
      // The sandbox shares the repo's .git, so the run's host guards apply.
      disableHostGitHooks();
      const project = await loadProject(root);
      pinHostGitConfig(project.root);
      const fingerprint = gitFingerprint(project);
      try {
        await requireGreenBase(project, await ensureImage(project), writePlan(project).file, false);
      } finally {
        assertGitUnchanged(project, fingerprint, "after the gates");
      }
      console.log("All gates green on the base branch.");
      break;
    }
    case "land": {
      // The merge lands in this checkout, so it must be clean and no run may be merging into it.
      disableHostGitHooks();
      const project = await loadProject(root);
      pinHostGitConfig(project.root);
      assertCleanBase(project);
      lockRun(project);
      console.log(
        await landTicket(project, makeTracker(project), args[0], async () => {
          const image = await ensureImage(project);
          return { open: sandboxOpener(project, image, writePlan(project).file) };
        }),
      );
      break;
    }
    case "preview": {
      // Writes nothing to the repo (the image gets .git read-only), so no run lock or clean-tree check.
      const project = await loadProject(root);
      if (!unlanded(project).length) {
        console.log(previewLines(project, project.baseBranch, []).join("\n"));
        break;
      }
      console.log(previewLines(project, project.baseBranch, preview(project, dockerRunner(await ensureImage(project)))).join("\n"));
      break;
    }
    case "lean": {
      const project = await loadProject(root);
      const p = leanPlan(project);
      leanReport(project, p);
      const image = await ensureImage(project);
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
      pinHostGitConfig(project.root);
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
  // A full disk is the operator's to fix, wherever the write was; its stack trace says nothing more.
  const full = (error as NodeJS.ErrnoException)?.code === "ENOSPC";
  if (!(error instanceof OperatorError) && !full) throw error;
  console.error(
    full
      ? `\nThe disk is full: writing ${(error as NodeJS.ErrnoException).path ?? "a file"} failed. Free some space (\`sandcastle clean\` removes finished worktrees; \`docker system df\` shows what Docker holds), then try again.`
      : `\n${(error as Error).message}`,
  );
  process.exitCode = 1;
}
