// Spending an API key is never silent. `credentials` merges the personal and the project `.env` key
// by key, so `ANTHROPIC_API_KEY` reaches the sandboxes whenever either file sets it - beside an OAuth
// token too, and Claude Code spends the API key first. A run billing API credits while every line
// described the subscription plan went unnoticed, so wherever the kit would spend a key it says so in
// red, and a run (or `preflight`, or `lean --measure`) stops before any sandbox to ask. With no
// terminal to ask on, `--api-key` or `SANDCASTLE_API_KEY=1` is the confirmation, and nothing else is.

import { confirm } from "./autonomy.ts";
import { OperatorError } from "./errors.ts";
import type { ApiKeySpend } from "./sandbox.ts";

/** Red on a terminal; plain when NO_COLOR is set (non-empty, no-color.org) or the output is a pipe or a file, as the status view has it. The words carry the meaning either way. */
export const red = (text: string, stream: { isTTY?: boolean } = process.stdout) =>
  stream.isTTY === true && !process.env.NO_COLOR ? `\x1b[31m${text}\x1b[0m` : text;

/** The opt-in, from `--api-key` (which sets it) or the environment. */
export const apiKeyOptedIn = (env: Record<string, string | undefined> = process.env) => env.SANDCASTLE_API_KEY === "1";

/** Where the key comes from, and the OAuth token it overrides: `ANTHROPIC_API_KEY from <file>` and, with one beside it, that it is ignored. */
export const spendSource = (spend: ApiKeySpend) => `ANTHROPIC_API_KEY from ${spend.file}`;
const ignored = (spend: ApiKeySpend) => (spend.oauth ? `; CLAUDE_CODE_OAUTH_TOKEN in ${spend.oauth} is ignored (Claude Code spends the API key first)` : "");

/** How to stop spending it: the key out of every file that sets it, and the subscription token that is then spent. */
export const removeKey = (spend: ApiKeySpend) =>
  `remove ANTHROPIC_API_KEY from ${spend.files.join(" and ")}${spend.oauth ? " (CLAUDE_CODE_OAUTH_TOKEN is then spent)" : " and set CLAUDE_CODE_OAUTH_TOKEN (`sandcastle setup`)"}`;

/** `sandcastle doctor`'s line (before colour): the key, its file, an ignored OAuth token, and the way out. */
export const doctorApiKeyLine = (spend: ApiKeySpend) =>
  `warn API credits: the sandboxes spend ${spendSource(spend)}${ignored(spend)}. Every run asks before it starts.\n       -> To bill your subscription instead, ${removeKey(spend)}.`;

/** The run's start line (before colour). */
export const runApiKeyLine = (spend: ApiKeySpend) => `API credits: this run bills API credits - the sandboxes spend ${spendSource(spend)}${ignored(spend)}.`;

/**
 * Stops `what` ("This run", "Preflight", "lean --measure") before it spends an API key unless someone
 * said yes: the opt-in, else the question on a terminal. With no terminal and no opt-in it refuses,
 * naming the flag and the key's removal. Nothing is asked when no key would be spent.
 */
export const confirmApiKey = async (
  spend: ApiKeySpend | undefined,
  what: string,
  options: { env?: Record<string, string | undefined>; ask?: (question: string) => Promise<boolean | undefined>; terminal?: boolean } = {},
) => {
  if (!spend || apiKeyOptedIn(options.env)) return;
  const bills = `${what} bills API credits (${spendSource(spend)})`;
  const ways = `Run it again with --api-key (or SANDCASTLE_API_KEY=1) to go ahead, or to bill your subscription instead, ${removeKey(spend)}.`;
  const yes = options.terminal === false ? undefined : await (options.ask ?? ((q) => confirm(q)))(red(`${bills}. Go ahead? [y/N] `));
  if (yes === undefined) throw new OperatorError(`${bills}, and there is no terminal to ask on. ${ways}`);
  if (!yes) throw new OperatorError(`Not started: ${bills.charAt(0).toLowerCase()}${bills.slice(1)}. ${ways}`);
};
