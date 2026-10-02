// What a run record (.sandcastle/logs/run.json) holds and what the status view says about it:
// the record's types, the closed set of ticket states, the derived states, and the tables from
// ticket state to group and to word. Pure: it imports nothing, so the mod (which cannot import
// the kit's source) and the kit's own tests can both read it. Terms are CONTEXT.md's.

/**
 * Where one ticket of a run stands, as the run record holds it - every state src/run.ts
 * writes. A phase (implement, review, gates ...) is one kind of ticket state; `requeued` is
 * not one (it is a fact about a ticket's second attempt, `TicketRecord.requeued`).
 */
export const TICKET_STATES = [
  "queued",
  "blocked",
  "setup",
  "implement",
  "review",
  "cross-review",
  "gates",
  "repair",
  "ready",
  "landing",
  "merged",
  "held",
  "conflict",
  "red",
  "nochange",
  "uncommitted",
  "crashed",
  "not landed",
  "withdrawn",
  "stopped",
  "skipped",
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/** Tells a ticket state from any other string: a record is a file in a repository, which may be a stranger's. */
export const isTicketState = (s: unknown): s is TicketState => typeof s === "string" && (TICKET_STATES as readonly string[]).includes(s);

/**
 * The states the status view works out for itself and no run record holds: a run that died
 * (`stalled`, `orphaned`), a branch of an earlier run (`left over`), a branch of this run that
 * waits for landing to decide it (`finished`), and `requeued`, the word it gives an older run's
 * branch whose ticket was labelled again.
 */
export const DERIVED_STATES = ["stalled", "orphaned", "left over", "finished", "requeued"] as const;

export type DerivedState = (typeof DERIVED_STATES)[number];

/** What the status view sorts ticket states into, shared by every view so none disagrees about a ticket. */
export type Group = "working" | "needs you" | "ready" | "queued" | "blocked" | "merged" | "other";

/** The group each ticket state falls into. Keyed by the closed set: a missing or extra state fails the type check. */
export const GROUPS: Record<TicketState, Group> = {
  setup: "working",
  implement: "working",
  review: "working",
  "cross-review": "working",
  gates: "working",
  repair: "working",
  landing: "working",
  red: "needs you",
  conflict: "needs you",
  held: "needs you",
  uncommitted: "needs you",
  crashed: "needs you",
  "not landed": "needs you",
  stopped: "needs you",
  ready: "ready",
  queued: "queued",
  blocked: "blocked",
  merged: "merged",
  nochange: "other",
  withdrawn: "other",
  skipped: "other",
};

/** The status view's word for a ticket state, where it differs from the state's own name. */
export const WORDS: Partial<Record<TicketState, string>> = { implement: "impl", "cross-review": "codex", red: "gate red", nochange: "no change" };

/** One ticket of a run, as src/run.ts writes it. */
export type TicketRecord = {
  state?: TicketState;
  /** Seconds since the epoch at which the state began. */
  since?: number;
  started?: number;
  order?: number;
  note?: string | null;
  title?: string;
  commits?: number;
  tokens?: string;
  minutes?: number;
  /** Test ids a red gate named. */
  failing?: string[];
  /** Files a merge conflicted on, or protected paths a held branch changes. */
  files?: string[];
  /** The ticket's second attempt after a conflict or red at landing ("requeued after conflict with #3"); null once that attempt is not going to run. */
  requeued?: string | null;
  /** Merged, but the tracker refused the close: the error, short. */
  closeFailed?: string;
  /** What the reviewer said no gate exercises; a merged ticket with one needs a person. */
  ungated?: string;
  /** Paths the branch changed beyond its ticket's `Touches:` line. */
  overrun?: string[];
};

/** The whole run record: the run's own fields and its tickets, by ticket id. Every field is optional - the file is read while the run is still filling it. */
export type RunRecord = {
  /** The project's name. */
  orchestrator?: string;
  pid?: number;
  startedAt?: string;
  /** Written on a clean exit; a pid that is gone without it is a run that was killed. */
  finishedAt?: string;
  exitCode?: number;
  models?: string;
  issues?: string[];
  dryRun?: boolean;
  versions?: { claude?: string; codex?: string };
  /** Tickets held for another that is open: `on` names what each waits for. */
  waiting?: { issue: string; on: string[] }[];
  /** What the run line shows while the run is live. */
  stage?: string;
  concurrency?: number;
  typical?: unknown;
  tokens?: string;
  /** Why the run stopped before the end of its queue. */
  stopped?: string;
  baseGates?: unknown;
  verify?: { green: boolean; line: string } | null;
  keptWorktrees?: { issue: string; path: string }[];
  dryRunCheck?: string;
  tickets?: Record<string, TicketRecord>;
};
