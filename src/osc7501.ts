// OSC 7501, the one way a program tells herdr-core (herdr-core) what it is doing: written into its own
// terminal, read by the core and shown by its apps. Pure: the strings only, never where they go.
//
// Verified against hc 0.1.19 (and 0.1.17 before it): fields are `:`-separated (a record whose fields
// are `;`-separated is silently ignored), `progress` is 0..100, `title` and `msg` are base64 (the core
// shows them decoded), a record with `id=` is a child record beside the root, and `state=clear` removes a
// record (`clear` alone does not).

export type State = "idle" | "working" | "done" | "blocked" | "error";
/** Why a `blocked` record needs a person. */
export type Kind = "permission" | "question" | "auth";

export type Record7501 = {
  /** A child record's id; none for the terminal's root record. */
  id?: string;
  state: State;
  app?: string;
  kind?: Kind;
  /** 0..100; rounded and clamped. */
  progress?: number;
  title?: string;
  msg?: string;
};

// The core refuses a payload that is not escape-code-safe UTF-8, and one that is too long.
export const TEXT_MAX = 160;
const WORD = /^[A-Za-z0-9._-]{1,64}$/;

const word = (name: string, value: string) => {
  if (!WORD.test(value)) throw new Error(`OSC 7501 ${name} must match ${WORD}: ${JSON.stringify(value)}`);
  return value;
};

/** Control characters out, then cut by code point (never half a surrogate pair), then base64. */
const text = (value: string) => {
  // oxlint-disable-next-line no-control-regex -- the control characters are what is being removed
  const clean = [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, TEXT_MAX).join("");
  return Buffer.from(clean, "utf8").toString("base64");
};

const osc = (fields: string[]) => `\u001b]7501;${fields.join(":")}\u0007`;

export const record = (r: Record7501): string => {
  const fields: string[] = [];
  if (r.id !== undefined) fields.push(`id=${word("id", r.id)}`);
  fields.push(`state=${r.state}`);
  if (r.app !== undefined) fields.push(`app=${word("app", r.app)}`);
  if (r.kind !== undefined && r.state === "blocked") fields.push(`kind=${r.kind}`);
  if (r.progress !== undefined && Number.isFinite(r.progress) && (r.state === "working" || r.state === "blocked")) {
    fields.push(`progress=${Math.min(100, Math.max(0, Math.round(r.progress)))}`);
  }
  if (r.title !== undefined) fields.push(`title=${text(r.title)}`);
  if (r.msg !== undefined) fields.push(`msg=${text(r.msg)}`);
  return osc(fields);
};

/** Removes a child record, or with no id the root record. */
export const clear = (id?: string): string => osc([...(id === undefined ? [] : [`id=${word("id", id)}`]), "state=clear"]);

/** OSC 2: the terminal's title, which the official app's Agents panel shows where it does not show a record's `msg`. */
export const windowTitle = (title: string): string => {
  // oxlint-disable-next-line no-control-regex -- the control characters are what is being removed
  const clean = [...title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, TEXT_MAX).join("");
  return `\u001b]2;${clean}\u0007`;
};
