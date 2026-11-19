// One decision type for the guards that decide whether something a sandbox produced may cross to the host. A guard
// that answers with a list or a boolean has no way to say "I could not tell", so a reader that failed read as
// "nothing here" and the branch landed. Every guard answers `allow`, `refuse` or `unknown`, and a caller holds on
// both of the last two: unknown is never allowed.

/** Why a guard held: a closed set, so a ledger line or a lint can say why without parsing words. */
export type ReasonCode =
  | "protected-path"
  | "symlink-entry"
  | "gitlink"
  | "manifest-unparseable"
  | "large-file"
  | "reader-failed";

/**
 * A guard's answer. `paths` names what a hold is for, as git holds the names, so a hold message and `git show` name
 * the real file; a reader that failed has none, and `detail` says what failed.
 */
export type Verdict =
  | { kind: "allow" }
  | { kind: "refuse" | "unknown"; code: ReasonCode; detail: string; paths?: string[]; override?: string };

export const ALLOW: Verdict = { kind: "allow" };

/** True for `refuse` and for `unknown`: a guard that could not tell holds. */
export const refuses = (v: Verdict): v is Exclude<Verdict, { kind: "allow" }> => v.kind !== "allow";

/** A reader that threw: held, with what failed. */
export const readerFailed = (what: string, error: unknown): Verdict => ({
  kind: "unknown",
  code: "reader-failed",
  detail: `${what}: ${String((error as Error)?.message ?? error).split("\n")[0].slice(0, 200)}`,
});

/**
 * What a hold names, for a list of held things: its paths, or, when it has none (a reader that failed), its code and
 * detail - an empty list would read as "nothing held".
 */
export const heldWords = (v: Verdict): string[] => (!refuses(v) ? [] : v.paths?.length ? v.paths : [`${v.code}: ${v.detail}`]);
