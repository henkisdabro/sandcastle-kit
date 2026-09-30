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
// see the CLAUDE_CODE_VERSION pin in docker/base.Dockerfile.

import { claudeCode, codex } from "@ai-hero/sandcastle";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

const effort = (name: string, allowed: readonly string[] = EFFORTS): Effort => {
  const value = process.env[name] ?? "high";
  if (!allowed.includes(value)) {
    throw new Error(`${name}=${value} - expected one of ${allowed.join(", ")}.`);
  }
  return value as Effort;
};

export const IMPL_MODEL = process.env.IMPL_MODEL ?? "claude-sonnet-5-5";
export const REVIEW_MODEL = process.env.REVIEW_MODEL ?? "claude-opus-5-5";
const IMPL_EFFORT = effort("IMPL_EFFORT");
const REVIEW_EFFORT = effort("REVIEW_EFFORT");

export const CROSS_REVIEW = process.env.CROSS_REVIEW === "1";
export const CROSS_REVIEW_MODEL = process.env.CROSS_REVIEW_MODEL ?? "gpt-6-astra";
// Codex has no `max`.
const CROSS_REVIEW_EFFORT = effort("CROSS_REVIEW_EFFORT", EFFORTS.slice(0, 4)) as Exclude<Effort, "max">;

export const MODELS_LINE =
  `implement ${IMPL_MODEL}/${IMPL_EFFORT} · review ${REVIEW_MODEL}/${REVIEW_EFFORT}` +
  (CROSS_REVIEW ? ` · cross-review ${CROSS_REVIEW_MODEL}/${CROSS_REVIEW_EFFORT}` : "");

// Session capture is off: Sandcastle would otherwise copy every sandbox
// transcript into the host's ~/.claude/projects/, where it shows up in
// `claude --resume`. The .sandcastle/logs stream is the record.
const claude = (model: string, effort: Effort) => claudeCode(model, { effort, captureSessions: false });

export const implAgent = () => claude(IMPL_MODEL, IMPL_EFFORT);

// Runs the review with REVIEW_MODEL, and once more with IMPL_MODEL if it throws.
export const reviewWithFallback = <T>(
  label: string,
  run: (agent: ReturnType<typeof claudeCode>) => Promise<T>,
): Promise<T> =>
  run(claude(REVIEW_MODEL, REVIEW_EFFORT)).catch((error) => {
    if (REVIEW_MODEL === IMPL_MODEL) throw error;
    console.log(
      `${label}: ${REVIEW_MODEL} review failed (${String(error).slice(0, 120)}); ` +
        `the agent log's last line has the real cause. Reviewing with ${IMPL_MODEL}.`,
    );
    return run(claude(IMPL_MODEL, REVIEW_EFFORT));
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
    console.log(`${label}: ${CROSS_REVIEW_MODEL} cross-review failed (${String(error).slice(0, 120)}); continuing without it.`);
    return undefined;
  }
};
