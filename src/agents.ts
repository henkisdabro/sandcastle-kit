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

import { claudeCode, codex } from "@ai-hero/sandcastle";
import type { ProjectConfig } from "./config.ts";
import { OperatorError } from "./errors.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
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

// Session capture is off: Sandcastle would otherwise copy every sandbox
// transcript into the host's ~/.claude/projects/, where it shows up in
// `claude --resume`. The .sandcastle/logs stream is the record.
//
// With capture off Sandcastle reports no usage for Claude at all: it reads it
// only from the captured session, and then only the last message's (the
// context size, not the spend). Every pass would go unmeasured. The stream's
// closing `result` line carries what the whole `claude -p` process spent,
// per model in `modelUsage` (subagents included), so it is read from there.
const claude = (model: string, effort: Effort) => {
  const provider = claudeCode(model, { effort, captureSessions: false });
  return {
    ...provider,
    parseStreamLine(line: string) {
      const events = provider.parseStreamLine(line);
      const usage = line.includes('"type":"result"') ? resultUsage(line) : undefined;
      return usage ? [...events, { type: "usage" as const, usage }] : events;
    },
  };
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
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

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
 * the first line alone hid the cause, the whole thing broke the run pane's line mid-JSON.
 */
export const agentFailure = (error: unknown) => {
  const text = (error instanceof Error ? error.message : String(error)).replace(/^\(FiberFailure\)\s*/, "").replace(/^\w*Error:\s*/, "");
  const first = text.split("\n")[0].replace(/:\s*$/, "");
  const code = text.match(/\[[\w-]+:([a-z_]+)\]/)?.[1];
  return (code ? `${first} - ${code.replace(/_/g, " ")}` : first).slice(0, 160);
};

// Runs the review with REVIEW_MODEL, and once more with IMPL_MODEL if it throws.
export const reviewWithFallback = <T>(
  label: string,
  run: (agent: ReturnType<typeof claudeCode>, model: string) => Promise<T>,
): Promise<T> =>
  run(claude(REVIEW_MODEL, REVIEW_EFFORT), REVIEW_MODEL).catch((error) => {
    if (REVIEW_MODEL === IMPL_MODEL) throw error;
    console.log(
      `${label}: ${REVIEW_MODEL} review failed (${agentFailure(error)}); ` +
        `the agent log's last line has the real cause. Reviewing with ${IMPL_MODEL}.`,
    );
    return run(claude(IMPL_MODEL, REVIEW_EFFORT), IMPL_MODEL);
  });

// The cross-family pass is a second opinion, not a gate: if it fails, the
// branch still has the Opus review and still has to pass the gates.
// Session capture is off so its sessions stay out of the host's ~/.codex.
export const crossReview = async <T>(
  label: string,
  run: (agent: ReturnType<typeof codex>) => Promise<T>,
): Promise<T | undefined> => {
  if (!CROSS_REVIEW) return undefined;
  try {
    return await run(codex(CROSS_REVIEW_MODEL, { effort: CROSS_REVIEW_EFFORT, captureSessions: false }));
  } catch (error) {
    console.log(`${label}: ${CROSS_REVIEW_MODEL} cross-review failed (${agentFailure(error)}); continuing without it.`);
    return undefined;
  }
};
