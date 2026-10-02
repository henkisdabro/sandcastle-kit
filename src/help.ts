import { readFileSync } from "node:fs";

// `sandcastle help` is the header comment of src/cli.ts, so the help and the code cannot drift.
// It is read here, not in cli.ts, because the Herdr plugin's entry needs it without loading the
// whole CLI.
export const HELP = readFileSync(new URL("./cli.ts", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("//"))
  .map((l) => l.slice(3));

// A trailing --help or -h asks for text: a command that reads it as an argument it does not know
// would otherwise run (`clean --help` deleted branches).
export const wantsHelp = (args: string[]) => args.some((a) => a === "--help" || a === "-h");

// One command's entry: its first line and the indented lines that continue it. A command the help
// does not list (the internal `lean-apply`) gets the whole text.
export const helpFor = (command: string) => {
  const start = HELP.findIndex((l) => l === `  ${command}` || l.startsWith(`  ${command} `));
  if (start < 0) return HELP.join("\n");
  const entry = [HELP[start]!];
  for (let i = start + 1; i < HELP.length && /^\s{4,}\S/.test(HELP[i]!); i++) entry.push(HELP[i]!);
  return entry.join("\n");
};
