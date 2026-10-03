// The ticket ledger: every ending the scheduler tells (schedule.ts), turned into everything a run
// says about its ticket - the state the run record holds, the outcome `outcomes.json` keeps, the
// word the view shows and the text the tracker gets. `describe` is pure and covers every `Ending`
// kind; the type checker holds that. The writer (`createLedger`) records what it returns as burndown
// is told each ending, and keeps each ticket's entry for the closing counts (`accountLanding`).
//
// One landing ending used to be translated five times - by landOne, the Landings lists, the outcome
// lines, the view's loops and the tracker comments - and each new ending kind meant touching every
// one of them. Posting stays where it happens: `landOne` closes and holds at landing time and asks
// `describe` for the words; the burndown posts the comments after the schedule.

import type { Outcome, TicketRecord } from "../mod/hooks/run-record.ts";
import { type Gate, gateLine } from "./gates.ts";
import { largeFilesNote } from "./guard.ts";
import { againNoteOf, conflictLine, type Landable, type Landed, STOPPED_GREEN, withdrawnRecord } from "./landing.ts";
import { overrunLine } from "./report.ts";
import { errorLine } from "./sandbox.ts";
import type { Ending } from "./schedule.ts";
import { refOf } from "./tracker.ts";

/** What the ledger reads of a pipeline's result: burndown's own `Outcome` is one. */
export type Finished = {
  issue: string;
  branch: string;
  status: "green" | "gate-failed" | "nochange" | "merged-earlier" | "held";
  /** Why the kit held a finished branch for a person (`held`). */
  heldNote?: string;
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
   * A hold the ticket has besides its ending: a hold note the run posts after the schedule (the
   * agent's `<blocked>`, or the kit's own hold), or the tracker's hold label an agent put on itself.
   */
  hold?: "note" | "label";
  /** Why the run stopped, as a ticket it never started says it. */
  stopLine?: string;
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
  (o.overrun?.length ? `\n\n${overrunLine(o.overrun)}` : "") +
  (report ? `\n\n${report}` : "");

// The one comment a ticket that did not land gets: the conflict (the other
// ticket and the files), the agents' report, or both - never two comments.
export const notLandedComment = (
  report: string | undefined,
  conflict: { branch: string; base: string; files: string[]; with: string[] } | undefined,
  red?: { branch: string; base: string; with: string[]; gates: string[] },
): string | undefined => {
  if (red) {
    return (
      `Sandcastle ran this ticket and did not land it: \`${red.branch}\` was green on its own, but merged into \`${red.base}\` the gates were red (${red.gates.join(", ")}). ` +
      (red.with.length ? `Landed on \`${red.base}\` since this branch forked: ${red.with.map(refOf).join(", ")}. ` : "") +
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
            : { kind: "no change", text: o.status };

/** A ticket its label refuses, found as it would have started: skipped, saying why. */
export const refusedRecord = (reason: string): TicketRecord => ({ state: "skipped", note: reason.replace(/^NOT STARTED: /, "not started: ") });

/** Marked for a human by a person during the run: the tracker's word, as landing reads it. */
const TAKEN_BACK = "marked for a human during the run";

const NEEDS_A_HUMAN = { word: "needs a human", landed: false };

/** The comment on a ticket that did not land, when there is anything to say. */
const comment = (text: string | undefined): Said["tracker"] => (text === undefined ? undefined : { kind: "comment", text });

const describeLanding = (e: Extract<TicketEnding, { kind: "landing" }>, c: Context): Said => {
  const { green: g, landed } = e;
  const withOf = (w: string[]) => (w.length ? { with: w } : {});
  const plain = comment(notLandedComment(c.report, undefined));
  const said = ((): Said => {
    switch (landed.kind) {
      case "merged":
        return {
          record: { state: "merged", note: landed.regenerated ? "merged and closed (generated files regenerated)" : "merged and closed" },
          outcome: { kind: "merged", text: "merged" },
          view: { word: "merged", landed: true },
          tracker: { kind: "close", text: closeComment({ ...g, regenerated: landed.regenerated, overrun: landed.overrun }, c.gateNames, c.report) },
        };
      case "close-failed":
        return {
          record: { state: "merged", note: "merged; closing the ticket failed" },
          outcome: { kind: "merged", text: "merged (ticket not closed)" },
          view: { word: "merged, not closed", landed: true },
          tracker: { kind: "close", text: closeComment({ ...g, regenerated: landed.regenerated, overrun: landed.overrun }, c.gateNames, c.report) },
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
        const line = e.again ? againNoteOf(landed) : conflictLine(landed);
        return {
          record: { state: "conflict", note: line },
          outcome: { kind: "conflict", ...withOf(landed.with), text: `merge conflict: ${line}` },
          view: { word: "merge conflict", landed: false },
          tracker: comment(notLandedComment(c.report, { branch: g.branch, base: c.base, files: landed.files, with: landed.with })),
        };
      }
      case "red": {
        const refs = landed.with.map(refOf).join(", ");
        return {
          // The pair, named: which tickets this one is red with.
          record: { state: "red", note: e.again ? againNoteOf(landed) : landed.with.length ? `red with ${refs}` : "red on the merged tree" },
          outcome: { kind: "red", ...withOf(landed.with), text: e.again ? againNoteOf(landed) : `red when merged${landed.with.length ? ` with ${refs}` : ""}` },
          view: { word: "red when merged", landed: false },
          tracker: comment(notLandedComment(c.report, undefined, { branch: g.branch, base: c.base, with: landed.with, gates: landed.gates })),
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
        return { record: { state: "held", note: landed.reason }, outcome: { kind: "held", text: "needs a human merge" }, view: NEEDS_A_HUMAN, tracker: { kind: "hold", text } };
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
  // A dry run lands nothing: every branch it gated green reads as one it would merge.
  return c.dryRun && g.status === "green" ? { ...said, outcome: { kind: "green", text: "dry run: gated green, would merge" } } : said;
};

const describePipeline = (o: Finished, c: Context): Said => {
  const repaired = o.repairs ? `, ${o.repairs} repair(s)` : "";
  // A pipeline that ended with no commits, its worktree kept: the agent's commit was refused, and the work exists.
  const uncommitted = o.status === "nochange" && o.commits === 0 && c.kept !== undefined;
  // A hold note on a ticket whose finished work sits uncommitted keeps its own state: the work exists.
  const held = c.hold === "label" || (c.hold === "note" && c.kept === undefined);
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
      case "nochange":
        if (uncommitted) return { state: "uncommitted", note: `work left uncommitted in ${c.kept}` };
        if (held) return { state: "held", note: "handed back - for a human" };
        return { state: "nochange", note: c.hold === "note" ? "handed back - for a human" : "nothing to change" };
    }
  })();
  return {
    record,
    outcome: c.hold === "label" ? { kind: "held", text: "needs a human: handed back" } : pipelineOutcome(o, uncommitted),
    ...(held && { view: NEEDS_A_HUMAN }),
    // A ticket with a hold note gets that note, never a second comment.
    tracker: c.hold === "note" ? undefined : comment(notLandedComment(c.report, undefined)),
  };
};

/**
 * Everything a run says about one ending, in today's words. Pure: the ending and its context in,
 * the words out. `record` is the state the run ends the ticket on; a waiting ticket keeps the one
 * the file hold or its blockers wrote.
 */
export const describe = (e: TicketEnding, c: Context): Said => {
  switch (e.kind) {
    case "landing":
      return describeLanding(e, c);
    case "pipeline":
      return describePipeline(e.outcome, c);
    case "crashed":
      return {
        // The land port threw (`green`), or the pipeline did: each says its error as it always has.
        record: { state: "crashed", note: e.green ? errorLine(e.error) : String(e.error).split("\n")[0].slice(0, 160) },
        outcome: { kind: "crashed", text: "crashed" },
        tracker: comment(notLandedComment(c.report, undefined)),
      };
    case "stopped":
      return { record: STOPPED_GREEN.record, outcome: STOPPED_GREEN.outcome, tracker: comment(notLandedComment(c.report, undefined)) };
    case "not begun": {
      const { why } = e;
      const record = why.kind === "withdrawn" ? withdrawnRecord(why.reason) : why.kind === "refused label" ? refusedRecord(why.reason) : { state: "skipped" as const, note: `not started: ${c.stopLine ?? "the run stopped"}` };
      return { record, tracker: comment(notLandedComment(c.report, undefined)) };
    }
    case "waiting":
      return {};
    default:
      return e satisfies never;
  }
};

/**
 * The endings whose ticket state the ledger writes. The others are still written where they are
 * decided: `landOne` and the requeue record at landing, the attempt as its pipeline ends, and the
 * burndown after the schedule for a ticket the run's stop left unstarted, in the run's last words.
 */
const writesRecord = (e: TicketEnding) =>
  (e.kind === "not begun" && (e.why.kind === "withdrawn" || e.why.kind === "refused label")) || ((e.kind === "stopped" || e.kind === "crashed") && e.green !== undefined);

/** One ticket's entry: its ending, the context it was described in, and what was said. */
export type Entry = { id: string; ending: TicketEnding; context: Context; said: Said };

/**
 * The writer: records what `describe` says of each ending as burndown is told it - the outcome
 * (it is the only writer of an ending's outcome), the view's word and the ticket state - and keeps
 * the entry. An ending is recorded again when a fact about it is learnt later (the tracker's hold
 * label, read after the schedule). `bookkeep` keeps a write that throws (a full disk) from costing
 * the ticket its ending.
 */
export const createLedger = (d: {
  run: { ticket(id: string, fields: TicketRecord): void };
  outcomes(outcomes: Record<string, Outcome>): void;
  view: { landed(issue: string, ok: boolean, word: string): void };
  context(id: string): Context;
  bookkeep(id: string, fn: () => void): void;
}) => {
  const entries = new Map<string, Entry>();
  return {
    entries: entries as ReadonlyMap<string, Entry>,
    record(id: string, ending: TicketEnding) {
      let said: Said = {};
      d.bookkeep(id, () => {
        const context = d.context(id);
        said = describe(ending, context);
        entries.set(id, { id, ending, context, said });
      });
      const { record, outcome, view } = said;
      if (record && writesRecord(ending)) d.bookkeep(id, () => d.run.ticket(id, record));
      if (outcome) d.bookkeep(id, () => d.outcomes({ [id]: outcome }));
      if (view) d.bookkeep(id, () => d.view.landed(id, view.landed, view.word));
    },
  };
};

/** What the closing notification and the verify still read of the run's landings. */
export type Landings = {
  /** In the order they landed. */
  merged: string[];
  /** Merged by regenerating generated files in a sandbox: a tree no gate has seen. */
  regenerated: number;
  /** Conflicted, red once merged, failed to land, or not merged. */
  notLanded: number;
  /** Held at landing, taken back by a person, or handed back through the tracker's hold label. */
  needsHuman: number;
  withdrawn: number;
};

/** The landings counted from the ledger's entries. */
export const accountLanding = (entries: Iterable<Entry>): Landings => {
  const l: Landings = { merged: [], regenerated: 0, notLanded: 0, needsHuman: 0, withdrawn: 0 };
  for (const { id, ending: e, context } of entries) {
    if (e.kind === "pipeline" && context.hold === "label") l.needsHuman++;
    if (e.kind !== "landing") continue;
    const landed: Landed = e.landed;
    switch (landed.kind) {
      case "merged":
      case "close-failed":
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
