// The idle mark: the one line the mod pins in the status line under the prompt between runs, in a
// project set up for sandcastle. Pure, and like run-state.ts it imports nothing: register.tsx
// gathers the facts and this module decides the text. The input is one object on purpose - the
// ready count, the project's hidden flag and a dismissal join it without a new signature.

/** What the line is decided from. */
export type MarkInput = {
  /** The project's `.sandcastle/config.ts` is a plain file: `sandcastle init` ran there. */
  setUp: boolean;
  /** The machine switch: false when the personal settings say `"idleMark": false`. */
  idleMark: boolean;
};

/** The line, or undefined to clear it. */
export const markText = (input: MarkInput): string | undefined => (input.setUp && input.idleMark ? "sandcastle" : undefined);

/**
 * Prints the personal machine settings, honouring `XDG_CONFIG_HOME` as the kit's `USER_CONFIG`
 * does (src/sandbox.ts). `cat` only: BSD and GNU alike. A missing file prints nothing.
 */
export const SETTINGS_SCRIPT = ['cat -- "${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/config.json" 2>/dev/null', "exit 0"].join("\n");

/**
 * The machine switch from the settings file's text. Off only for `"idleMark": false`: a file that
 * is not JSON, or any other value, leaves the mark on - `sandcastle doctor` is where those are
 * reported, and a typo never hides the mark silently the other way round.
 */
export const machineSwitch = (stdout: string): boolean => {
  try {
    const settings: unknown = JSON.parse(stdout);
    return !(typeof settings === "object" && settings !== null && !Array.isArray(settings) && (settings as Record<string, unknown>).idleMark === false);
  } catch {
    return true;
  }
};
