import { readFileSync } from "node:fs";

// `sandcastle help` is the header comment of src/cli.ts, so the help and the code cannot drift.
// It is read here, not in cli.ts, because the Herdr plugin's entry needs it without loading the
// whole CLI. Only the header: the code's own comments further down are not help.
const lines = readFileSync(new URL("./cli.ts", import.meta.url), "utf8").split("\n");
export const HELP = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3));

// A --help or -h anywhere in the arguments asks for text: a command that reads it as an argument it does not know
// would otherwise run (`clean --help` deleted branches).
export const wantsHelp = (args: string[]) => args.some((a) => a === "--help" || a === "-h");

// One command's entries: each first line and the indented lines that continue it. Every entry,
// not the first: `queue` has a second one for `queue --lint`. A command the help does not list
// (the internal `lean-apply`) gets the whole text.
export const helpFor = (command: string) => {
  const entry: string[] = [];
  HELP.forEach((l, start) => {
    if (l !== `  ${command}` && !l.startsWith(`  ${command} `)) return;
    entry.push(l);
    for (let i = start + 1; i < HELP.length && /^\s{4,}\S/.test(HELP[i]!); i++) entry.push(HELP[i]!);
  });
  return entry.length ? entry.join("\n") : HELP.join("\n");
};
