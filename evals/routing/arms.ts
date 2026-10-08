// The arms of the routing eval: which model and effort each kit role gets, and what a pass costs.
//
// An arm is named `<implement>/<review>[+mechanism]`, each role a model letter and an effort:
// `H-high/O-high` is Haiku 5.5 at high implementing and Opus 5.5 at high reviewing. It is set the
// way an operator would set it - the IMPL_* / REVIEW_* environment of one run - and a mechanism
// through the project's own `.claude/settings.json`, whose `env` and `advisorModel` reach every
// sandbox through lean. Nothing here needs a kit change, so a result says what a project can do today.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Role = { model: string; effort: Effort };
export type Arm = { id: string; implement: Role; review: Role; settings?: Record<string, unknown> };

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const MODELS: Record<string, string> = { H: HAIKU, S: SONNET, O: OPUS };
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const MECHANISMS: Record<string, Record<string, unknown>> = {
  // Haiku executes and consults Opus when it chooses to (Claude Code's advisor: Anthropic API and subscription only).
  advisor: { advisorModel: OPUS },
  // Every subagent the implementer starts runs on Haiku; whether it starts any is the model's call.
  "haiku-subagents": { env: { CLAUDE_CODE_SUBAGENT_MODEL: HAIKU } },
};

const role = (text: string, id: string): Role => {
  const [letter, effort] = text.split("-");
  if (!MODELS[letter] || !EFFORTS.includes(effort as Effort)) throw new Error(`arm ${id}: "${text}" is not <H|S|O>-<${EFFORTS.join("|")}>`);
  return { model: MODELS[letter], effort: effort as Effort };
};

export const parseArm = (id: string): Arm => {
  const [roles, mechanism] = id.split("+");
  const [implement, review] = roles.split("/");
  if (!review) throw new Error(`arm ${id}: expected <implement>/<review>, as in H-high/O-high`);
  if (mechanism && !MECHANISMS[mechanism]) throw new Error(`arm ${id}: unknown mechanism "${mechanism}" - one of ${Object.keys(MECHANISMS).join(", ")}`);
  return { id, implement: role(implement, id), review: role(review, id), ...(mechanism ? { settings: MECHANISMS[mechanism] } : {}) };
};

/**
 * Dollars per million tokens, list price. Claude Code writes the 1-hour cache (twice the input
 * price: the sandbox streams' own `costUSD` fit it exactly). Sonnet 5.5's cache read is the halved
 * price of 20261007; streams logged before then priced it at 0.20. Haiku 5.5 bills a request whose
 * prompt is over 100K tokens at `over100k` times its card.
 */
type Card = { input: number; output: number; cacheRead: number; cacheWrite: number; over100k?: number };
export const PRICES: Record<string, Card> = {
  [HAIKU]: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2, over100k: 5 },
  [SONNET]: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  [OPUS]: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
};

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** List-price dollars for `t` on `model`; `over100k` is the share of its requests whose prompt passed 100K tokens. */
export const dollars = (model: string, t: Tokens, over100k = 0) => {
  const card = PRICES[model];
  if (!card) return undefined;
  const scale = 1 + (card.over100k ? (card.over100k - 1) * over100k : 0);
  return (scale * (t.input * card.input + t.output * card.output + t.cacheRead * card.cacheRead + t.cacheWrite * card.cacheWrite)) / 1e6;
};

export const armEnv = (arm: Arm): Record<string, string> => ({
  IMPL_MODEL: arm.implement.model,
  IMPL_EFFORT: arm.implement.effort,
  REVIEW_MODEL: arm.review.model,
  REVIEW_EFFORT: arm.review.effort,
  CROSS_REVIEW: "0",
});
