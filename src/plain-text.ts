// Text an agent wrote, or a tracker holds, reaches the user's terminal: an escape sequence in it could set the window
// title, write the clipboard (OSC 52) or clear the screen, and any control character moves the cursor. Whole sequences
// go first, so no `[2J` is left behind; then every other control. This module imports nothing: the status view, the
// report and the burndown all read through it, and the status view's own modules import run modules (an import cycle).
// oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern removes
const SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])?/g;
// oxlint-disable-next-line no-control-regex -- the control characters are what the pattern removes
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/** `s` with no escape sequence or control character left: a tab or line break is a space. */
export const plainText = (s: string): string => s.replace(SEQUENCES, "").replace(/[\t\n\r]/g, " ").replace(CONTROLS, "");

/** `s` as plain text line by line: a run record's multi-line message (a refused preflight's cause) keeps its lines. */
export const plainLines = (s: string): string => s.split("\n").map(plainText).join("\n");

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every string in a value read from a file, keys too, as plain text (`text` decides what a string value becomes). */
export const plainAll = (v: unknown, text: (s: string) => string = plainText): unknown =>
  typeof v === "string"
    ? text(v)
    : Array.isArray(v)
      ? v.map((x) => plainAll(x, text))
      : isObject(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [plainText(k), plainAll(x, text)]))
        : v;
