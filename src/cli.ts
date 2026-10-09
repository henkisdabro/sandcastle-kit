// sandcastle <command> - run from anywhere inside a project's git repository.
//
//   setup            interactive install: link the command and skill, write
//                    the credentials file, then run doctor
//   doctor [--verify]
//                    check this machine and (inside a repo) this project are
//                    set up; prints what is missing and how to fix it;
//                    --verify also asks GitHub and Anthropic whether the tokens are accepted
//   run [TICKET ...] [--dry] [--concurrency N] [--detach] [--api-key] [--accept-git-config]
//                    burn down the queue: build images if stale, preflight,
//                    open the status pane (Herdr), implement/review/gate/merge;
//                    the arguments are the same as TICKETS, DRY_RUN and CONCURRENCY;
//                    --detach (or SANDCASTLE_DETACH=1) starts it as a process of its own,
//                    output in .sandcastle/logs/run-output.log, and returns once it is going
//                    (not with autonomy level 1, which asks a question a detached run cannot);
//                    a run that would spend ANTHROPIC_API_KEY asks first, and without a
//                    terminal needs --api-key (or SANDCASTLE_API_KEY=1), which is the yes;
//                    a run, `land` or `gates` first holds what makes git run a program or reach
//                    the network in the shared .git (those keys of .git/config and config.worktree,
//                    info/attributes, hooks/ and modules/) to what the previous run recorded,
//                    and refuses a difference, naming each key and file (a sandbox of a killed
//                    run may have planted it): remove it, or if it is yours
//                    --accept-git-config records the present state as the new baseline
//                    After a clean end the start takes a new plain https or ssh remote, a
//                    hooks path in a tracked directory and a hook manager's hooks itself,
//                    printing a line for each
//   wait [seconds]   block while the project's run is live, then print its closing summary
//                    and exit with the run's exit code; with a timeout, exit 124 and leave
//                    the run alone. With no run live: the last summary and its exit code
//   stop             stop the live run, as Ctrl-C does in its terminal
//   pause            hold the live run at the next safe juncture, losing no work: no new
//                    ticket or agent pass starts, passes in flight finish and their sandboxes
//                    close (branches kept), green branches still land, and the run gives its
//                    sandbox slots to other runs. The process stays alive; `stop` still works.
//                    A pause the run took itself for its plan's usage (USAGE_PAUSE) becomes
//                    yours: it stays until `resume`, whatever its window does
//   resume           continue a paused run: each paused ticket goes on from its next phase,
//                    in the same run, with one closing summary; before its time it also ends
//                    a pause for plan usage, which then does not pause again for the windows
//                    that are over the threshold now
//   cap [N | off] [--project NAME]
//                    cap the live run's share of the machine's sandbox slots at N (at most
//                    its concurrency), or lift the cap; bare, print its demand, share and
//                    cap. The run keeps the slots it holds. The cap ends with the run;
//                    --project acts on another project's run from any directory
//   size             recommend the machine pool's limits (maxSandboxes, maxGates) from the
//                    container runtime's VM and the sandboxes' measured peak memory, with
//                    the figure that set each, the current limits and advice on the
//                    runtime's CPU and memory; read-only, writes nothing; no model calls
//   usage            the plan's usage, read-only: the newest reading the run record or history
//                    holds (under 10 minutes old) with its age, else one request to the plan's
//                    usage endpoint; with ANTHROPIC_API_KEY in use, says the sandboxes spend API
//                    credits, not a plan. Exits 1 when the usage is unknown; no model calls
//   report           the last run's closing summary: done, needs you, needs fixing,
//                    runnable now, local state, next step; no model calls
//   report --changelog [--since REF]
//                    every ticket that landed in runs started after REF (default: the latest
//                    tag, else all history), across runs, with the agents' suggested changelog
//                    lines (`changelog: true`) grouped Added, Changed, Fixed and Upgrading, and
//                    those with no line apart; read-only, no model calls
//   status [s] [all] the live status view (refresh every s seconds, 0 = once);
//                    it fits its pane unless given "all"
//   build [--force]  build the base and project images
//   preflight [--api-key]
//                    one reply from every model, nothing else; asks first, as a run
//                    does, when it would spend ANTHROPIC_API_KEY
//   queue [--json]   the queue and what holds each ticket back (the tracker in use:
//                    GitHub issues or ticket files; see README, Trackers); no model calls
//   queue --lint [TICKET ...]
//                    the queue's shape before a run: blocker chain, Touches overlaps, wide
//                    tickets, hot and unmergeable files, a rough turn count; read-only, exit 0;
//                    given tickets, only those are linted (pass the run's own), and a blocker
//                    outside them is listed as a wait, as the run would hold it
//   requeue <ticket> [--note TEXT]
//                    put a ticket back in the queue (hold label off) with an optional
//                    note for the next run; on a queued ticket, only adds the note
//   blockers         open tickets whose comments say "blocked by" while the body does not
//                    (a run reads only the body), and queued ones whose blockers can never
//                    close (missing, a cycle) or are ignored; no model calls
//   gates [--accept-git-config]
//                    every gate on the base branch in a sandbox, as a run's
//                    first phase does; no model calls
//   land <ticket> [--accept-git-config]
//                    merge one agent branch with the kit's message, gate the merge in the
//                    project image, then close the ticket (left open with a criterion
//                    recorded unmet); nothing is merged on a red gate or a conflict; no
//                    model calls
//   preview          dry-merge every unlanded agent branch onto the base, oldest first,
//                    in the project image; lists clean and conflicting branches with their
//                    files; merges nothing; no model calls
//   lean [--measure] [--api-key]
//                    what the repo's skills, agents, MCP servers and plugins
//                    would cost each sandbox, which hooks are kept and whether
//                    they can run in the image; --measure runs one real turn
//                    with and without the extras (asking first, as a run does,
//                    when it would spend ANTHROPIC_API_KEY)
//   init             scaffold .sandcastle/ with gates guessed from the stack, then the lean check
//   updated [--declined KEY[,KEY...]]
//                    record that this project has acted on the kit's upgrading notes (the
//                    update action's last step); doctor and run then stop listing them;
//                    prints the release recorded before and the kit's version now;
//                    --declined also records the update steps the user declined, each at the
//                    kit's release, in the update record (`declined`), so the next update
//                    names them and does not ask again; earlier ones are kept
//   changes [--since RELEASE]
//                    the CHANGELOG entries of every release after the one this project last
//                    updated at (or after RELEASE), up to the kit's own: per release grouped
//                    Added, Changed, Security, Fixed, Upgrading, each cut to its bold lead;
//                    with no record and no --since, the current release's; then, from
//                    the kit's git tags of the two releases, the config keys, personal
//                    settings, environment variables, commands and flags added, removed
//                    or changed (a missing tag is said, the changelog stands alone);
//                    read-only, no model calls
//   clean [--all] [--accept-git-config]
//                    remove exited sandbox containers, the kit's dangling images, leftover
//                    sandbox worktrees and finished agent branches, drop the backup copy
//                    of a branch that is gone or merged, and list unmerged ones;
//                    --all deletes those too, without asking; a worktree a sandbox
//                    tampered with is left, named, and the exit code is 1
//   --version        the kit version: the release, and in a clone past it, the commit
//   herdr configure [--remove]
//                    link the kit's Herdr plugin and add its sidebar rows, tab bar entry
//                    and keys to Herdr's config (shows them and asks first); --remove
//                    takes all of it out. Works from anywhere
//
// Models, effort, TICKETS (ISSUES is the older name), CONCURRENCY, DRY_RUN, CROSS_REVIEW, SKIP_PREFLIGHT, SKIP_BASE_GATES, USAGE_CHECK, USAGE_PAUSE, SANDCASTLE_API_KEY:
// environment variables, see README.md.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS_LINE, implementNote, ticketOverride } from "./agents.ts";
import { confirmApiKey } from "./api-key.ts";
import { resolveClickHint } from "./click-hint.ts";
import { blockerProblems, blockerResolver, commentBlockLine, commentOnlyBlocks, openBlockers, refLabel } from "./blockers.ts";
import { afterTurn, capLine, conflictedIn, confirm, DRAIN_CAP, type DrainTurn, drainLine, drainStop, lateQueueLines, noRerunCause, redBaseExit, rerunList, stillOpen } from "./autonomy.ts";
import { burndown, namedTickets, openOnQueue } from "./burndown.ts";
import { loadProject, type Project } from "./config.ts";
import { livePid, pauseRun, recordedExitCode, resumeRun, startDetached, waitForRun } from "./detach.ts";
import { landTicket, sandboxOpener } from "./land.ts";
import { hooksThatRanClean, requireGreenBase } from "./gates.ts";
import { assertGitConfigBaseline, assertGitUnchanged, disableHostGitHooks, gitFingerprint, holdAndReap, lockRun, pinHostGitConfig, recordGitConfigEnd, recordGitConfigStart, tookLines, worktreeRefusal, protectedForTicket, protectedWarning, pruneBackup } from "./guard.ts";
import { apply as leanApply, checkHooks, measure as leanMeasure, plan as leanPlan, report as leanReport, reportHookCheck, writePlan } from "./lean.ts";
import { lintQueue } from "./lint.ts";
import { limit, parseCapArgs, setCap, standing, standingLine } from "./pool.ts";
import { dockerRunner, preview, previewLines, unlanded } from "./preview.ts";
import { changelogSince, closingReport, type Facts, gather, operatorSteps, summary } from "./report.ts";
import { LABEL_LAG_REMINDER, makeTracker, parseRequeueArgs, requeueTicketWithEffect } from "./tracker.ts";
import { archiveFinishedLogs, assertCleanBase, exitOnSignal, forgetHead, namedTicketsFromEnv, parseRunArgs, preflight, readOutcomes, rewordLibraryLines } from "./run.ts";
import { claudeCredentials, cleanProject, ensureImage, KIT, machineSettings, projectApiKeySpend, sandboxCpus } from "./sandbox.ts";
import { resolveSettings, settingsGroup } from "./run-settings.ts";
import { DOCKER_INFO_ENV, readDockerInfo, runtimeProblemNow } from "./runtime.ts";
import { changesDiffLines, changesLines, kitVersion, markUpdated, recordedRelease, upgradeLines, updatedLine } from "./upgrading.ts";
import { checkUsageSettings, recordedUsage, resumeClock, usageCommand, usagePauseWords } from "./usage.ts";
import { resolveVersions, versionsLine } from "./versions.ts";
import { lockWorktree } from "./worktree-lock.ts";
import { doctor, requireRepoAccess } from "./doctor.ts";
import { askingInPane, IN_HERDR, sandboxPanes } from "./herdr.ts";
import { HELP, helpFor, wantsHelp } from "./help.ts";
import { herdrCommand } from "./herdr-plugin.ts";
import { nearest, OperatorError, wasReported } from "./errors.ts";
import { init } from "./init.ts";
import { setup } from "./setup.ts";
import { realReaders, sizeLines } from "./size.ts";

/** The run record's end-of-run verify, or undefined when there is no readable record. */
const recordedVerify = (root: string): Pick<Facts, "verify"> | undefined => {
  try {
    return { verify: JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).verify };
  } catch {
    return undefined;
  }
};

/**
 * The project as the sandbox of `sandcastle gates` or `sandcastle land` sees it: both open gate-only
 * sandboxes, so `cpus` is the gate share a run's landing and base gates get (`sandboxCpus`), cut to the VM's CPUs.
 * Outside a run nothing divides by a concurrency. Read when first needed: `docker info` answers once per sandbox.
 */

const gateOnly = (project: Project): Project => ({ ...project, cpus: sandboxCpus(project, "gate", { concurrency: 1, maxGates: limit("gates") }, readDockerInfo) });

const [command = "help", ...args] = process.argv.slice(2);
// Every command the help names, and the internal hook. Checked before the repository is, so a
// typo typed outside one was told "Not inside a git repository" instead of what it was.
const COMMANDS = [...HELP.flatMap((l) => /^  ([a-z][a-z-]*)/.exec(l)?.[1] ?? []), "lean-apply"];

// The local time of day of a pause that began at `seconds` since the epoch, as the status view shows it.
const clock = (seconds: number) => new Date(seconds * 1000).toTimeString().slice(0, 5);

// A refusal the operator acts on is a message, not a crash: no stack trace. Anything else is a
// kit bug and keeps its stack.
try {
  if (!["help", "--help", "-h", "--version", ...COMMANDS].includes(command)) {
    const near = nearest(command, COMMANDS.filter((c) => c !== "lean-apply"));
    throw new OperatorError(`Unknown command "${command}".${near ? ` Did you mean \`sandcastle ${near}\`?` : ""} Run \`sandcastle help\` for the list.`);
  }
  // Before anything runs: `clean --help` is a request for text, not a clean.
  if (wantsHelp(args)) {
    console.log(helpFor(command));
    process.exit(0);
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
  if (command === "--version") {
    console.log(`sandcastle-kit ${kitVersion()}`);
    process.exit(0);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    // `help changes` is the one entry; `helpFor` gives the whole text for a name the help does not list.
    console.log(args[0] ? helpFor(args[0]) : HELP.join("\n"));
    process.exit(0);
  }
  if (command === "cap") {
    // The run's project as live runs record it: `--project` from anywhere, else this repository's.
    const given = parseCapArgs(args);
    if (!given.project && !repoRoot) throw new OperatorError("Not inside a git repository. Give the project's name with `--project NAME`.");
    const name = given.project ?? (await loadProject(repoRoot!)).name;
    const now = given.cap === undefined ? standing(name) : setCap(name, given.cap);
    if (given.cap === "off") console.log(`Cap lifted for ${name}.`);
    else if (given.cap !== undefined) console.log(`Capped ${name} at ${given.cap} sandbox slot(s). It keeps the slots it holds, and takes no more while it holds ${given.cap} or more.`);
    console.log(standingLine(now));
    process.exit(0);
  }
  if (command === "size") {
    if (args.length) throw new OperatorError(`Unknown argument "${args[0]}" for sandcastle size: it takes none.`);
    for (const line of sizeLines(realReaders(), process.env, machineSettings())) console.log(line);
    process.exit(0);
  }
  if (!repoRoot) throw new OperatorError("Not inside a git repository. Run sandcastle from inside the project you want it to work on.");
  // Sandcastle resolves worktrees and logs from the working directory, so every
  // command runs from the repository root, wherever it was typed.
  const root = repoRoot;
  process.chdir(root);

  switch (command) {
    case "usage": {
      if (args.length) throw new OperatorError(`Unknown argument "${args[0]}" for sandcastle usage: it takes none.`);
      const project = await loadProject(root);
      const shown = await usageCommand({ env: claudeCredentials(project), recorded: recordedUsage(join(root, ".sandcastle/logs")) });
      for (const line of shown.lines) console.log(line);
      process.exitCode = shown.known ? 0 : 1;
      break;
    }
    case "run": {
      // Parsed before anything that needs config or Docker, so a bad argument is refused for free.
      // An argument overrides the variable of the same name; burndown() reads them all at call time.
      const given = parseRunArgs(args);
      // Doctor's own refusal, before the config, the billing question or an image: a run as root or on
      // Podman or rootless Docker on Linux would only fail inside the first sandbox.
      // `docker info` is read once for the whole start, when first asked: the check below (Linux only),
      // then the sandbox CPU limit and the pool warning in burndown (macOS asks there). A detached
      // child takes the reading its parent made, and does not repeat the check the parent passed.
      const child = process.env.SANDCASTLE_DETACHED === "1";
      let reading: { text: string | undefined } | undefined = child && process.env[DOCKER_INFO_ENV] ? { text: process.env[DOCKER_INFO_ENV] } : undefined;
      delete process.env[DOCKER_INFO_ENV];
      const docker = () => (reading ??= { text: readDockerInfo() }).text;
      const runtime = child ? undefined : runtimeProblemNow(docker);
      if (runtime) throw new OperatorError(`${runtime.label}: ${runtime.fix}`);
      if (given.issues) {
        // An argument overrides both names, so the older one is dropped rather than reported as a clash.
        delete process.env.ISSUES;
        process.env.TICKETS = given.issues.join(",");
      }
      if (given.dry) process.env.DRY_RUN = "1";
      if (given.concurrency !== undefined) process.env.CONCURRENCY = String(given.concurrency);
      if (given.apiKey) process.env.SANDCASTLE_API_KEY = "1";
      // The same run again, as a process of its own. Everything a run refuses on is refused here,
      // before a process starts; the child (SANDCASTLE_DETACHED) runs the other checks again for itself.
      if ((given.detach || process.env.SANDCASTLE_DETACH === "1") && process.env.SANDCASTLE_DETACHED !== "1") {
        const project = await loadProject(root);
        if (resolveSettings({ env: process.env, project, machine: machineSettings() }).autonomy === 1) {
          throw new OperatorError("Autonomy level 1 asks a question at the end of each turn, which a detached run cannot. Use level 2 or 3, or run attached.");
        }
        sandboxPanes(project);
        // The child checks again for itself; this one refuses before a process starts.
        const baseline = assertGitConfigBaseline(project, "sandcastle run", given.acceptGitConfig);
        assertCleanBase(project);
        await requireRepoAccess(project);
        const owner = livePid(root);
        if (owner) {
          throw new OperatorError(
            `Another sandcastle run of this project is live (pid ${owner}). One run per project at a time: \`sandcastle wait\` blocks until it ends, \`sandcastle stop\` stops it.`,
          );
        }
        // A detached run has no terminal to ask on: only the opt-in says yes, given here and passed on.
        await confirmApiKey(projectApiKeySpend(project), "This run", { terminal: false });
        const started = await startDetached(root, args.filter((a) => a !== "--detach"), { inHerdr: IN_HERDR, dockerInfo: reading?.text });
        // The child prints what its start took into its log, which nobody reads at once: this terminal shows it too.
        if (started.code === 0) for (const line of tookLines(baseline)) console.log(line);
        for (const line of started.lines) console.log(line);
        process.exitCode = started.code;
        break;
      }
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
      // The run's settings, resolved once: every turn's record carries them.
      const settings = resolveSettings({ env: process.env, project, machine: machineSettings(), apiKey: !!projectApiKeySpend(project) });
      const level = settings.autonomy;
      sandboxPanes(project);
      checkUsageSettings();
      // A token that cannot see the repo would crash every ticket on its first `gh issue view`: refused before the billing question, an image or a sandbox.
      await requireRepoAccess(project);
      // Told, never refused: a run works on a pulled kit, but a note may ask this project to act first.
      for (const line of upgradeLines(root, KIT, false)) console.log(line);
      // Once for the whole run, every turn included, and before any image, sandbox or model call.
      await confirmApiKey(projectApiKeySpend(project), "This run", { ask: (q) => askingInPane("asks whether to bill API credits", () => confirm(q)) });
      // `drain` keeps its own tally: each turn still prints its closing report, and the last line
      // says how many turns ran, what they landed and why the loop stopped.
      const drain = { turns: 0, landed: 0, last: undefined as DrainTurn | undefined, inRun: new Set<string>(), unblocked: [] as string[], cause: undefined as string | undefined };
      // The queue as the drain starts: a first turn that names its tickets leaves the rest of the queue
      // off the run record, and the closing lines must not say those were queued after the run started.
      // Unreadable: no closing lines rather than wrong ones.
      let queuedAtStart: Set<string> | undefined;
      if (level === "drain") {
        try {
          queuedAtStart = new Set(makeTracker(project).queued(false).map((t) => t.id));
        } catch {}
      }
      // What the operator named, kept for every turn: a later turn sets TICKETS to its own re-runnable tickets,
      // which says nothing of a queued ticket the operator left out. Nothing named: the whole queue, as always.
      const operatorList = namedTicketsFromEnv().list;
      const scope = operatorList ? { list: operatorList, ids: undefined as Set<string> | undefined } : undefined;
      // The last turn's facts, for the exit code: a turn that ended the loop before gathering (level 0) leaves them unread.
      let lastFacts: Awaited<ReturnType<typeof gather>> | undefined;
      let ranTurn = false;
      for (let turn = 1; ; turn++) {
        // Only the first turn takes the start's reading; a later turn reads its own, as the runtime may have been resized since.
        if (!(await burndown(project, { settings, turn, ...(scope ? { scope } : {}), ...(turn === 1 ? { docker, acceptGitConfig: given.acceptGitConfig } : {}) }))) {
          drain.cause ??= "no ticket could start";
          break;
        }
        ranTurn = true;
        if (level === 0) break;
        const facts = await gather(project);
        lastFacts = facts;
        drain.turns = turn;
        for (const id of Object.keys(facts.tickets)) drain.inRun.add(id);
        drain.landed += Object.values(facts.tickets).filter((t) => t.state === "merged").length;
        const tracker = makeTracker(project);
        // A ticket closed by hand since the turn would make the TICKETS path throw: afterTurn drops it.
        const after = afterTurn(facts, level, turn, stillOpen(tracker));
        if (!after) {
          drain.cause = noRerunCause(facts);
          break;
        }
        if (after.verdict === "stop") {
          drain.cause = "no ticket is left to run again";
          break;
        }
        const { left, ids, verdict } = after;
        const list = rerunList(left, tracker.ref);
        if (level === "drain") {
          const now: DrainTurn = {
            landed: Object.values(facts.tickets).filter((t) => t.state === "merged").length,
            released: left.unblocked.filter((id) => !drain.unblocked.includes(id)),
            conflicted: conflictedIn(readOutcomes(root), facts.started),
            partial: left.partial,
          };
          const why = drainStop(now, drain.last, tracker.ref);
          drain.last = now;
          drain.unblocked = left.unblocked;
          if (why) {
            drain.cause = why;
            // The turn's summary said the loop runs again; it does not, so the steps are the operator's after all.
            console.log(await operatorSteps(project));
            break;
          }
        }
        const many = `${ids.length} ticket(s) can`;
        const manual = `\`sandcastle run ${ids.join(" ")}\``;
        if (verdict === "cap") {
          console.log(capLine(level as Exclude<typeof level, 0 | 1>, ids, list));
          drain.cause = `the cap of ${DRAIN_CAP} turns was reached`;
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
          console.log(`Autonomy level ${level}: running again (turn ${turn + 1} of ${level === "drain" ? `at most ${DRAIN_CAP}` : level}) for ${list}.`);
        }
        // Exactly the re-runnable tickets, never the whole queue: red ones still queued stay out.
        delete process.env.ISSUES;
        process.env.TICKETS = ids.join(",");
      }
      if (level === "drain" && drain.turns > 0) {
        const cause = drain.cause ?? "the run ended";
        console.log(`Autonomy level drain: not running again - ${cause}.`);
        console.log(drainLine(drain.turns, drain.landed, cause));
        // One more queue read: a ticket queued while the drain ran is not in any turn's list, so it waits for the next run.
        const tracker = makeTracker(project);
        const known = queuedAtStart && new Set([...queuedAtStart, ...drain.inRun]);
        if (known) for (const line of await lateQueueLines(tracker, known, async (late) => new Set((await openOnQueue(project, tracker, late)).keys()), scope?.ids)) console.log(line);
      }
      // A red merged base is a failed run to whoever reads the code (`sandcastle wait`, a harness), at every level.
      // Level 0 gathered no facts: the run record's verify is enough, where gather() would read the tracker again
      // after the summary has printed, and a throw there would turn a finished run into a crash.
      // The run ended by itself (a stop throws past this): the config it held the host to is the next run's baseline.
      recordGitConfigEnd(project);
      const redExit = redBaseExit(lastFacts ?? (ranTurn ? recordedVerify(project.root) : undefined));
      if (redExit) process.exitCode = redExit;
      break;
    }
    case "status": {
      const project = await loadProject(root);
      // The next run's settings, as the view draws them; "{}" when they cannot be resolved (a bad
      // AUTONOMY_LEVEL, CONCURRENCY, or a bad USAGE_STOP with the guard on), so the view shows no row rather than
      // the last run's as if they were next.
      let next = "{}";
      try {
        next = JSON.stringify(settingsGroup(resolveSettings({ env: process.env, project, machine: machineSettings(), apiKey: !!projectApiKeySpend(project) }), 1));
      } catch {}
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
          SANDCASTLE_SETTINGS: next,
          SANDCASTLE_MAX_SANDBOXES: String(limit("sandboxes")),
          SANDCASTLE_MAX_GATES: String(limit("gates")),
          // Sensed once here, never per redraw: a `ps` listing every few seconds would cost the pane more than the hint is worth.
          // Only where the view can show the hint: `status 0` into a pipe never draws it.
          SANDCASTLE_CLICK_MOD: process.stdout.isTTY && process.env.HERDR_ENV === "1" ? resolveClickHint().mod : "",
        },
      });
      process.exit(r.status ?? 0);
    }
    case "wait": {
      const given = args[0];
      if (args.length > 1 || (given !== undefined && !/^\d+(\.\d+)?$/.test(given))) {
        throw new OperatorError("Usage: sandcastle wait [seconds] - seconds is a number, 0 or more.");
      }
      const project = await loadProject(root);
      const waited = await waitForRun(root, given === undefined ? undefined : Number(given));
      if (!waited.ended) {
        // Not a failure of the run: the caller's own clock ran out.
        console.log(`The run is still live (pid ${waited.pid}) after ${given} s. \`sandcastle wait\` again keeps waiting; \`sandcastle stop\` stops it.`);
        process.exitCode = 124;
        break;
      }
      console.log(await closingReport(project));
      process.exitCode = recordedExitCode(root);
      break;
    }
    case "stop": {
      // SIGINT, what Ctrl-C sends the run in its terminal: it ends its sandboxes and records how it ended.
      const pid = livePid(root);
      if (pid === undefined) {
        console.log("No run is live.");
        break;
      }
      process.kill(pid, "SIGINT");
      console.log(`Stopping the run (pid ${pid}); \`sandcastle wait\` shows how it ended.`);
      break;
    }
    case "pause": {
      if (args.length) throw new OperatorError(`Unknown argument "${args[0]}" for sandcastle pause: it takes none.`);
      const paused = pauseRun(root);
      if (paused.kind === "no run") console.log("No run is live.");
      else if (paused.kind === "already") console.log(`The run (pid ${paused.pid}) is already paused, since ${clock(paused.since)}. \`sandcastle resume\` continues it.`);
      else if (paused.kind === "taken over") {
        console.log(
          `The run (pid ${paused.pid}) paused itself at ${clock(paused.since)} for its plan's usage (${usagePauseWords(paused.usage)}, it would resume at ${resumeClock(paused.usage.resumesAt)}). ` +
            "The pause is yours now: it stays until `sandcastle resume`, whatever the window does.",
        );
      }
      else {
        console.log(
          `Pausing the run (pid ${paused.pid}): no new ticket or agent pass starts, the passes in flight finish and their sandboxes close, and green branches still land. ` +
            "`sandcastle resume` continues it; `sandcastle status` shows what is still finishing.",
        );
      }
      break;
    }
    case "resume": {
      if (args.length) throw new OperatorError(`Unknown argument "${args[0]}" for sandcastle resume: it takes none.`);
      const resumed = resumeRun(root);
      if (resumed.kind === "no run") console.log("No run is live.");
      else if (resumed.kind === "not paused") console.log(`The run (pid ${resumed.pid}) is not paused.`);
      else {
        console.log(`Resuming the run (pid ${resumed.pid}, paused since ${clock(resumed.since)}): each paused ticket goes on from its next phase.`);
        if (resumed.usage) {
          console.log(`It was paused for its plan's usage (${usagePauseWords(resumed.usage)}, until ${resumeClock(resumed.usage.resumesAt)}): it does not pause again for a window that is over the threshold now until that window resets.`);
        }
      }
      break;
    }
    case "report": {
      if (args.includes("--changelog")) {
        const at = args.indexOf("--since");
        const since = at === -1 ? undefined : args[at + 1];
        if (at !== -1 && (!since || since.startsWith("--"))) throw new OperatorError("`--since` takes a git ref: `sandcastle report --changelog --since v1.2.0`.");
        console.log(changelogSince(await loadProject(root), since));
        break;
      }
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
      if (args.includes("--api-key")) process.env.SANDCASTLE_API_KEY = "1";
      await confirmApiKey(projectApiKeySpend(project), "Preflight");
      await preflight(project, await ensureImage(project));
      break;
    }
    case "queue": {
      // The queue and what holds each ticket back; `--json` is what the status view reads.
      const project = await loadProject(root);
      const tracker = makeTracker(project);
      if (args.includes("--lint")) {
        // Advice only: exit 0 whatever it finds. Tickets named here are the run's own: the same
        // set `sandcastle run N N` takes (a closed one is refused alike), not the whole queue.
        const given = args.filter((a) => !a.startsWith("-"));
        if (given.length) {
          for (const line of await lintQueue(project, tracker, namedTickets(tracker, given.join(",")), true)) console.log(line);
        } else for (const line of await lintQueue(project, tracker, tracker.queued(false))) console.log(line);
        break;
      }
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
        for (const r of rows) {
          // The run's own start-line text. A bad label is the run's refusal, shown here without stopping the listing.
          let own = "";
          try {
            own = implementNote(ticketOverride(tracker.ref(r.id), queued.find((t) => t.id === r.id)?.labels ?? []));
          } catch (e) {
            if (!(e instanceof OperatorError)) throw e;
            own = ` [${e.message}]`;
          }
          console.log(`  ${tracker.ref(r.id)} ${r.title}${own}${r.blockedOn.length ? `  [waits for ${r.blockedOn.join(", ")}]` : ""}`);
        }
        for (const line of await blockerProblems(project, tracker, queued)) console.log(`  warning: ${line}`);
        if (!rows.length) {
          // A queue is empty when nothing is labelled, not only when nothing is open: say how many
          // are waiting and where work comes from. A tracker that cannot be read keeps the bare line.
          let open: number | undefined;
          try {
            open = tracker.open(false).length;
          } catch {}
          console.log(
            open === undefined
              ? "  (empty)"
              : `  (empty) - ${open} open ticket(s) not in the queue. File tickets for the work, or run /sandcastle queue to triage the open ones.`,
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
      const { message, relabelled } = requeueTicketWithEffect(tracker, project.label, args);
      console.log(message);
      if (relabelled) console.log(LABEL_LAG_REMINDER);
      // A requeue asks for new work: without this, a kept green branch would land on the next run unread.
      const { id } = parseRequeueArgs(args);
      if (forgetHead(project.root, id)) console.log(`${tracker.ref(id)}: its recorded green head was dropped, so the next run re-implements it.`);
      // Warn only: a re-run of such a ticket costs a pipeline and ends held for the same paths.
      // Last, and never fatal: a failed re-read of the ticket must not undo a requeue that happened.
      try {
        const protectedPaths = protectedForTicket(project, id, tracker.get(id).body ?? "");
        if (protectedPaths.length) console.log(`${tracker.ref(id)} ${protectedWarning(protectedPaths)}`);
      } catch {}
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
      // A live run's sandboxes apply the lean-plan file this writes, it reads the base record this
      // writes, and its commits and landings would read as tampering to the check below. A killed run's
      // containers are reaped under the lock before the config is read: one still alive could write it past the pins.
      holdAndReap(project);
      // Before the pins take the config as it is: what an earlier, killed run's sandbox planted there is refused, not pinned.
      const baseline = assertGitConfigBaseline(project, "sandcastle gates", args.includes("--accept-git-config"));
      pinHostGitConfig(project.root);
      recordGitConfigStart(project, baseline);
      const fingerprint = gitFingerprint(project);
      try {
        await requireGreenBase(gateOnly(project), await ensureImage(project), writePlan(project).file, false, undefined, (when) => assertGitUnchanged(project, fingerprint, when, true));
      } finally {
        assertGitUnchanged(project, fingerprint, "after the gates", true);
        // Red gates end cleanly too: the check above passed, so the next start must not blame a sandbox for a change made since.
        recordGitConfigEnd(project);
      }
      console.log("All gates green on the base branch.");
      break;
    }
    case "land": {
      // The merge lands in this checkout, so it must be clean and no run may be merging into it.
      disableHostGitHooks();
      const project = await loadProject(root);
      // The lock and the reap of a killed run's containers come before the config is read, as a run's start has them.
      holdAndReap(project);
      const baseline = assertGitConfigBaseline(project, "sandcastle land", args.includes("--accept-git-config"));
      pinHostGitConfig(project.root);
      assertCleanBase(project);
      recordGitConfigStart(project, baseline);
      const landed = await landTicket(project, makeTracker(project), args.find((a) => a !== "--accept-git-config"), async () => {
        const image = await ensureImage(project);
        return { open: sandboxOpener(gateOnly(project), image, writePlan(project).file) };
      });
      recordGitConfigEnd(project);
      console.log(landed);
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
      // Asked before the image and the report, so a no costs nothing.
      if (args.includes("--measure")) {
        if (args.includes("--api-key")) process.env.SANDCASTLE_API_KEY = "1";
        await confirmApiKey(projectApiKeySpend(project), "lean --measure");
      }
      leanReport(project, p);
      const image = await ensureImage(project);
      // The plan, written only to key the green-base record (`hooksThatRanClean`): the project's own plan file is the
      // one a live run's next sandbox applies, and a preview of an edited config must not change it under that run.
      const planDir = mkdtempSync(join(tmpdir(), "sandcastle-lean-"));
      try {
        reportHookCheck(checkHooks(project, image, p, hooksThatRanClean(project, image, writePlan(project, planDir).file)), p.hooks.length);
      } finally {
        rmSync(planDir, { recursive: true, force: true });
      }
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
      // A project set up with this kit has no older notes to act on.
      markUpdated(root);
      // The lean check belongs to setup: what the repo would load into every
      // sandbox agent, all hidden until lean.keep names it.
      const project = await loadProject(root);
      leanReport(project, leanPlan(project));
      break;
    }
    case "updated": {
      const at = args.indexOf("--declined");
      const keys = at === -1 ? [] : (args[at + 1] ?? "").split(",");
      if (args.length !== (at === -1 ? 0 : 2) || keys.some((k) => !/^[a-z0-9][a-z0-9-]*$/.test(k))) {
        throw new OperatorError("Usage: sandcastle updated [--declined KEY[,KEY...]] - each KEY is an update step's key, such as claude-mod or autonomy-drain.");
      }
      // Read first: marking replaces the record, and the update action reports where the project was.
      const before = recordedRelease(root);
      console.log(updatedLine(before, markUpdated(root, KIT, keys)));
      break;
    }
    case "changes": {
      const at = args.indexOf("--since");
      const since = at === -1 ? undefined : args[at + 1];
      if (args.length !== (at === -1 ? 0 : 2) || (at !== -1 && !/^v?\d+\.\d+\.\d+$/.test(since ?? ""))) {
        throw new OperatorError("Usage: sandcastle changes [--since RELEASE] - RELEASE is a kit version such as 0.10.0.");
      }
      const diff = changesDiffLines(root, KIT, since);
      for (const line of [...changesLines(root, KIT, since), ...(diff.length ? [""] : []), ...diff]) console.log(line);
      break;
    }
    case "clean": {
      // Leftovers a run owns nobody: worktrees an interrupted or dirty sandbox
      // kept, and agent branches nothing reports once their row ages out. A
      // live run's own worktrees must survive, so this takes the run lock.
      disableHostGitHooks();
      const project = await loadProject(root);
      // The lock and the reap come first: a container a killed run left could still write the config being checked.
      holdAndReap(project);
      // Clean runs host git over whatever a killed run's sandbox left: what was planted in the config is refused, not pinned.
      const baseline = assertGitConfigBaseline(project, "sandcastle clean", args.includes("--accept-git-config"));
      pinHostGitConfig(project.root);
      recordGitConfigStart(project, baseline);
      const { containers, images, worktrees, deleted, kept, left } = cleanProject(project, args.includes("--all"), worktreeRefusal(project));
      recordGitConfigEnd(project);
      // After the branches above went: a merged branch's backup entry is dropped with it, and with
      // --all an unmerged one's too, as its work was let go with the branch.
      const backups = pruneBackup(project, { goneToo: args.includes("--all") });
      for (const id of containers) console.log(`removed exited sandbox container ${id}`);
      for (const id of images) console.log(`removed dangling image ${id}`);
      for (const path of worktrees) console.log(`removed worktree ${path}`);
      for (const { branch, unmerged } of deleted) console.log(`deleted ${branch}${unmerged ? " (unmerged)" : ""}`);
      for (const branch of backups) console.log(`dropped the backup copy of ${branch}`);
      archiveFinishedLogs(project);
      if (kept.length) {
        const standing = kept.map((k) => `${k.branch} (${k.ahead} commit(s) not on ${project.baseBranch})`);
        console.log(`\nUnmerged, kept:\n  ${standing.join("\n  ")}\n\`sandcastle clean --all\` deletes them too - their work is lost.`);
      }
      if (left.length) {
        console.log(`\nLeft as they are, git was not run in them:\n${left.map((l) => `  ${l.path}: ${l.reason}`).join("\n")}`);
        process.exitCode = 1;
      }
      if (!containers.length && !images.length && !worktrees.length && !deleted.length && !backups.length && !kept.length && !left.length) console.log("Nothing to clean.");
      break;
    }
    default:
      throw new OperatorError(`Unknown command "${command}". Run \`sandcastle help\`.`);
  }
} catch (error) {
  // A full disk is the operator's to fix, wherever the write was; its stack trace says nothing more.
  const full = (error as NodeJS.ErrnoException)?.code === "ENOSPC";
  if (!(error instanceof OperatorError) && !full) throw error;
  // A stopped run's summary printed its message already (`reportedError`).
  if (!wasReported(error)) {
    console.error(
      full
        ? `\nThe disk is full: writing ${(error as NodeJS.ErrnoException).path ?? "a file"} failed. Free some space (\`sandcastle clean\` removes finished worktrees; \`docker system df\` shows what Docker holds), then try again.`
        : `\n${(error as Error).message}`,
    );
  }
  process.exitCode = 1;
}
