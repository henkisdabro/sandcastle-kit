// Preloaded into every test file's process (`--import ./test/no-stray.ts` in package.json's `test`,
// `test:shard` and `test:weights`, and test/run-shards.sh): a test file that writes to stdout or stderr outside `quietly` (test/quiet.ts)
// fails, so a green gate log carries nothing but node:test's own lines and a new noisy test cannot
// slip in unseen (test/no-stray.test.ts holds that).
//
// A test file's own process is the one to guard: node:test's child sets NODE_TEST_CONTEXT, and the
// runner process that prints the reporter lines does not. Reporter events leave a child as binary
// chunks on stdout, so only a string chunk there is a line the test wrote; on stderr, any chunk with content is (execFileSync passes a child's stderr on this way).
// What a child process writes to an inherited file descriptor never passes through here:
// test/quiet-output.test.ts runs its listed files with piped output for that.

import { writeSync } from "node:fs";

const stray: { stream: string; text: string; where: string }[] = [];

if (process.env.NODE_TEST_CONTEXT) {
  const guard = (stream: NodeJS.WriteStream, name: string, counts: (chunk: unknown) => boolean) => {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (counts(chunk)) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
        // The first frame in a test file says which line printed.
        const where = (new Error().stack ?? "").split("\n").find((l) => /\/test\/[^/]+\.ts/.test(l) && !l.includes("no-stray.ts"));
        stray.push({ stream: name, text, where: where?.trim() ?? "" });
      }
      return write(chunk, ...rest);
    }) as typeof stream.write;
  };
  guard(process.stdout, "stdout", (chunk) => typeof chunk === "string");
  // execFileSync with the default stderr hands the parent an empty chunk when the command said nothing.
  guard(process.stderr, "stderr", (chunk) => (chunk as string | Uint8Array).length > 0);

  process.on("exit", (code) => {
    if (stray.length === 0) return;
    // A file that already failed keeps its own failure; the stray lines are noise next to it.
    if (code !== 0) return;
    const shown = stray.slice(0, 5).map((s) => `  ${s.stream}: ${JSON.stringify(s.text.trimEnd().slice(0, 200))}${s.where ? ` (${s.where})` : ""}`);
    const more = stray.length > shown.length ? `\n  ... and ${stray.length - shown.length} more` : "";
    writeSync(2, `\ntest/no-stray.ts: this test file wrote ${stray.length} line(s) outside quietly() (test/quiet.ts):\n${shown.join("\n")}${more}\n`);
    process.exitCode = 1;
  });
}
