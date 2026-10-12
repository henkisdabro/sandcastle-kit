// The status view's ticket rows: a pure function from a snapshot (src/status-snapshot.ts) to the table's rows -
// each ticket's group, word, derived state, note, time, links and place in the order - and the counts the
// legend shows. No process, no file: every fact it needs is in the snapshot, so any frame can be worked out in
// a test from a built one.
//
// The rules, in three passes: the live run's tickets as its record has them,
// queued tickets nothing else knows, then the tickets with logs the record does not hold, whose state is
// inferred from git, the logs and outcomes.json. A ticket state's group and word are the shared tables'
// (mod/hooks/run-record.ts), never a copy of them; the derived states are GLOSSARY.md's.

import { DERIVED_STATES, GROUPS, isOutcomeKind, isTicketState, WORDS, type OutcomeKind, type TicketState } from "../mod/hooks/run-record.ts";
import { needsDecision } from "./autonomy.ts";
import { freeSlots, latestLog, latestPhaseLog, logTicket, phaseLog, shownId, whole, type LogFact, type Snapshot } from "./status-snapshot.ts";

/** The view's groups: the shared table's, with its `other` split into what waits for a later run, what is left over, and what is idle. */
export type ViewGroup = "working" | "needs you" | "ready" | "queued" | "blocked" | "merged" | "later" | "left over" | "idle";

/** A colour the renderer gives a part of a row. */
export type Tone = "head" | "mute" | "gry" | "hot" | "ylw" | "cyn" | "blu" | "grn";

export type Row = {
  /** The ticket id as its branch and logs have it, and as the table shows it. */
  id: string;
  shown: string;
  /** The word the STATE column shows, and its glyph and colour. */
  state: string;
  glyph: string;
  tone: Tone;
  group: ViewGroup;
  time: string;
  timeTone: Tone;
  /** Lines added and removed on the ticket's branch against its base (`+96 −1159`), `-` without a branch. */
  diff: string;
  /** The sandbox's CPU and memory, absent without one. */
  cpu?: { cpu: string; mem: string; hot: boolean };
  /** In and out tokens (`3.1M/42k`), absent without a reading. */
  tokens?: string;
  /** The share of the input served from cache, in whole percent; absent for a record from before the kit counted cache reads. */
  cache?: number;
  note: string;
  noteTone: Tone;
  /** The log the ticket's id links to, when links are on and it has one. */
  link?: string;
  /** Sort order: the group's rank, then the newest change first, then the id. */
  prio: number;
  key: number;
  /** Outside the live run's record: counted apart, so the counts add up to the run. */
  apart: boolean;
};

export type Table = {
  /** In the order the table draws them. */
  rows: Row[];
  /** Each group's count, the rows outside the live run's record left out (`later` counted apart). */
  counts: Record<ViewGroup, number>;
  /** Merged tickets left open with a criterion unmet. */
  partly: number;
  /** The `later` rows' ids, and how many of them wait for a blocker. */
  later: { ids: string[]; blocked: number };
};

const RANK: Record<ViewGroup, number> = { working: 0, "needs you": 1, ready: 2, queued: 3, blocked: 4, merged: 5, later: 6, "left over": 7, idle: 7 };
const GLYPH: Record<ViewGroup, string> = { working: "●", "needs you": "!", ready: ">", queued: "○", blocked: "~", merged: "+", later: "…", "left over": "-", idle: "·" };
const TONE: Record<ViewGroup, Tone> = { working: "ylw", "needs you": "hot", ready: "cyn", queued: "blu", blocked: "blu", merged: "grn", later: "gry", "left over": "gry", idle: "gry" };

// The derived states (GLOSSARY.md), each in its group. Every one is named: a new derived state fails the type check here.
const DERIVED: Record<(typeof DERIVED_STATES)[number], ViewGroup> = { stalled: "needs you", orphaned: "needs you", "left over": "left over", finished: "ready", requeued: "queued", later: "later" };

// A ticket state by the word the view shows for it.
const STATE_OF_WORD = new Map<string, TicketState>(Object.keys(GROUPS).map((s) => [WORDS[s as TicketState] ?? s, s as TicketState]));

/**
 * The group of a row's word: a derived state's own, else its ticket state's in the shared table. A withdrawn
 * ticket is left over (it never ran, or stopped early), and the table's `other` is idle - as is any word the
 * view made up for a branch (`no branch`, `no commits`).
 */
export const groupOf = (word: string): ViewGroup => {
  if (word in DERIVED) return DERIVED[word as keyof typeof DERIVED];
  const state = STATE_OF_WORD.get(word);
  if (!state) return "idle";
  if (state === "withdrawn") return "left over";
  const group = GROUPS[state];
  return group === "other" ? "idle" : group;
};

/** A ticket state's word in the table. */
const wordOf = (state: string): string => (isTicketState(state) ? (WORDS[state] ?? state) : state);

/**
 * The row state for a recorded outcome's kind: never the line's words, so an ending the view did not foresee
 * cannot read as ready. Red at landing, once or again after a requeue, is as red as a pipeline's gate.
 */
const OUTCOME_STATE: Record<OutcomeKind, string> = {
  green: "ready",
  merged: "merged",
  conflict: "conflict",
  red: "gate red",
  "gate red": "gate red",
  held: "held",
  "taken back": "held",
  uncommitted: "uncommitted",
  crashed: "crashed",
  "not landed": "not landed",
  withdrawn: "withdrawn",
  stopped: "stopped",
  "no change": "no change",
};

/** The outcome line of a ticket the kit handed back to a person (src/run.ts `HANDED_BACK`; a test holds the two together). */
export const HANDED_BACK = "needs a human: handed back";

/** Seconds as the TIME column shows them. */
export const ago = (s: number): string => (s < 1 ? "0s" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);

/** A length: "48m", "1h12m". */
export const duration = (s: number): string => (s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`);

const ENDED_STATES: readonly string[] = ["merged", "held", "red", "conflict", "nochange", "uncommitted", "crashed", "not landed", "withdrawn", "stopped", "skipped"];

/** A finished ticket's TIME: its whole length, first start to end, or undefined for a working state or a record with no start. */
const finishedTime = (state: string | undefined, since: unknown, started: unknown): string | undefined => {
  if (!state || !ENDED_STATES.includes(state)) return undefined;
  const [end, start] = [whole(since), whole(started)];
  if (end === undefined || start === undefined || end < start) return undefined;
  return end - start < 60 ? ago(end - start) : duration(end - start);
};

/** The TOKENS cell of a record's `tokens` ("3.1M in / 42k out"): "3.1M/42k". Anything else is no reading. */
const tokensCell = (tokens: unknown): string | undefined => {
  const m = typeof tokens === "string" ? /^([0-9.]+[kM]?) in \/ ([0-9.]+[kM]?) out$/.exec(tokens) : null;
  return m ? `${m[1]}/${m[2]}` : undefined;
};

/**
 * The share of a ticket's input that came from cache, in whole percent: the record's cache-read count over the
 * input of its `tokens` text. That text is rounded (`2.5M`), so the share is good to a point or two, which is all a
 * cell that goes amber at 70% needs. No share without the count (an older record) or without any input.
 */
const cacheShare = (tokens: unknown, cacheRead: unknown): number | undefined => {
  const m = typeof tokens === "string" ? /^([0-9.]+)([kM]?) in \//.exec(tokens) : null;
  if (!m || typeof cacheRead !== "number" || !Number.isFinite(cacheRead) || cacheRead < 0) return undefined;
  const input = Number(m[1]) * (m[2] === "M" ? 1_000_000 : m[2] === "k" ? 1000 : 1);
  return input > 0 ? Math.min(Math.round((cacheRead / input) * 100), 100) : undefined;
};

/** A count of lines for the DIFF column: whole to 9999, then `12k`. */
const count = (n: number): string => (n < 10000 ? String(n) : `${Math.round(n / 1000)}k`);

/** The DIFF cell of a branch's fact: `+96 −1159`, or `-` without a branch (or without a reading of it). */
const diffCell = (branch: { exists: boolean; diff?: { added: number; removed: number } } | undefined): string =>
  branch?.exists && branch.diff ? `+${count(branch.diff.added)} \u2212${count(branch.diff.removed)}` : "-";

/** What TIME holds: its 9 columns less the padding. */
const TIME_CELLS = 7;

/**
 * TIME with what the step usually has left: `6m ~4m`, from the record's typical length of the step. Just the time
 * once the step is at or past it, and where the whole would not fit TIME (7 cells) the space goes, then the rest.
 */
const withLeft = (time: string, spent: number, usual: number): string => {
  if (spent >= usual) return time;
  const left = `~${ago(usual - spent)}`;
  for (const joined of [`${time} ${left}`, `${time}${left}`]) if (joined.length <= TIME_CELLS) return joined;
  return time;
};


/** Where a ticket's link points: its newest log, the characters a file URL cannot hold escaped. */
const linkOf = (snapshot: Snapshot, id: string): string | undefined => {
  if (!snapshot.links) return undefined;
  const log = latestLog(snapshot.logs, id);
  return log ? `${snapshot.dir}/logs/${log.name}`.replace(/%/g, "%25").replace(/ /g, "%20").replace(/#/g, "%23") : undefined;
};

/** The rows of a snapshot, in the table's order, and the legend's counts. */
export const ticketRows = (snapshot: Snapshot): Table => {
  const { now, base, live, record, tickets, queue, branches, containers, outcomes, logs, tails } = snapshot;
  const runStarted = typeof record.startedAt === "string" ? record.startedAt : "";
  const runIssues = live ? new Set((Array.isArray(record.issues) ? record.issues : []).map(String)) : new Set<string>();
  const recorded = live && Object.keys(tickets).length > 0;
  const inRecord = (id: string) => recorded && id in tickets;
  const typical = live && record.typical && typeof record.typical === "object" ? (record.typical as Record<string, unknown>) : {};
  // An older orchestrator's record: what it was working on, and what it held back for what.
  const active = new Map<string, { phase: string; since: unknown }>();
  if (live && record && typeof (record as { active?: unknown }).active === "object") {
    for (const [id, a] of Object.entries(((record as { active?: unknown }).active ?? {}) as Record<string, { phase?: unknown; since?: unknown }>)) {
      if (a && typeof a === "object") active.set(id, { phase: String(a.phase), since: a.since });
    }
  }
  const waiting = new Map<string, string>();
  if (live && Array.isArray(record.waiting)) {
    for (const w of record.waiting) {
      if (w && Array.isArray(w.on)) waiting.set(String(w.issue), w.on.map((o) => (/^[0-9]+$/.test(String(o)) ? `#${o}` : String(o))).join(", "));
    }
  }
  const queued = new Map(queue.tickets.map((t) => [t.id, t]));
  // What holds a ticket back: the live run's own decision first, then its body's open blockers.
  const blockedOn = (id: string) => waiting.get(id) || (queued.get(id)?.blockedOn ?? []).join(", ");
  const ids = new Set(logs.map((l) => logTicket(l.name)).filter((id): id is string => !!id));
  const free = live ? freeSlots(record, tickets) : 0;
  const pausedRun = live && !!record.paused && typeof record.paused === "object";
  const waitsFor = live ? (record.waitsFor === "landing" ? "landing" : record.waitsFor === "share" || record.waitsForShare === true ? "share" : "") : "";

  const outcomeOf = (id: string) => outcomes[id];
  const outcomeState = (id: string) => {
    const o = outcomeOf(id);
    return o && o.run === runStarted && isOutcomeKind(o.kind) ? OUTCOME_STATE[o.kind] : undefined;
  };
  // A branch the kit held for a person that a person has since merged by hand: its tip is on the base.
  const handMerged = (id: string) => {
    const o = outcomeOf(id);
    return !!o && o.kind === "held" && o.text !== HANDED_BACK && !!branches[id]?.onBase;
  };
  const handMergedNote = (id: string) => {
    const b = branches[id];
    if (b?.landing?.subject.includes("(part of ")) return "merged by hand, partly done: stays open";
    return b?.pushed ? "merged by hand" : "merged by hand; closes on push";
  };
  // Labelled again after its merge: only a change to the ticket after the kit's merge commit counts (a landing
  // closes the ticket after it merges). With no such merge the listing is taken at its word; a partly-done
  // landing leaves its ticket open by design.
  const requeued = (id: string) => {
    const landing = branches[id]?.landing;
    if (!landing) return true;
    if (landing.subject.includes("(part of ")) return false;
    const updated = queued.get(id)?.updated;
    return updated !== undefined && updated > landing.at;
  };

  const rows: Row[] = [];
  const counts: Record<ViewGroup, number> = { working: 0, "needs you": 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 0, "left over": 0, idle: 0 };
  let partly = 0;
  const later: Table["later"] = { ids: [], blocked: 0 };

  const emit = (row: Omit<Row, "group" | "glyph" | "tone" | "prio" | "shown"> & { glyph?: string; tone?: Tone }, partlyDone = false) => {
    const group = groupOf(row.state);
    const full: Row = {
      ...row,
      shown: shownId(row.id),
      group,
      glyph: row.glyph ?? GLYPH[group],
      tone: row.tone ?? TONE[group],
      prio: RANK[group],
      timeTone: row.time === "-" ? "gry" : row.timeTone,
      link: linkOf(snapshot, row.id),
    };
    rows.push(full);
    if (row.state === "later") {
      later.ids.push(full.shown);
      if (row.note.startsWith("waits for ")) later.blocked++;
      counts.later++;
      return;
    }
    if (row.apart) return;
    if (partlyDone) partly++;
    counts[group]++;
  };

  // 1. The live run's tickets, as its record has them.
  if (recorded) {
    for (const id of Object.keys(tickets)) {
      const t = tickets[id]!;
      const raw = t.state ?? "";
      let state = wordOf(raw);
      const since = whole(t.since) ?? now;
      let time = ago(now - since);
      let timeTone: Tone = "head";
      let noteTone: Tone = "mute";
      const note = typeof t.note === "string" ? t.note : "";
      let activity = note;
      let key = since;
      time = finishedTime(raw, since, t.started) ?? time;
      const branch = branches[id];
      const cpu = containers[id];
      let log: string | undefined;
      switch (raw) {
        case "setup":
          activity = note || "setting up its sandbox";
          break;
        case "landing":
          activity = note || `merging into ${base}`;
          break;
        case "queued": {
          // Next to start first: the run takes its queue in this order.
          const order = typeof t.order === "number" ? t.order : 0;
          const pos = Object.values(tickets).filter((o) => o.state === "queued" && (typeof o.order === "number" ? o.order : 0) < order).length + 1;
          key = 1000000 - order;
          time = "-";
          activity = pos - free <= 1 ? "next to start" : `${pos - 1 - free} ahead of it`;
          if (pausedRun) activity = "waits for the resume";
          // The run waits for a slot its share of the machine holds back, or one it keeps for a landing: the slot goes to the ticket next to start.
          if (activity === "next to start" && waitsFor) activity = waitsFor === "share" ? "waits for the run's share" : "waits: slot kept to land";
          if (note.startsWith("waits for the run's share")) activity = note;
          break;
        }
        case "blocked":
          time = "-";
          break;
        case "held":
          if (handMerged(id)) {
            state = "merged";
            activity = handMergedNote(id);
          }
          break;
        case "implement":
        case "resolve":
        case "review":
        case "cross-review":
        case "repair":
        case "gates": {
          const name = phaseLog(id, raw);
          const file = logs.find((l) => l.name === name);
          if (file) {
            log = name;
            const quiet = now - file.mtime;
            activity = `${note ? `${note} - ` : ""}${tails[name]?.activity ?? ""}`;
            // A gate can be silent for minutes and still be working; only an agent's silence is worth a flag.
            if (raw !== "gates") {
              if (!cpu && quiet >= 1800) {
                // No container and a log quiet for 30 minutes: a sandbox that died under a live run.
                state = "stalled";
                activity = `no container, log quiet ${Math.floor(quiet / 60)}m - ${activity}`;
              } else if (quiet >= 600) {
                activity = `quiet ${Math.floor(quiet / 60)}m - ${activity}`;
                noteTone = "hot";
              }
            }
          }
          // A step at twice its usual length says which to suspect; at three times it says so in words.
          const usual = whole(typical[raw]);
          if (usual !== undefined && usual > 0) {
            time = withLeft(time, now - since, usual);
            if (now - since > usual * 3) {
              timeTone = "hot";
              noteTone = "hot";
              activity = `3x over, usually ${ago(usual)} - ${activity}`;
            } else if (now - since > usual * 2) {
              timeTone = "hot";
              activity = `usually ${ago(usual)} - ${activity}`;
            }
          }
          break;
        }
      }
      // A ticket sent back at landing keeps saying so through its second attempt.
      const again = typeof t.requeued === "string" ? t.requeued : "";
      if (again && !activity.includes(again)) activity = `${again}${activity ? ` - ${activity}` : ""}`;
      let glyph: string | undefined;
      let tone: Tone | undefined;
      // A spent plan allowance makes the agent report some other error; the real cause is only in the log's tail.
      if (groupOf(state) === "working" && log && tails[log]?.limit) {
        activity = `USAGE LIMIT REACHED - ${state} model`;
        glyph = "!";
        tone = "hot";
      }
      // This run's landings above earlier runs' merged rows (their keys are epoch seconds).
      if (groupOf(state) === "merged") key += 10000000000;
      emit({ id, state, time, timeTone, diff: diffCell(branch), cpu, tokens: tokensCell(t.tokens), cache: cacheShare(t.tokens, t.cacheRead), note: activity, noteTone, key, apart: false, glyph, tone });
    }
  }

  // 2. Queued tickets with no log yet and nothing in the record.
  for (const { id } of queue.tickets) {
    if (inRecord(id) || ids.has(id)) continue;
    const on = blockedOn(id);
    let state: string;
    let note: string;
    let key = 0;
    if (live && (recorded || (!runIssues.has(id) && !active.has(id)))) {
      // Outside the live run (named by it, or queued after it started): it waits for a later run.
      state = "later";
      note = on ? `waits for ${on} to close` : "next run";
    } else if (on) {
      state = "blocked";
      note = `waits for ${on} to close`;
    } else if (live && !recorded && active.has(id)) {
      // Claimed, before its first agent log: the sandbox is being set up.
      state = "setup";
      note = "in this run - setting up its sandbox";
      key = 1;
    } else {
      // Only the live run's own tickets wait for a sandbox; the rest of the label waits for the next run.
      state = "queued";
      note = live ? "in this run - waiting for a sandbox" : "for the next run";
      if (live) key = 1;
    }
    emit({ id, state, time: "-", timeTone: "gry", diff: "-", note, noteTone: "mute", key, apart: recorded });
  }

  // 3. Tickets with logs the record does not hold: earlier runs', and all of them once the run has ended.
  for (const id of [...ids].sort()) {
    if (inRecord(id)) continue;
    const log = latestPhaseLog(logs, id);
    if (!log) continue;
    let phase = phaseOfLog(log);
    const act = live ? active.get(id) : undefined;
    let time: string;
    if (act) {
      phase = act.phase === "implement" ? "impl" : act.phase === "cross-review" ? "codex" : act.phase;
      time = ago(now - (whole(act.since) ?? now));
    } else {
      const ended = !live ? tickets[id] : undefined;
      time = (ended && finishedTime(ended.state, ended.since, ended.started)) || ago(now - log.mtime);
    }
    const branch = branches[id] ?? { exists: false, onBase: false };
    const commits = branch.commits ?? 0;
    const cpu = containers[id];
    let quiet = 0;
    let noteTone: Tone = "mute";
    let note = "";
    let partlyDone = false;
    let state: string;
    // A worktree is live work only while it is an older orchestrator's ticket of the live run. A container on a
    // worktree no live run owns is an orphan: its agent goes on spending with nobody to gate or land its work.
    // Sandcastle keeps a closed sandbox's worktree when it has uncommitted files: that is shown by its branch.
    let liveTree = false;
    let keptTree = false;
    let orphan = false;
    if (snapshot.worktrees.includes(id)) {
      if (live && !recorded && runIssues.has(id)) liveTree = true;
      else if (cpu) orphan = true;
      else keptTree = true;
    }
    if (orphan) {
      state = "orphaned";
      note = "its run is gone, its agent still works - sandcastle clean stops it";
    } else if (liveTree && !cpu && now - log.mtime >= 1800) {
      state = "stalled";
    } else if (liveTree) {
      state = phase;
      if (phase !== "gates") quiet = now - log.mtime;
    } else if (!branch.exists) {
      // A landed branch is deleted at landing, so its merge on the base is the proof.
      if (branch.landing) {
        state = "merged";
        note = `landed on ${base}`;
        if (branch.landing.subject.includes("(part of ")) {
          // A criterion left undone: the ticket stays open, which the row must not hide.
          note = "partly done, ticket open";
          const unmet = typeof tickets[id]?.unmet === "string" ? tickets[id]!.unmet!.replace(/[\n\r]+/g, " ") : "";
          if (needsDecision(unmet)) note = "partly done - needs a person";
          partlyDone = true;
        }
      } else state = "no branch";
    } else if (commits > 0 && branch.equalPatches) {
      // Every commit has an equal patch on the base: it landed rebased, and the branch is a duplicate.
      state = "merged";
      note = "merged as an equal patch (rebased)";
    } else if (commits > 0) {
      // A finished branch left standing: its run's outcome says why. One left by an earlier run is a leftover.
      const decided = outcomeState(id);
      const text = outcomeOf(id)?.text ?? "";
      if (decided) {
        state = decided;
        note = text;
      } else if (live && runIssues.has(id)) {
        state = "finished";
        note = "this run - landing decides it when the run ends";
      } else {
        state = "left over";
        note = `earlier run${text ? `: ${text}` : ""} - sandcastle clean`;
      }
    } else if (outcomeState(id)) {
      // No commits, but this run said what became of it: handed back, or nothing to change.
      state = outcomeState(id)!;
      note = outcomeOf(id)!.text;
      if (state === "held" && handMerged(id)) {
        state = "merged";
        note = handMergedNote(id);
      }
    } else if (branch.onBase) state = "merged";
    else state = "no commits";
    let group = groupOf(state);
    // Back on the queue after an earlier run: queued, not done. Never a ticket of the live run, which is handling it.
    if ((group === "merged" || group === "idle" || group === "left over") && queued.has(id) && requeued(id) && !(live && runIssues.has(id))) {
      state = live ? "later" : "queued";
      note = live ? "next run" : "for the next run";
      if (commits > 0) note = `${note} - on its earlier branch (${commits} commit(s))`;
      const on = blockedOn(id);
      if (on) {
        state = live ? "later" : "blocked";
        note = `waits for ${on} to close`;
      }
      group = groupOf(state);
    }
    let activity = tails[log.name]?.activity ?? "";
    if (keptTree) activity = `worktree kept (uncommitted files) - ${activity}`;
    if (note) activity = note;
    if (quiet >= 600) {
      activity = `quiet ${Math.floor(quiet / 60)}m - ${activity}`;
      noteTone = "hot";
    }
    let glyph: string | undefined;
    let tone: Tone | undefined;
    // Only on an unfinished row: a merged branch's old log keeps its line.
    if (RANK[group] <= 1 && tails[log.name]?.limit) {
      activity = `USAGE LIMIT REACHED - ${phase} model`;
      glyph = "!";
      tone = "hot";
    }
    // A suffixed branch shows its number in TICKET and its suffix here.
    if (/^[0-9]+(-[a-z]+)*$/.test(id) && id.includes("-")) activity = `[${id.slice(id.indexOf("-") + 1)}] ${activity}`;
    emit(
      { id, state, time, timeTone: "head", diff: diffCell(branch), cpu, tokens: tokensCell(tickets[id]?.tokens), cache: cacheShare(tickets[id]?.tokens, tickets[id]?.cacheRead), note: activity, noteTone, key: log.mtime, apart: recorded, glyph, tone },
      partlyDone,
    );
  }

  return { rows: sortRows(rows), counts, partly, later };
};

/** The phase word an inferred row's newest log shows. */
const phaseOfLog = (log: LogFact): string => {
  const n = log.name;
  return n.includes("-resolve-") ? "resolve" : n.includes("-review-codex-") ? "codex" : n.includes("-review-") ? "review" : n.includes("-repair-") ? "repair" : n.includes("-gates-") ? "gates" : "impl";
};

/**
 * Working, needing you, ready, queued, blocked, merged, later, then left over and idle - everything unfinished
 * first - and within a group the most recent change first (the queue: next to start first), then by number.
 */
export const sortRows = (rows: Row[]): Row[] => {
  const num = (id: string) => Number(/^\d+/.exec(id)?.[0] ?? 0);
  return [...rows].sort((a, b) => a.prio - b.prio || b.key - a.key || num(a.id) - num(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
};
