// When test/herdr-app-layout.test.ts runs `herdr-app check` a second time: only when the check failed
// because the app stopped the mod's render for running too long (about 50 ms of wall-clock time, with no
// option to raise it), which under a full suite's load is a starved process, not a defect. A thrown error,
// a syntax error, an unknown method or any other message is a defect and is never run again.

/** True for a failed check whose error, the first non-empty line, is exactly `interrupted`. */
export function retryOnInterrupted(output: string): boolean {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((l) => l.startsWith("check failed: "))) return false;
  const first = lines.find((l) => l.trim() !== "");
  return first?.trim() === "interrupted";
}
