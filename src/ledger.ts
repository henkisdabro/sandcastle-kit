// The ticket ledger: every ending the scheduler tells (schedule.ts), turned into everything a run
// says about its ticket - the state the run record holds, the outcome `outcomes.json` keeps, the
// word the view shows and the text the tracker gets. `describe` is pure and covers every `Ending`
// kind; the type checker holds that. The writer (`createLedger`) records what it returns as burndown
// is told each ending, and keeps each ticket's entry for the closing counts (`accountLanding`). It
// records a requeue as it is told, too: the scheduler's requeue-once rule (schedule.ts) sends the
// ticket back, and the ledger writes it queued with the line its second attempt carries. Beside the
// endings it writes a green branch as it waits to land (`ready`), and, once the schedule is over,
// the tickets the run's stop left unstarted, in the run's last words (`close`).
//
// One landing ending used to be translated five times - by landOne, the Landings lists, the outcome
// lines, the view's loops and the tracker comments - and each new ending kind meant touching every
// one of them. `landOne` writes no verdict, so a requeue has nothing to undo: a requeued ticket whose
// second attempt never begins is recorded from the ending the scheduler makes of it. Posting stays
// where it happens: `landOne` closes and holds at landing time and asks `describe` for the words;
// the burndown posts the hold notes and the comments after the schedule. An ending arrives
// complete - the agent's hand-back is on its pipeline's result - so nothing is patched in later.

import type { Outcome, TicketRecord } from "../mod/hooks/run-record.ts";
import { remainderNote } from "./autonomy.ts";
import { type Gate, gateLine } from "./gates.ts";
import { guardWords, largeFilesNote } from "./guard.ts";
import type { Project } from "./config.ts";
import { againNoteOf, conflictLine, type Landable, type Landed, redDetail, redNote, requeuedLine } from "./landing.ts";
import { overrunLine, overrunNoted } from "./report.ts";
import { HANDED_BACK, readOutcomes, recordOutcomes } from "./run.ts";
import { errorLine } from "./sandbox.ts";
import type { Again, Change, Ending, StopCause } from "./schedule.ts";
import { refOf } from "./tracker.ts";

/** What the ledger reads of a pipeline's result: burndown's own `Outcome` is one. */
export type Finished = {
  issue: string;
  branch: string;
  status: "green" | "gate-failed" | "nochange" | "merged-earlier" | "held" | "conflict";
  /** What its branch no longer merged onto the base with, before its review or gates (`conflict`). */
  conflict?: { files: string[]; with: string[] };
  /** Why the kit held a finished branch for a person (`held`). */
  heldNote?: string;
  /**
   * The agent handed the ticket back itself (`nochange`): the tracker's hold label on it, read in
   * the attempt as its pipeline ended. Said "nothing to change", a question for a human read as a
   * ticket that needed no work.
   */
  handedBack?: boolean;
  commits: number;
  head?: string;
  repairs: number;
  gates: Gate[];
};

/** One ticket's ending as the ledger reads it: a green branch at landing, a pipeline's result otherwise. */
export type TicketEnding = Ending<Landable, Finished>;

/**
 * What `describe` needs beside the ending: the run's own words, and facts about the ticket the
 * ending does not carry yet.
 */
export type Context = {
  base: string;
  /** The project's gates, named, for the close comment and a hold. */
  gateNames: string;
  /** What the agents reported, for the close comment and the not-landed comment. */
  report?: string;
  dryRun?: boolean;
  /** Where Sandcastle kept the pipeline's worktree, as the record shows it: its uncommitted files. */
  kept?: string;
  /**
   * A hold note the run posts after the schedule (the agent's `<blocked>`, or the kit's own hold):
   * the ticket gets that note, never a second comment. A hold label the agent put on the ticket
   * itself is on its pipeline's result instead (`Finished.handedBack`).
   */
  hold?: "note";
  /** Why the run stopped, as a ticket it never started says it. */
  stopLine?: string;
  /** The line this run requeued the ticket with (`requeuedLine`): its second attempt runs, or never began. */
  requeued?: string;
};

/** What a run says about one ending: each is absent where the run says nothing of it. */
export type Said = {
  /** The ticket state and note the run ends on. */
  record?: TicketRecord;
  outcome?: Outcome;
  /** The view's word, and whether it counts the ticket as landed (otherwise a person has to act). */
  view?: { word: string; landed: boolean };
  /** What the tracker gets: the close comment, a hold, or the one comment on a ticket that did not land. */
  tracker?: { kind: "close" | "hold" | "comment"; text: string };
};

/** Why a repaired green branch is held when the review of its repair failed. */
export const UNREVIEWED = "repair commits not reviewed: the review after repair failed";

/**
 * The per-ticket line's words for a ticket's repair passes: ` repaired=1` counts those that committed, and a pass
 * that changed nothing is not one (the repairer judged the red a flake) - it is said apart, ` repair made no change`.
 */
export const repairWords = (o: { repairs: number; idleRepairs?: number }) => {
  const idle = o.idleRepairs ?? 0;
  return `${o.repairs ? ` repaired=${o.repairs}` : ""}${idle ? ` ${idle === 1 ? "repair made" : `${idle} repairs made`} no change` : ""}`;
};

// The ticket closes on the local merge, so the comment says the work is not on
// the remote yet: a repo that deploys on push has nothing live when this reads "done".
export const closeComment = (
  o: { branch: string; commits: number; repairs: number; regenerated?: { files: string[]; regen: string[] }; overrun?: string[] },
  gateNames: string,
  report?: string,
): string =>
  `Merged locally, not yet pushed, by the Sandcastle loop from \`${o.branch}\` (${o.commits} commit(s)` +
  (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
  `); ${gateNames} all green before merge.` +
  (o.regenerated
    ? ` Conflicts in generated files (${o.regenerated.files.join(", ")}) were resolved by running ${o.regenerated.regen.map((c) => `\`${c}\``).join(", ")}.`
    : "") +
  (overrunNoted(o.overrun) ? `\n\n${overrunLine(o.overrun!)}` : "") +
  (report ? `\n\n${report}` : "");

// A merged ticket left open, an acceptance criterion undone: the comment says what, and that the
// next run picks up the remainder (or whose decision it is). Posted after the schedule, as the comment on any ticket not closed.
export const partlyDoneComment = (
  o: { branch: string; commits: number; repairs: number; unmet: string; regenerated?: { files: string[]; regen: string[] }; overrun?: string[] },
  gateNames: string,
  report?: string,
): string =>
  `Merged locally, not yet pushed, by the Sandcastle loop from \`${o.branch}\` (${o.commits} commit(s)` +
  (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
  `); ${gateNames} all green before merge. **Left open: an acceptance criterion is unmet.** ${o.unmet}\n\n` +
  remainderNote(o.unmet) +
  (o.regenerated
    ? ` Conflicts in generated files (${o.regenerated.files.join(", ")}) were resolved by running ${o.regenerated.regen.map((c) => `\`${c}\``).join(", ")}.`
    : "") +
  (overrunNoted(o.overrun) ? `\n\n${overrunLine(o.overrun!)}` : "") +
  (report ? `\n\n${report}` : "");

// The one comment a ticket that did not land gets: the conflict (the other
// ticket and the files), the agents' report, or both - never two comments.
export const notLandedComment = (
  report: string | undefined,
  conflict: { branch: string; base: string; files: string[]; with: string[] } | undefined,
  red?: { branch: string; base: string; with: string[]; gates: string[]; failing?: string[] },
): string | undefined => {
  if (red) {
    return (
      `Sandcastle ran this ticket and did not land it: \`${red.branch}\` was green on its own, but merged into \`${red.base}\` the gates were red (${red.gates.join(", ")}). ` +
      (red.failing?.length ? `Failing: ${red.failing.join(", ")}. ` : "") +
      (red.with.length
        ? `Landed on \`${red.base}\` since this branch forked, changing a file it also changed: ${red.with.map(refOf).join(", ")}. `
        : "Red on the merged tree: no ticket landed since this branch forked changed a file it changed. ") +
      `Nothing was merged. The next run merges \`${red.base}\` into the branch and tries again.` +
      (report === undefined ? "" : `\n\nWhat the agents reported:\n\n${report}`)
    );
  }
  if (!conflict) return report === undefined ? undefined : `Sandcastle ran this ticket and did not land it. What the agents reported:\n\n${report}`;
  return (
    `Sandcastle ran this ticket and did not land it: merging \`${conflict.branch}\` into \`${conflict.base}\` conflicted (${conflictLine(conflict)}). ` +
    `The next run merges \`${conflict.base}\` into the branch and tries again.` +
    (report === undefined ? "" : `\n\nWhat the agents reported:\n\n${report}`)
  );
};

/** The outcome text of a landing hold (a protected path, a large file, unreviewed repair commits): the report looks up the hold's reason in that run's history line (`heldReasonIn`) by it. */
export const LANDING_HOLD = "needs a human merge";

// A branch's outcome as the status view's row shows it, before landing. `uncommitted`: its finished work sits in a kept worktree.
export const pipelineOutcome = (o: Pick<Finished, "status" | "gates" | "heldNote">, uncommitted: boolean): Outcome =>
  uncommitted
    ? { kind: "uncommitted", text: "uncommitted" }
    : o.status === "gate-failed"
      ? { kind: "gate red", text: `gate red: ${gateLine(o.gates.filter((g) => !g.pass))}` }
      : o.status === "green"
        ? { kind: "green", text: "green - waiting to land" }
        : o.status === "merged-earlier"
          ? { kind: "merged", text: o.status }
          : o.status === "held"
            ? { kind: "held", text: `needs a human: ${o.heldNote ?? "held"}` }
            : o.status === "conflict"
              ? { kind: "conflict", text: "merge conflict before landing" }
              : { kind: "no change", text: o.status };

/** A ticket its label refuses, found as it would have started: skipped, saying why. */
export const refusedRecord = (reason: string): TicketRecord => ({ state: "skipped", note: reason.replace(/^NOT STARTED: /, "not started: ") });

/** The record of a ticket the tracker withdrew before its attempt began. */
export const withdrawnRecord = (reason: string): TicketRecord => ({ state: "withdrawn", note: `${reason.replace(" during the run", "")} - not started` });

/** Marked for a human by a person during the run: the tracker's word, as landing reads it. */
const TAKEN_BACK = "marked for a human during the run";

const NEEDS_A_HUMAN = { word: "needs a human", landed: false };

/** The comment on a ticket that did not land, when there is anything to say. */
const comment = (text: string | undefined): Said["tracker"] => (text === undefined ? undefined : { kind: "comment", text });

const describeLanding = (e: Extract<TicketEnding, { kind: "landing" }>, c: Context): Said => {
  const { green: g, landed } = e;
  const withOf = (w: string[]) => (w.length ? { with: w } : {});
  const overrunOf = (o: string[] | undefined) => (o?.length ? { overrun: o } : {});
  const plain = comment(notLandedComment(c.report, undefined));
  const said = ((): Said => {
    switch (landed.kind) {
      case "merged":
        return {
          record: { state: "merged", note: landed.regenerated ? "merged and closed (generated files regenerated)" : "merged and closed", ...overrunOf(landed.overrun) },
          outcome: { kind: "merged", text: "merged" },
          view: { word: "merged", landed: true },
          tracker: { kind: "close", text: closeComment({ ...g, regenerated: landed.regenerated, overrun: landed.overrun }, c.gateNames, c.report) },
        };
      case "close-failed":
        return {
          record: { state: "merged", note: "merged; closing the ticket failed", closeFailed: landed.error, ...overrunOf(landed.overrun) },
          outcome: { kind: "merged", text: "merged (ticket not closed)" },
          view: { word: "merged, not closed", landed: true },
          tracker: { kind: "close", text: closeComment({ ...g, regenerated: landed.regenerated, overrun: landed.overrun }, c.gateNames, c.report) },
        };
      case "partly-done":
        return {
          record: { state: "merged", note: "merged; ticket left open (a criterion is unmet)", unmet: landed.unmet, ...overrunOf(landed.overrun) },
          outcome: { kind: "merged", text: "merged (partly done)" },
          view: { word: "merged, partly done", landed: true },
          tracker: comment(partlyDoneComment({ ...g, unmet: landed.unmet, regenerated: landed.regenerated, overrun: landed.overrun }, c.gateNames, c.report)),
        };
      case "closed-earlier":
        return {
          record: { state: "merged", note: `closed, merged earlier (${g.head})` },
          outcome: { kind: "merged", text: "merged-earlier" },
          view: { word: "closed", landed: true },
          tracker: { kind: "close", text: `Merged into \`${c.base}\` by an earlier Sandcastle run (${g.head}); closing.` },
        };
      case "conflict": {
        // A second conflict is held with the tickets of both attempts named.
        const line = e.again ? againNoteOf(landed, e.again.kind) : conflictLine(landed);
        return {
          record: { state: "conflict", note: line, files: landed.files },
          outcome: { kind: "conflict", ...withOf(landed.with), text: `merge conflict: ${line}` },
          view: { word: "merge conflict", landed: false },
          tracker: comment(notLandedComment(c.report, { branch: g.branch, base: c.base, files: landed.files, with: landed.with })),
        };
      }
      case "red": {
        const refs = landed.with.map(refOf).join(", ");
        return {
          // The pair, named: which tickets this one is red with.
          record: {
            state: "red",
            note: e.again ? againNoteOf(landed, e.again.kind) : redNote(landed),
            ...(landed.failing?.length ? { failing: landed.failing } : {}),
          },
          outcome: { kind: "red", ...withOf(landed.with), text: e.again ? againNoteOf(landed, e.again.kind) : `red when merged${landed.with.length ? ` with ${refs}` : ""}${redDetail(landed)}` },
          view: { word: "red when merged", landed: false },
          tracker: comment(notLandedComment(c.report, undefined, { branch: g.branch, base: c.base, with: landed.with, gates: landed.gates, failing: landed.failing })),
        };
      }
      case "held": {
        const also = c.report ? `\n\n${c.report}` : "";
        const text =
          landed.by === "protected"
            ? `Gated green on \`${g.branch}\` (${c.gateNames}), but not merged automatically: it changes how the repo ` +
              `executes (${landed.paths.join(", ")}), which its own gates cannot vouch for. Review and merge by hand.${also}`
            : landed.by === "large"
              ? `Gated green on \`${g.branch}\` (${c.gateNames}), but not merged automatically: it ${largeFilesNote(landed.paths)}.${also}`
              : `Gated green on \`${g.branch}\` after a repair, but not merged: ${UNREVIEWED}. Review the repair commits and merge by hand.`;
        return {
          record: { state: "held", note: landed.reason, ...(landed.paths.length ? { files: landed.paths } : {}) },
          outcome: { kind: "held", text: LANDING_HOLD },
          view: NEEDS_A_HUMAN,
          tracker: { kind: "hold", text },
        };
      }
      case "withdrawn":
        return {
          record: { state: "withdrawn", note: landed.reason },
          outcome: { kind: "withdrawn", text: `withdrawn: ${landed.reason}` },
          view: { word: "withdrawn", landed: true },
          tracker: plain,
        };
      case "taken-back":
        return {
          record: { state: "held", note: TAKEN_BACK },
          outcome: { kind: "taken back", text: `needs a human: ${TAKEN_BACK}` },
          view: NEEDS_A_HUMAN,
          tracker: plain,
        };
      case "skipped":
        return {
          record: { state: "not landed", note: landed.reason },
          outcome: { kind: "not landed", text: `not merged: ${landed.reason}` },
          view: { word: "not merged", landed: false },
          tracker: plain,
        };
      case "not-landed":
        return {
          record: { state: "not landed", note: landed.reason },
          outcome: { kind: "not landed", text: "failed to land" },
          view: { word: "failed to land", landed: false },
          tracker: plain,
        };
      case "dry-run": {
        const close = g.status === "merged-earlier";
        return {
          record: { state: "ready", note: close ? "dry run: would close" : "dry run: would merge" },
          outcome: close ? { kind: "merged", text: "merged-earlier" } : { kind: "green", text: "dry run: gated green, would merge" },
          tracker: plain,
        };
      }
    }
  })();
  // Requeued, and its second attempt never began: its first landing stands, or, withdrawn since,
  // that - recorded as a ticket withdrawn before it started, never as the green the first pipeline
  // left. Either way the record no longer promises a second attempt.
  const unstarted = c.requeued !== undefined && (e.attempts === 1 || e.unstarted === true);
  const record = unstarted && said.record ? { ...(landed.kind === "withdrawn" ? withdrawnRecord(landed.reason) : said.record), requeued: null } : said.record;
  // A dry run lands nothing: every branch it gated green reads as one it would merge.
  return { ...said, record, ...(c.dryRun && g.status === "green" && { outcome: { kind: "green", text: "dry run: gated green, would merge" } }) };
};

const describePipeline = (o: Finished, c: Context): Said => {
  const repaired = o.repairs ? `, ${o.repairs} repair(s)` : "";
  // A pipeline that ended with no commits, its worktree kept: the agent's commit was refused, and the work exists.
  const uncommitted = o.status === "nochange" && o.commits === 0 && c.kept !== undefined;
  // A hold note on a ticket whose finished work sits uncommitted keeps its own state: the work exists.
  const held = o.handedBack === true || (c.hold === "note" && c.kept === undefined);
  const record = ((): TicketRecord => {
    switch (o.status) {
      case "green":
        return { state: "ready", note: `gates green${repaired}` };
      case "merged-earlier":
        return { state: "ready", note: `merged earlier (${o.head}) - to close` };
      case "gate-failed":
        return { state: "red", note: `${o.gates.filter((g) => !g.pass).map((g) => g.name).join(", ")} red${repaired}` };
      case "held":
        return { state: "held", note: o.heldNote ?? "held for a human" };
      // The scheduler ends such a branch as a `conflict` (`describeConflict`): this is the pipeline's own word for it.
      case "conflict":
        return { state: "conflict", note: `no longer merges onto ${c.base}${o.conflict ? `: ${conflictLine(o.conflict)}` : ""}`, ...(o.conflict && { files: o.conflict.files }) };
      case "nochange":
        if (uncommitted) return { state: "uncommitted", note: `work left uncommitted in ${c.kept}` };
        if (held) return { state: "held", note: "handed back - for a human" };
        return { state: "nochange", note: c.hold === "note" ? "handed back - for a human" : "nothing to change" };
    }
  })();
  return {
    record,
    outcome: o.handedBack ? { kind: "held", text: HANDED_BACK } : pipelineOutcome(o, uncommitted),
    ...(held && { view: NEEDS_A_HUMAN }),
    tracker: comment(notLandedComment(c.report, undefined)),
  };
};

/**
 * A branch that no longer merged onto the base before its review or gates, and was not sent back (again). Said as a
 * landing's conflict is, but as found before landing: nothing was reviewed or gated for a merge that could not land.
 * Sent back and never begun again, it keeps this ending (or, withdrawn since, is said as withdrawn), and the record
 * no longer promises a second attempt.
 */
const describeConflict = (e: Extract<TicketEnding, { kind: "conflict" }>, c: Context): Said => {
  const { outcome: o, conflict } = e;
  const unstarted = c.requeued !== undefined && e.unstarted === true;
  if (e.withdrawn !== undefined)
    return {
      record: { ...withdrawnRecord(e.withdrawn), ...(unstarted && { requeued: null }) },
      outcome: { kind: "withdrawn", text: `withdrawn: ${e.withdrawn}` },
      view: { word: "withdrawn", landed: true },
      tracker: comment(notLandedComment(c.report, undefined)),
    };
  const line = e.again ? againNoteOf({ kind: "conflict", ...conflict }, e.again.kind) : conflictLine(conflict);
  return {
    record: { state: "conflict", note: e.again ? line : `no longer merges onto ${c.base}: ${line}`, files: conflict.files, ...(unstarted && { requeued: null }) },
    outcome: { kind: "conflict", ...(conflict.with.length ? { with: conflict.with } : {}), text: `merge conflict before landing: ${line}` },
    view: { word: "merge conflict", landed: false },
    tracker: comment(notLandedComment(c.report, { branch: o.branch, base: c.base, files: conflict.files, with: conflict.with })),
  };
};

/**
 * Everything a run says about one ending, in today's words. Pure: the ending and its context in,
 * the words out. `record` is the state the run ends the ticket on; a waiting ticket keeps the one
 * the file hold or its blockers wrote.
 */
export const describe = (e: TicketEnding, c: Context): Said => {
  const said = describeEnding(e, c);
  // A ticket with a hold note gets that note, never a second comment.
  return c.hold === "note" && said.tracker?.kind === "comment" ? { ...said, tracker: undefined } : said;
};

const describeEnding = (e: TicketEnding, c: Context): Said => {
  switch (e.kind) {
    case "landing":
      return describeLanding(e, c);
    case "pipeline":
      return describePipeline(e.outcome, c);
    case "conflict":
      return describeConflict(e, c);
    case "crashed":
      return {
        // The land port threw (`green`), or the pipeline did: each says its error as it always has.
        record: { state: "crashed", note: e.green ? errorLine(e.error) : String(e.error).split("\n")[0].slice(0, 160) },
        outcome: { kind: "crashed", text: "crashed" },
        tracker: comment(notLandedComment(c.report, undefined)),
      };
    case "stopped":
      // Green before the base moved, or green when its own `.git` check failed: finished, and
      // landing on a later run - not "ready", which says this run lands it.
      return {
        record: { state: "stopped", note: "finished before the run stopped - lands on a later run" },
        outcome: { kind: "stopped", text: "stopped: the run stopped before landing" },
        tracker: comment(notLandedComment(c.report, undefined)),
      };
    case "not begun": {
      const { why } = e;
      const record = why.kind === "withdrawn" ? withdrawnRecord(why.reason) : why.kind === "refused label" ? refusedRecord(why.reason) : why.kind === "plan limit" ? { state: "skipped" as const, note: `not started: the plan's usage limit stopped it${why.resets ? ` (resets ${why.resets})` : ""}` } : { state: "skipped" as const, note: `not started: ${c.stopLine ?? "the run stopped"}` };
      return { record, tracker: comment(notLandedComment(c.report, undefined)) };
    }
    case "waiting":
      return {};
    case "parked":
      // Nothing more to say: its record is the `paused` state and the note its juncture wrote ("before review at <head>"),
      // which the closing summary lists as runnable - the same as for a run stopped, or killed, while paused.
      return {};
    default:
      return e satisfies never;
  }
};

/** Never begun because the run stopped: said in the run's last words, which only the end of the schedule knows. */
const unstarted = (e: TicketEnding) =>
  e.kind === "not begun" && e.why.kind !== "withdrawn" && e.why.kind !== "refused label";

/** The writer's `outcomes` port onto the project's `outcomes.json`: the ledger is its only writer, so burndown hands it this. */
export const outcomesFile = (project: Project, run: string) => (outcomes: Record<string, Outcome>) => recordOutcomes(project, run, outcomes);

/**
 * A ticket `sandcastle land` merged, which no run is there to record: a run that stopped left it `stopped`, and the
 * outcome is what `report --changelog` and the closing summary read. The run it belonged to is kept, so that run's
 * summary still finds the entry; a ticket with none is filed under the landing's own time. A record that will not
 * save is no reason to hide the merge, which is made.
 */
export const recordHandLanding = (project: Project, id: string, partly: boolean) => {
  try {
    recordOutcomes(project, readOutcomes(project.root)[id]?.run ?? new Date().toISOString(), { [id]: { kind: "merged", text: partly ? "merged (partly done)" : "merged by sandcastle land" } });
  } catch {
    /* the merge stands; the ticket's own comment is still to write */
  }
};

/** One ticket's entry: its ending, the context it was described in, and what was said. */
export type Entry = { id: string; ending: TicketEnding; context: Context; said: Said };

/**
 * The writer: records what `describe` says of each ending as burndown is told it - the ticket state
 * the run ends on, the outcome and the view's word; it is the only writer of each - and keeps the
 * entry. An ending arrives complete (a hand-back is on the pipeline's result), so each is recorded
 * once; only a ticket the run's stop left unstarted waits for the run's last words (`close`).
 * `bookkeep` keeps a write that throws (a full disk) from costing the ticket its ending.
 *
 * A requeue is recorded as it is told, before the ticket is pushed back: queued, with the line its
 * second attempt's setup carries (`requeuedAs`). A requeued ticket withdrawn before its second
 * attempt began has `dropFirst` remove its first pipeline's entry from the per-issue lines.
 */
export const createLedger = (d: {
  run: { ticket(id: string, fields: TicketRecord): void };
  outcomes(outcomes: Record<string, Outcome>): void;
  view: { landed(issue: string, ok: boolean, word: string): void };
  context(id: string): Context;
  bookkeep(id: string, fn: () => void): void;
  dropFirst(id: string): void;
  ref(id: string): string;
  say(line: string): void;
}) => {
  const entries = new Map<string, Entry>();
  // Every ticket this run requeued, with its line; `requeuedAs` only while its second attempt is to come.
  const sentBack = new Map<string, string>();
  const requeuedAs = new Map<string, string>();
  // The run's last words, once the schedule is over: until then a ticket it left unstarted has none.
  let last: { stopLine?: string } | undefined;
  const requeued = (id: string, again: Again) => {
    const line = requeuedLine(again.kind, again.with, again, again.found);
    sentBack.set(id, line);
    requeuedAs.set(id, line);
    d.bookkeep(id, () => d.run.ticket(id, { state: "queued", note: line, requeued: line }));
    d.say(`${d.ref(id)}: ${line}; it is tried again in this run.`);
  };
  const record = (id: string, ending: TicketEnding) => {
    let said: Said = {};
    d.bookkeep(id, () => {
      const line = sentBack.get(id);
      const context = { ...d.context(id), ...(line !== undefined && { requeued: line }), ...(last?.stopLine !== undefined && { stopLine: last.stopLine }) };
      said = describe(ending, context);
      entries.set(id, { id, ending, context, said });
    });
    const { record, outcome, view } = said;
    if (record && (!unstarted(ending) || last)) d.bookkeep(id, () => d.run.ticket(id, record));
    if (outcome) d.bookkeep(id, () => d.outcomes({ [id]: outcome }));
    if (view) d.bookkeep(id, () => d.view.landed(id, view.landed, view.word));
    // The landing worker's only voice in the run's output: without it, a run that spends its last
    // half hour landing prints nothing between the last agent pass and the closing summary.
    // A hold carries its reason: "needs a human" alone sent the reader to run.json for the paths.
    // A conflict found before landing ends the ticket as finally as one at landing: said the same way.
    if (view && (ending.kind === "landing" || ending.kind === "conflict")) d.say(`${d.ref(id)}: ${view.word}${record?.state === "held" && record.note ? `: ${record.note}` : ""}.`);
    // A hand-back is as final as a landing, and nothing else prints it before the closing summary. A
    // conflict-resolution hold (status `held`) is excluded: burndown prints that one as it holds it.
    if (ending.kind === "pipeline" && ending.outcome.status !== "held" && record?.state === "held") d.say(`${d.ref(id)}: ${record.note}.`);
    // Sent back, and its second attempt never began: withdrawn since, its first pipeline's line goes too.
    if (ending.kind === "landing" && (ending.attempts === 1 || ending.unstarted === true) && requeuedAs.delete(id) && ending.landed.kind === "withdrawn") d.dropFirst(id);
    if (ending.kind === "conflict" && ending.unstarted === true && requeuedAs.delete(id) && ending.withdrawn !== undefined) d.dropFirst(id);
  };
  return {
    entries: entries as ReadonlyMap<string, Entry>,
    /**
     * How a ticket of the run that ended without landing reads in the note of what waits for it,
     * from the state its ending is recorded as - also for one the stop left unstarted, whose record
     * waits for the run's last words: `stopped`, `gate red`, `not started`. Never "not in this run".
     */
    endedAs: (id: string): string => stateWord(entries.get(id)?.said.record?.state),
    /** The line each requeued ticket's second attempt carries, by ticket. */
    requeuedAs: requeuedAs as ReadonlyMap<string, string>,
    requeued,
    record,
    /**
     * A green branch as its pipeline ends, before the scheduler makes an ending of it: ready, and
     * its outcome now - a branch waiting for landing had none for this run, and its row read as an
     * earlier run's leftover. `held`: what will hold it for a person at landing, said now rather
     * than only at the end of the run.
     */
    ready(id: string, o: Finished, held: string[]) {
      const { record, outcome } = describePipeline(o, d.context(id));
      const human = held.length && o.status === "green";
      if (record) d.bookkeep(id, () => d.run.ticket(id, human ? { state: "ready", note: `human merge: ${held.join(", ")}` } : record));
      if (outcome) d.bookkeep(id, () => d.outcomes({ [id]: outcome }));
    },
    /** What the scheduler tells that the ledger records: a requeue, and each ticket's ending. */
    tell(c: Change<Landable, Finished>) {
      if (c.kind === "requeued") requeued(c.id, c.again);
      if (c.kind === "ended") record(c.id, c.ending);
    },
    /**
     * The schedule is over: each ticket the run's stop left unstarted is recorded in the run's last
     * words, `stopLine` - the most severe cause, which a ticket told earlier could not know yet.
     */
    close(endings: ReadonlyMap<string, TicketEnding>, stopLine: string | undefined) {
      last = { stopLine };
      for (const [id, e] of endings) if (unstarted(e)) record(id, e);
    },
  };
};

/** What the closing notification and the verify still read of the run's landings. */
export type Landings = {
  /** In the order they landed. */
  merged: string[];
  /** Merged by regenerating generated files in a sandbox: a tree no gate has seen. */
  regenerated: number;
  /** Conflicted (at landing, or before it), red once merged, failed to land, or not merged. */
  notLanded: number;
  /** Held at landing, taken back by a person, or handed back through the tracker's hold label. */
  needsHuman: number;
  withdrawn: number;
};

/** The landings counted from the ledger's entries. */
export const accountLanding = (entries: Iterable<Entry>): Landings => {
  const l: Landings = { merged: [], regenerated: 0, notLanded: 0, needsHuman: 0, withdrawn: 0 };
  for (const { id, ending: e } of entries) {
    if (e.kind === "pipeline" && e.outcome.handedBack) l.needsHuman++;
    // A conflict found before landing is not landed as one found at landing is.
    if (e.kind === "conflict") {
      if (e.withdrawn !== undefined) l.withdrawn++;
      else l.notLanded++;
    }
    if (e.kind !== "landing") continue;
    const landed: Landed = e.landed;
    switch (landed.kind) {
      case "merged":
      case "close-failed":
      case "partly-done":
        l.merged.push(id);
        if (landed.regenerated) l.regenerated++;
        break;
      case "conflict":
      case "red":
      case "not-landed":
      case "skipped":
        l.notLanded++;
        break;
      case "held":
      case "taken-back":
        l.needsHuman++;
        break;
      case "withdrawn":
        l.withdrawn++;
        break;
      case "closed-earlier":
      case "dry-run":
        break;
    }
  }
  return l;
};

/**
 * How a stop's cause reads in the notes of the tickets it left unstarted and in the closing
 * summary. A `.git` stop says what moved (`main moved while sandboxes ran`), so a ticket never
 * started because the base moved does not read as tampering with the shared `.git`.
 */
export const causeWords = (c: StopCause, ref: (id: string) => string): string => {
  switch (c.kind) {
    case "plan limit":
      return `${ref(c.ticket)} hit the plan's usage limit${c.resets ? ` (resets ${c.resets})` : ""}`;
    case "usage limit":
      return c.line;
    case "tampered":
    case "host failed":
      return guardWords(c.error).what;
  }
};

/**
 * The line printed once, as a safety stop first holds (the scheduler's `stopped landing`): the
 * cause in a few words, and what the run does from here. The commits or files to check, and what to do about
 * them, are the closing summary's one full statement of the stop (the guard's message), not said here as well.
 */
export const stoppedLine = (c: StopCause, ref: (id: string) => string): string =>
  `STOPPED landing: ${causeWords(c, ref)} - the run finishes what is in flight and lands nothing more; the closing summary says what to check.`;

/** A ticket state in the words of a waiting ticket's note. */
const stateWord = (state: string | undefined): string =>
  state === undefined ? "did not land" : state === "red" ? "gate red" : state === "nochange" ? "no change" : state === "skipped" ? "not started" : state;
