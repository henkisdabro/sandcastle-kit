// The model pairing every run uses, in one place.
//
// Sonnet 5.5 implements, Opus 5.5 reviews, both at high effort (20260930).
// Before that it was Opus 5.5 implementing and Fable 5.1 reviewing (from
// 20260923), and Sonnet implementing with Opus 5 reviewing before that.
//
// The review is the pass that earns the stronger model: in practice it catches
// what no gate fails on - a correct-looking change that double-counts money,
// or implements the right thing in the wrong place.
//
// A failed review falls back to the implementer's model rather than leaving a
// branch unreviewed. How a spent subscription allowance surfaces is worth
// knowing: the orchestrator reports a trust-dialog error and `exited with
// code 1`, while the real cause is the last line of the agent's own log,
// `You're out of usage credits`. Whatever the failed review committed stays on
// the branch, and the fallback reviews on top of it. preflight() now asks each
// model for one reply before the run, so a spent allowance stops it up front.
//
// CROSS_REVIEW=1 adds a third pass by a different model family (OpenAI, via
// Codex on the ChatGPT plan): Sonnet and Opus share training, and a reviewer
// that shares the implementer's blind spots is worth less.
//
// A model newer than the image's Claude Code is refused at the first call -
// the image follows Claude Code's `latest` release unless the project pins `claudeCode` (src/versions.ts).

import { readFileSync } from "node:fs";
import { claudeCode, codex } from "@ai-hero/sandcastle";
import type { ProjectConfig } from "./config.ts";
import { cutAtWord, OperatorError, promptExpansionLine } from "./errors.ts";
import { shq } from "./generated.ts";
import { CODEX_RATE_LIMITS_READOUT } from "./usage.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

const effort = (name: string, configured?: string, allowed: readonly string[] = EFFORTS, env: Record<string, string | undefined> = process.env): Effort => {
  const value = env[name] ?? configured ?? "high";
  if (!allowed.includes(value)) {
    throw new OperatorError(`${name}=${value} (env or .sandcastle/config.ts) - expected one of ${allowed.join(", ")}.`);
  }
  return value as Effort;
};

/** The cross-review run setting: off, or on with the model and effort it uses. */
export type CrossReviewSetting = { on: false } | { on: true; model: string; effort: Exclude<Effort, "max"> };

// The settings resolver (src/run-settings.ts) calls this with its own environment, and so does
// this module with the process's: one reading of CROSS_REVIEW and its two companions. The
// companions are read, and a bad effort refused, whether or not the pass is on.
export const crossReviewSetting = (env: Record<string, string | undefined>): CrossReviewSetting => {
  const model = env.CROSS_REVIEW_MODEL ?? "gpt-6-astra";
  // Codex has no `max`.
  const level = effort("CROSS_REVIEW_EFFORT", undefined, EFFORTS.slice(0, 4), env) as Exclude<Effort, "max">;
  return env.CROSS_REVIEW === "1" ? { on: true, model, effort: level } : { on: false };
};
const CROSS = crossReviewSetting(process.env);
export const CROSS_REVIEW = CROSS.on;
export const CROSS_REVIEW_MODEL = process.env.CROSS_REVIEW_MODEL ?? "gpt-6-astra";
const CROSS_REVIEW_EFFORT = CROSS.on ? CROSS.effort : "high";

/**
 * REPORT_SCHEMA=1: Claude passes also return a schema-validated report (`container/report.schema.json`), which a pass's
 * readers prefer to the own-line tags. Off, a run is what it was before: the same command, the same readers, no timings field.
 */
export const REPORT_SCHEMA = process.env.REPORT_SCHEMA === "1";

export let IMPL_MODEL: string;
export let REVIEW_MODEL: string;
let IMPL_EFFORT: Effort;
let REVIEW_EFFORT: Effort;
export let MODELS_LINE: string;

// An env var wins for one run, then the project's config.ts, then the kit's
// default. loadProject() calls this; importers see the values through ESM's
// live bindings, so every use must read them after the project has loaded.
export const configureModels = (config: Pick<ProjectConfig, "implement" | "review"> = {}) => {
  IMPL_MODEL = process.env.IMPL_MODEL ?? config.implement?.model ?? "claude-sonnet-5-5";
  REVIEW_MODEL = process.env.REVIEW_MODEL ?? config.review?.model ?? "claude-opus-5-5";
  IMPL_EFFORT = effort("IMPL_EFFORT", config.implement?.effort);
  REVIEW_EFFORT = effort("REVIEW_EFFORT", config.review?.effort);
  MODELS_LINE =
    `implement ${IMPL_MODEL}/${IMPL_EFFORT} · review ${REVIEW_MODEL}/${REVIEW_EFFORT}` +
    (CROSS_REVIEW ? ` · cross-review ${CROSS_REVIEW_MODEL}/${CROSS_REVIEW_EFFORT}` : "");
};
configureModels();

// The built-in tools a sandbox pass loads. Every tool's schema sits in the prompt prefix and is paid
// again on every turn; across hundreds of recorded passes only these were ever used. Glob and Grep are
// left out on purpose: Linux native builds of Claude Code drop them and give Bash embedded `bfs` and `ugrep`.
export const BASE_TOOLS = ["Bash", "Read", "Edit", "Write", "TaskStop"];

/** The tools a pass loads: the base set, Skill for a kept skill or command, ToolSearch for a kept MCP server (its tools are deferred), then each `tool:<Name>` entry. */
export const toolsFor = (keep: readonly string[]): string[] => {
  const tools = [...BASE_TOOLS];
  if (keep.some((id) => id.startsWith("skill:") || id.startsWith("command:"))) tools.push("Skill");
  if (keep.some((id) => id.startsWith("mcp:"))) tools.push("ToolSearch");
  for (const id of keep) if (id.startsWith("tool:") && !tools.includes(id.slice("tool:".length))) tools.push(id.slice("tool:".length));
  return tools;
};

let TOOLS: string[];
// loadProject() calls this with the project's `lean.keep`; like the models, read it after the project has loaded.
export const configureTools = (keep: readonly string[] = []) => {
  TOOLS = toolsFor(keep);
};
configureTools();

// Claude Code's own range for CLAUDE_CODE_AUTO_COMPACT_WINDOW, in tokens; src/config.ts refuses a value outside it.
export const AUTO_COMPACT_MIN = 100_000;
export const AUTO_COMPACT_MAX = 1_000_000;

let AUTO_COMPACT_WINDOW: number | undefined;
// loadProject() calls this with the project's `autoCompactWindow`; unset passes nothing, so Claude Code's own default applies.
export const configureAutoCompact = (window?: number) => {
  AUTO_COMPACT_WINDOW = window;
};

/**
 * Sandcastle's claude command with `--tools '<list>'` before its closing ` -p -`. Refuses a command of
 * another shape: an unknown tool name in `--tools` is ignored silently by Claude Code, and a Sandcastle
 * update that moved the end of the command must never run passes without the cut.
 */
export const withTools = (command: string, tools: readonly string[]): string => {
  const tail = " -p -";
  if (!command.startsWith("claude ") || !command.endsWith(tail)) {
    throw new Error(
      `Sandcastle's claude command no longer has the shape the --tools allow-list needs (starts with "claude ", ends with "${tail}"): update withTools in src/agents.ts. Command: ${command}`,
    );
  }
  return `${command.slice(0, -tail.length)} --tools '${tools.join(",")}'${tail}`;
};

// The schema as the command carries it: compact, read on the host when the first command is built (the file is also
// mounted at /etc/claude-code, but the flag takes the schema itself).
let REPORT_SCHEMA_JSON: string | undefined;
const reportSchemaJson = () =>
  (REPORT_SCHEMA_JSON ??= JSON.stringify(JSON.parse(readFileSync(new URL("../container/report.schema.json", import.meta.url), "utf8"))));

/**
 * Sandcastle's claude command with `--json-schema '<schema>'` before its closing ` -p -`, as `withTools` adds
 * `--tools`, and with the same refusal of a command of another shape: a flag put in the wrong place would run
 * every pass without the report and record "no result" for it.
 */
export const withSchema = (command: string, schema: string): string => {
  const tail = " -p -";
  if (!command.startsWith("claude ") || !command.endsWith(tail)) {
    throw new Error(
      `Sandcastle's claude command no longer has the shape the --json-schema flag needs (starts with "claude ", ends with "${tail}"): update withSchema in src/agents.ts. Command: ${command}`,
    );
  }
  return `${command.slice(0, -tail.length)} --json-schema ${shq(schema)}${tail}`;
};

/** The completion signal the library looks for by default, and the schema's only value for `signal`. */
export const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

/** The report as the schema shapes it. */
export type Report = {
  signal: typeof COMPLETION_SIGNAL;
  unmet: { assessed: boolean; items: { who: "agent" | "person"; text: string }[] };
  changelog: string[];
  followups: string[];
  ungated: string[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => k in v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * A `structured_output` as a report, or why it is none. Claude Code validates against the schema it was given, but
 * strict mode cannot say two things the kit needs (`signal` only the completion signal is in the schema; "assessed: false
 * means no items" is not), and a Claude Code that skipped validation must not be trusted for the shape.
 */
export const reportFrom = (value: unknown): { report: Report } | { missing: string } => {
  const invalid = (what: string) => ({ missing: `invalid: ${what}` });
  if (!isRecord(value) || !exactKeys(value, ["signal", "unmet", "changelog", "followups", "ungated"])) return invalid("not an object with the report's five fields");
  if (value.signal !== COMPLETION_SIGNAL) return invalid("signal is not the completion signal");
  const { unmet } = value;
  if (!isRecord(unmet) || !exactKeys(unmet, ["assessed", "items"]) || typeof unmet.assessed !== "boolean" || !Array.isArray(unmet.items)) return invalid("unmet is not {assessed, items}");
  const items = unmet.items.every((i) => isRecord(i) && exactKeys(i, ["who", "text"]) && (i.who === "agent" || i.who === "person") && typeof i.text === "string");
  if (!items) return invalid("an unmet item is not {who, text}");
  if (!unmet.assessed && unmet.items.length) return invalid("unmet is not assessed but has items");
  if (!strings(value.changelog) || !strings(value.followups) || !strings(value.ungated)) return invalid("changelog, followups and ungated are not lists of strings");
  return { report: value as Report };
};

/** What the capture knows of a pass's last iteration (`ReportCapture.read`). */
export type ReportFacts = {
  /** The report, when a valid one came. */
  report?: Report;
  /** Why none did: `no result line`, `no structured_output`, `retries exhausted` or `invalid: <what>`. */
  missing?: string;
  /** The iteration's output by the library's rule: the `result` text, else the `text` events. */
  output: string;
  /** The `StructuredOutput` tool calls seen. */
  tries: number;
  /** The `result` line's `num_turns`. */
  turns?: number;
  /** From the moment the completion signal armed the library's grace window to the `result` line (or, cut off, the pass's end). Absent when the signal never came. */
  gapMs?: number;
  /** The longest stretch with no line from that moment on, to the `result` line or the pass's end: what a completion timeout must exceed. */
  silenceMs?: number;
  /** No `result` line followed the signal. */
  cutOff?: true;
};

/** The events of one stream line as the library's parser gives them; the capture reads only these two. */
type StreamEvent = { type: string; text?: string; result?: string };

/**
 * Keeps, from one pass's stream, the report and the timing the schema's rollout needs measured (#820). `reset()` at each
 * command (a pass that runs again starts clean), `line()` for each stream line with the events the library parsed from
 * it, `finish()` when the pass returns or throws, `read()` for the facts. The clock is a parameter for a test.
 */
export const reportCapture = (now: () => number = Date.now) => {
  type State = {
    texts: string;
    resultText?: string;
    accumulated: string;
    structured?: { value: unknown };
    subtype?: string;
    sawResult: boolean;
    tries: number;
    turns?: number;
    signalAt?: number;
    resultAt?: number;
    lastLineAt?: number;
    silenceMs: number;
    endedAt?: number;
  };
  const fresh = (): State => ({ texts: "", accumulated: "", sawResult: false, tries: 0, silenceMs: 0 });
  let s = fresh();
  return {
    reset() {
      s = fresh();
    },
    line(raw: string, events: readonly StreamEvent[]) {
      const at = now();
      for (const e of events) {
        if (e.type === "text" && typeof e.text === "string") {
          s.texts += e.text;
          s.accumulated += e.text;
        } else if (e.type === "result" && typeof e.result === "string") {
          s.resultText = e.result;
          s.accumulated += e.result;
        }
      }
      let isResult = false;
      if (raw.includes('"type":"result"') || raw.includes("StructuredOutput")) {
        try {
          const parsed = JSON.parse(raw) as { type?: string; subtype?: string; structured_output?: unknown; num_turns?: unknown; message?: { content?: unknown } };
          if (parsed.type === "result") {
            isResult = true;
            s.sawResult = true;
            s.subtype = parsed.subtype;
            s.structured = parsed.structured_output === undefined || parsed.structured_output === null ? undefined : { value: parsed.structured_output };
            if (typeof parsed.num_turns === "number") s.turns = parsed.num_turns;
          } else if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
            for (const block of parsed.message.content as { type?: string; name?: string }[]) if (block?.type === "tool_use" && block.name === "StructuredOutput") s.tries++;
          }
        } catch {
          // A line that is not JSON is no result.
        }
      }
      // The library arms its grace window on the first line after which the text and result events, accumulated, hold the signal.
      if (s.signalAt === undefined) {
        if (s.accumulated.includes(COMPLETION_SIGNAL)) {
          s.signalAt = at;
          s.lastLineAt = at;
        }
      } else if (s.resultAt === undefined) {
        s.silenceMs = Math.max(s.silenceMs, at - (s.lastLineAt ?? at));
        s.lastLineAt = at;
      }
      if (isResult && s.resultAt === undefined && s.signalAt !== undefined) s.resultAt = at;
    },
    finish(at: number = now()) {
      s.endedAt ??= at;
    },
    read(): ReportFacts {
      const output = s.resultText ? s.resultText : s.texts;
      let found: { report: Report } | { missing: string };
      if (!s.sawResult) found = { missing: "no result line" };
      else if (s.subtype === "error_max_structured_output_retries") found = { missing: "retries exhausted" };
      else if (!s.structured) found = { missing: "no structured_output" };
      else found = reportFrom(s.structured.value);
      const facts: ReportFacts = { ...found, output, tries: s.tries, ...(s.turns !== undefined ? { turns: s.turns } : {}) };
      if (s.signalAt !== undefined) {
        if (s.resultAt !== undefined) {
          facts.gapMs = s.resultAt - s.signalAt;
          facts.silenceMs = s.silenceMs;
        } else {
          const end = s.endedAt ?? now();
          facts.gapMs = end - s.signalAt;
          facts.silenceMs = Math.max(s.silenceMs, end - (s.lastLineAt ?? s.signalAt));
          facts.cutOff = true;
        }
      }
      return facts;
    },
  };
};
export type ReportCapture = ReturnType<typeof reportCapture>;

// One capture per Claude agent made with REPORT_SCHEMA=1, found from the agent object a pass was given.
const captures = new WeakMap<object, ReportCapture>();
/** The capture of the agent a pass was given: none for a Codex agent, or with REPORT_SCHEMA off. */
export const passReport = (agent: object): ReportCapture | undefined => captures.get(agent);

// Session capture is off: Sandcastle would otherwise copy every sandbox
// transcript into the host's ~/.claude/projects/, where it shows up in
// `claude --resume`. The .sandcastle/logs stream is the record.
//
// With capture off Sandcastle reports no usage for Claude at all: it reads it
// only from the captured session, and then only the last message's (the
// context size, not the spend). Every pass would go unmeasured. The stream's
// closing `result` line carries what the whole `claude -p` process spent,
// per model in `modelUsage` (subagents included), so it is read from there.
//
// Auto memory is off and the tools are cut to TOOLS: both are fixed prompt prefix paid on every turn,
// and a sandbox's memory directory dies with its container, so nothing it wrote would be read again.
const claude = (model: string, effort: Effort) => {
  const provider = claudeCode(model, { effort, captureSessions: false, env: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...(AUTO_COMPACT_WINDOW === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(AUTO_COMPACT_WINDOW) }),
    },
  });
  const capture = REPORT_SCHEMA ? reportCapture() : undefined;
  const agent = {
    ...provider,
    buildPrintCommand(options: Parameters<typeof provider.buildPrintCommand>[0]) {
      const printed = provider.buildPrintCommand(options);
      // Each command is one iteration: the capture describes the last one only.
      capture?.reset();
      const command = withTools(printed.command, TOOLS);
      return { ...printed, command: capture ? withSchema(command, reportSchemaJson()) : command };
    },
    parseStreamLine(line: string) {
      const events = provider.parseStreamLine(line);
      capture?.line(line, events);
      const usage = line.includes('"type":"result"') ? resultUsage(line) : undefined;
      return usage ? [...events, { type: "usage" as const, usage }] : events;
    },
  };
  if (capture) captures.set(agent, capture);
  return agent;
};

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type ModelUsage = { inputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number };

const resultUsage = (line: string) => {
  try {
    const r = JSON.parse(line) as { type?: string; usage?: Usage; modelUsage?: Record<string, ModelUsage> };
    if (r.type !== "result") return undefined;
    const models = Object.values(r.modelUsage ?? {});
    if (models.length) {
      const sum = (k: keyof ModelUsage) => models.reduce((n, m) => n + (m[k] ?? 0), 0);
      return {
        inputTokens: sum("inputTokens"),
        cacheCreationInputTokens: sum("cacheCreationInputTokens"),
        cacheReadInputTokens: sum("cacheReadInputTokens"),
        outputTokens: sum("outputTokens"),
      };
    }
    const u = r.usage;
    if (!u) return undefined;
    return {
      inputTokens: u.input_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
    };
  } catch {
    return undefined;
  }
};

/** A ticket's own choice of implementer, from its `model:` and `effort:` labels. */
export type Override = { model?: string; effort?: Effort };

// The model id ends up in the agent command that runs in the container, so
// only characters a shell reads as plain text get through.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

// Refuses on the host, before any sandbox starts: a bad label costs nothing then.
export const ticketOverride = (ref: string, labels: string[]): Override => {
  const out: Override = {};
  let modelLabel: string | undefined;
  let effortLabel: string | undefined;
  for (const label of labels) {
    if (label.startsWith("effort:")) {
      const level = label.slice("effort:".length);
      if (!(EFFORTS as readonly string[]).includes(level)) {
        throw new OperatorError(
          `NOT STARTED: ${ref} has the label "${label}" - expected effort:low, effort:medium, effort:high, effort:xhigh or effort:max. Fix or remove the label.`,
        );
      }
      if (effortLabel !== undefined && effortLabel !== label) {
        throw new OperatorError(`NOT STARTED: ${ref} has the labels "${effortLabel}" and "${label}" - keep one.`);
      }
      effortLabel = label;
      out.effort = level as Effort;
    } else if (label.startsWith("model:")) {
      const id = label.slice("model:".length);
      if (!MODEL_ID.test(id)) {
        throw new OperatorError(
          `NOT STARTED: ${ref} has the label "${label}" - it names no usable model. Use a model id such as model:claude-opus-5-5, or remove the label.`,
        );
      }
      if (modelLabel !== undefined && modelLabel !== label) {
        throw new OperatorError(`NOT STARTED: ${ref} has the labels "${modelLabel}" and "${label}" - keep one.`);
      }
      modelLabel = label;
      out.model = id;
    }
  }
  return out;
};

// The text after a ticket in the run's start line and in `sandcastle queue`; empty without a label.
export const implementNote = (o: Override) => (o.model || o.effort ? ` [implement ${o.model ?? IMPL_MODEL}/${o.effort ?? IMPL_EFFORT}]` : "");

export const implAgent = (o: Override = {}) => claude(o.model ?? IMPL_MODEL, o.effort ?? IMPL_EFFORT);

/**
 * One readable line for an agent that failed. The library's error is "(FiberFailure) AgentError:
 * claude-code exited with code 1:" with the cause on the next line as `[claude-code:<code>] {json}`;
 * the first line alone hid the cause, the whole thing broke the run pane's line mid-JSON. Cut at a word, not mid-word.
 */
export const agentFailure = (error: unknown) => {
  const text = (error instanceof Error ? error.message : String(error)).replace(/^\(FiberFailure\)\s*/, "").replace(/^\w*Error:\s*/, "");
  const first = text.split("\n")[0].replace(/:\s*$/, "");
  const code = text.match(/\[[\w-]+:([a-z_]+)\]/)?.[1];
  return cutAtWord(code ? `${first} - ${code.replace(/_/g, " ")}` : first);
};

// Runs the review with REVIEW_MODEL, and once more with IMPL_MODEL if it throws - but not for a prompt that could
// not be expanded (GitHub's failure or a setup problem, not the model's): the other model would read the same ticket and fail the same way.
export const reviewWithFallback = <T>(
  label: string,
  run: (agent: ReturnType<typeof claudeCode>, model: string) => Promise<T>,
): Promise<T> =>
  run(claude(REVIEW_MODEL, REVIEW_EFFORT), REVIEW_MODEL).catch((error) => {
    if (REVIEW_MODEL === IMPL_MODEL || promptExpansionLine(error) !== undefined) throw error;
    console.log(
      `${label}: ${REVIEW_MODEL} review failed (${agentFailure(error)}); ` +
        `the agent log's last line has the real cause. Reviewing with ${IMPL_MODEL}.`,
    );
    return run(claude(IMPL_MODEL, REVIEW_EFFORT), IMPL_MODEL);
  });

// Codex's `exec --json` stream has no rate limits (its events are the thread, the turns and the items), and
// with `captureSessions: false` the session that does carry them - `rate_limits` on each `token_count` event -
// stays in the sandbox, out of the host's ~/.codex, and goes with it. So the pass's command, once `codex exec`
// has ended, prints that session's last `rate_limits` as one more stdout line (`CODEX_RATE_LIMITS_READOUT`),
// which the raw stream carries into the pass's `.jsonl` sidecar like any other line, and `watchUsage` reads it
// there. The exit code is codex's own; the library's parser drops the line as it does any it does not know.
const codexAgent = (model: string, effort: Exclude<Effort, "max">) => {
  const provider = codex(model, { effort, captureSessions: false });
  return {
    ...provider,
    buildPrintCommand(options: Parameters<typeof provider.buildPrintCommand>[0]) {
      const printed = provider.buildPrintCommand(options);
      return { ...printed, command: `${printed.command}; rc=$?; ${CODEX_RATE_LIMITS_READOUT}; exit $rc` };
    },
  };
};

// The cross-family pass is a second opinion, not a gate: if it fails, the
// branch still has the Opus review and still has to pass the gates.
// Session capture is off so its sessions stay out of the host's ~/.codex.
export const crossReview = async <T>(
  label: string,
  run: (agent: ReturnType<typeof codex>) => Promise<T>,
): Promise<T | undefined> => {
  if (!CROSS_REVIEW) return undefined;
  try {
    return await run(codexAgent(CROSS_REVIEW_MODEL, CROSS_REVIEW_EFFORT));
  } catch (error) {
    console.log(`${label}: ${CROSS_REVIEW_MODEL} cross-review failed (${agentFailure(error)}); continuing without it.`);
    return undefined;
  }
};
