// What a run record (.sandcastle/logs/run.json) holds and what the status view says about it:
// the record's types, the closed set of ticket states, the derived states, and the tables from
// ticket state to group and to word. Pure: it imports nothing, so the mod (which cannot import
// the kit's source) and the kit's own tests can both read it. Terms are GLOSSARY.md's.

/**
 * Where one ticket of a run stands, as the run record holds it - every state src/run.ts
 * writes. A phase (implement, review, gates ...) is one kind of ticket state; `requeued` is
 * not one (it is a fact about a ticket's second attempt, `TicketRecord.requeued`). `paused` is a
 * ticket parked at a juncture of a paused run: its sandbox is closed, its branch kept, and it
 * resumes with the phase its note names.
 */
export const TICKET_STATES = [
  "queued",
  "blocked",
  "setup",
  "implement",
  "resolve",
  "review",
  "cross-review",
  "gates",
  "repair",
  "ready",
  "landing",
  "paused",
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
 * A run record's tickets as read from a file, each one's state passed through the guard. A state
 * outside the set (a record from an older kit, or edited by hand) is dropped, so the ticket
 * falls to the "other" group and into no report section, never into one that asks for a person.
 */
export const readTickets = (record: unknown): Record<string, TicketRecord> => {
  const tickets = (record as { tickets?: unknown } | null | undefined)?.tickets;
  if (!tickets || typeof tickets !== "object" || Array.isArray(tickets)) return {};
  return Object.fromEntries(
    Object.entries(tickets as Record<string, unknown>).map(([id, t]) => {
      const { state, ...rest } = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
      return [id, (isTicketState(state) ? { ...rest, state } : rest) as TicketRecord];
    }),
  );
};

/**
 * What a run says became of one ticket, as `.sandcastle/logs/outcomes.json` holds it beside the
 * line: every reader (the status view, the report, the autonomy loop) decides on the kind, never
 * on the line's words, so a new ending cannot read as "ready" for want of a prefix. `red` is red
 * once merged with other tickets at landing; `gate red` is red in the ticket's own pipeline.
 * `taken back` is a ticket a person marked for a human during the run; `green` is a branch gated
 * green that this run has not (or, in a dry run, would have) landed.
 */
export const OUTCOME_KINDS = [
  "green",
  "merged",
  "conflict",
  "red",
  "gate red",
  "held",
  "taken back",
  "uncommitted",
  "crashed",
  "not landed",
  "withdrawn",
  "stopped",
  "no change",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** Tells an outcome kind from any other value: outcomes.json is a file in a repository, and an older run's entries carry none. */
export const isOutcomeKind = (s: unknown): s is OutcomeKind => typeof s === "string" && (OUTCOME_KINDS as readonly string[]).includes(s);

/** One ticket's outcome as a run writes it: the kind, the tickets it collided with, and the line a person reads. */
export type Outcome = { kind: OutcomeKind; with?: string[]; text: string };

/** One entry of outcomes.json as read: the run that wrote it, and no kind when an older kit did. */
export type OutcomeEntry = Partial<Outcome> & { run?: string; at?: string };

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
  resolve: "working",
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
  paused: "queued",
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
  /** Seconds since the epoch at the ticket's first `setup`, kept through a requeue or a resume: TIME's start. */
  started?: number;
  /** Seconds since the epoch at the current attempt's `setup` (a requeued second attempt, a resume): the ETA's start. */
  attemptStarted?: number;
  order?: number;
  note?: string | null;
  title?: string;
  commits?: number;
  /** In and out as `tokenBrief` writes them (`3.1M in / 42k out`): the finished passes plus the one running, rewritten on the usage row's tick. */
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
  /** A sentence a reviewer left in prose naming a gap it filed neither as a `<followup>` nor as an `<unmet>` line; a merged ticket with one needs a person. */
  gap?: string;
  /** Changelog lines the implementer and reviewer asked for (`changelog: true`), each starting Added:, Changed:, Fixed: or Upgrading:. */
  changelog?: string[];
  /** How many `<changelog>` tags were no changelog line (too long, a list, a commit sha) and were left out of `changelog`. */
  changelogDropped?: number;
  /** The acceptance criterion an agent knowingly left undone: merged, the ticket still open; a merged ticket with one needs a person. */
  unmet?: string;
  /** Paths the branch changed beyond its ticket's `Touches:` line. */
  overrun?: string[];
};

/**
 * A Claude Code session id as an environment variable or a record holds it, or undefined when
 * the value is not one. The record is a file in a repository, so only a short id of letters,
 * digits, `-` and `_` passes.
 */
export const sessionId = (value: unknown): string | undefined => (typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : undefined);

/**
 * The run's settings as one turn's record holds them (GLOSSARY.md: run setting): the autonomy
 * level, the turn this record is, the level's cap, the repair attempts, the concurrency (asked
 * and effective), whether cross-review runs, and the usage guard. Each field is optional and a
 * reader shows only what is there - an older kit's record has no group at all, level 1 has no cap
 * (it asks after every turn), and a record without the guard's fields shows nothing about it.
 */
export type RunSettings = {
  /** The level, resolved once per run. */
  autonomy?: 0 | 1 | 2 | 3 | "drain";
  /** This record's turn, 1-based. */
  turn?: number;
  /** The most turns the level allows. */
  cap?: number;
  /** The repair attempts a ticket gets after a red gate; 0 is repair off. */
  repair?: number;
  /** The tickets the run takes at once, after the machine-wide sandbox cap. */
  concurrency?: number;
  /** The tickets at once the run asked for; the view shows it only when it differs from `concurrency`. */
  asked?: number;
  /** Whether cross-review runs, resolved once per run. */
  crossReview?: boolean;
  /** Cross-review's model: written only when it is on. */
  crossReviewModel?: string;
  /** Cross-review's effort: written only when it is on. */
  crossReviewEffort?: string;
  /** Whether the usage guard (`USAGE_CHECK=1`) was asked for. */
  usageGuard?: boolean;
  /** The guard's stop threshold in percent; only while it is on. */
  usageStop?: number;
  /**
   * The guard's reading, a fact beside the setting and never a change to it: `unavailable` when it
   * cannot get one (a 403 turns it off for the run, a rate limit or a missing OAuth token leaves it
   * without one for now). The only settings field that may change during a turn.
   */
  usageReading?: "unavailable";
  /** The plan usage in percent at which the run pauses itself (`USAGE_PAUSE`); only when it is on. */
  usagePause?: number;
  /** True when the sandboxes spend `ANTHROPIC_API_KEY`, billing API credits; absent otherwise. */
  apiKey?: boolean;
};

/** One of a plan's usage windows: how much of it is spent (0 to 100) and when it resets (seconds since the epoch). */
export type PlanWindow = { percent: number; resetsAt: number };

/**
 * One provider's plan usage, as a live run shows it (`usage` in the run record, read by the status view,
 * the Herdr token and the closing summary), keyed by the provider that reports it. `windows` and `at` are
 * absent until the first reading: the run is watching for one and none has come.
 */
export type PlanUsage = {
  provider: "claude" | "codex";
  /** The 5-hour and the weekly window: from a Claude agent's rate-limit event, or Codex's `rate_limits` (matched by their length, not their position). */
  windows?: { fiveHour: PlanWindow; week: PlanWindow };
  /** Seconds since the epoch at which the kit read the event: the reading's age is measured from it. */
  at?: number;
};

/**
 * Why a run is paused when no person asked for it: a plan window reached `USAGE_PAUSE` (or an agent hit the
 * limit anyway), and the run resumes by itself at `resumesAt` - seconds since the epoch, a minute after the
 * window's reset. `percent` is the window's usage when the run paused; `window` and `provider` say whose.
 */
export type UsagePaused = { cause: "usage"; provider: PlanUsage["provider"]; window: "fiveHour" | "week"; percent: number; resumesAt: number };

/** The whole run record: the run's own fields and its tickets, by ticket id. Every field is optional - the file is read while the run is still filling it. */
export type RunRecord = {
  /** The project's name. */
  orchestrator?: string;
  pid?: number;
  /** The Claude Code session that started the run (`CLAUDE_CODE_SESSION_ID`, nothing else of its environment); absent from a plain terminal, Codex or OpenCode. */
  session?: string;
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
  /**
   * How loaded the run was, kept in the history line so the estimate prices a run from earlier runs of a similar load:
   * the sandboxes it ran at once (its effective concurrency, after the machine-wide cap and its share) and its ticket
   * count. An older kit's record has none, and the estimate counts that run as unknown.
   */
  load?: { concurrency: number; tickets: number };
  /** The run settings: what the status view's settings row shows. */
  settings?: RunSettings;
  /**
   * Present while a person has paused the run (`sandcastle pause`): no agent pass starts, the
   * passes in flight finish and green branches still land. `since` is seconds since the epoch;
   * `finishing` the tickets still doing something (a pass, a gate run, a landing). Absent when the
   * run is not paused: a paused run is live all the same, its process is running. A pause the run
   * took for its plan's usage (`USAGE_PAUSE`) says so: `cause: "usage"`, the window and when it resumes.
   */
  paused?: { since: number; finishing: string[] } & Partial<UsagePaused>;
  /**
   * The plan's usage, one entry per provider the run shows, each its newest reading across the run's agent logs
   * (`src/usage.ts`): Claude's while the run spends a subscription on a Claude model, Codex's while cross-review
   * runs on a ChatGPT plan. An older kit wrote the one entry as an object, and readers still take that.
   */
  usage?: PlanUsage[] | PlanUsage;
  /** Live values, not settings: the sandbox slots the run could use now, and its share of the machine pool (src/pool.ts), rewritten as either changes. */
  demand?: number;
  share?: number;
  /** A person's cap on the run's share (`sandcastle cap`); absent when there is none. */
  cap?: number;
  /**
   * Present (true) while the run waits for a sandbox slot that its share of the machine pool (or its cap) holds back, not
   * only a full pool: the status view's next-to-start rows say `waits for the run's share`. The wait is the run's, not a
   * ticket's - a worker leases its slot before it takes a ticket - and an older kit wrote it as each waiting ticket's note.
   */
  waitsForShare?: boolean;
  typical?: unknown;
  tokens?: string;
  /** Why the run stopped before the end of its queue. */
  stopped?: string;
  /** How a person ended the run: "sandcastle stop", "Ctrl-C", or the signal's name. Absent for a crash, a kill -9 and a run that ended by itself. */
  stoppedBy?: string;
  baseGates?: unknown;
  /** Tests found red on the base mid-run, each once: a failure no branch caused, so none was repaired. */
  baseRed?: string[];
  /** Out-of-scope problems agents named in `<followup>` lines, recorded as each arrives: `id` is the ticket filed for triage, absent until it is filed (and for good in a dry run, or when filing `failed`, which a run that stopped on a `.git` change sets without trying). */
  followUps?: { title: string; from: string; phase: string; id?: string; failed?: string }[];
  /**
   * The gates on the merged base. `image`: the tag they ran on, the run's own (built before any ticket landed).
   * `dockerfiles`: the Dockerfiles the run's merges changed, which that image therefore lacks - absent when none.
   * `skipped`: the verify did not run, as the green-base record already named the merged tip: `by` is whose gates proved it.
   */
  verify?: { green: boolean; line: string; image?: string; dockerfiles?: string[]; skipped?: { commit: string; by?: string } } | null;
  keptWorktrees?: { issue: string; path: string }[];
  dryRunCheck?: string;
  tickets?: Record<string, TicketRecord>;
};
