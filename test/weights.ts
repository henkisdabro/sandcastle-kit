// test/shard.ts's WEIGHTS table from test/weights-reporter.ts's readings: each file's mean on each
// platform, then the mean of the platforms, in whole seconds, the files at MIN_SECONDS or more.
// Prints the table, or with --write puts it in place of the one in test/shard.ts. A reading is a
// JSON file, or a directory searched for them.
//
//   node test/weights.ts [--write] READING...
//
// Every CI run of the suite keeps its shards' readings as artifacts (`weights-<os>-<shard>`), so
// the table is refreshed from a green run on main, with no test run here:
//
//   gh run download RUN_ID --pattern 'weights-*' --dir "$TMPDIR/weights"
//   node test/weights.ts --write "$TMPDIR/weights"

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Files that took less than this are left out of the table: shard.ts counts each as one second. */
export const MIN_SECONDS = 2.5;

export type Reading = { platform: string; files: Record<string, number> };

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** Each file's milliseconds: its mean on each platform, then the mean of the platforms it ran on. */
export const merge = (readings: Reading[]): Map<string, number> => {
  const byPlatform = new Map<string, Map<string, number[]>>();
  for (const { platform, files } of readings) {
    const own = byPlatform.get(platform) ?? new Map<string, number[]>();
    byPlatform.set(platform, own);
    for (const [file, ms] of Object.entries(files)) own.set(file, [...(own.get(file) ?? []), ms]);
  }
  const perFile = new Map<string, number[]>();
  for (const own of byPlatform.values()) for (const [file, ms] of own) perFile.set(file, [...(perFile.get(file) ?? []), mean(ms)]);
  return new Map([...perFile].map(([file, ms]) => [file, mean(ms)]));
};

/** The table's lines for each file's milliseconds: heaviest first, then by name, whole seconds. */
export const weightsBlock = (totals: Map<string, number>): string => {
  const rows = [...totals]
    .filter(([, ms]) => ms / 1000 >= MIN_SECONDS)
    .map(([file, ms]) => [file, Math.round(ms / 1000)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ["const WEIGHTS: Record<string, number> = {", ...rows.map(([file, s]) => `  "${file}": ${s},`), "};"].join("\n");
};

/** shard.ts's source with its WEIGHTS table replaced by `block`. */
export const withWeights = (source: string, block: string): string => {
  const table = /^const WEIGHTS: Record<string, number> = \{\n[^]*?^\};$/m;
  if (!table.test(source)) throw new Error("test/shard.ts has no WEIGHTS table to replace");
  return source.replace(table, () => block);
};

const readingsIn = (path: string): Reading[] =>
  statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => readingsIn(join(path, name)))
    : path.endsWith(".json")
      ? [JSON.parse(readFileSync(path, "utf8")) as Reading]
      : [];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const readings = args.filter((a) => a !== "--write").flatMap(readingsIn);
  if (!readings.length) throw new Error("Use: node test/weights.ts [--write] READING... (JSON files from test/weights-reporter.ts, or directories of them)");
  const block = weightsBlock(merge(readings));
  if (!write) console.log(block);
  else {
    const shard = fileURLToPath(new URL("shard.ts", import.meta.url));
    writeFileSync(shard, withWeights(readFileSync(shard, "utf8"), block));
    console.log(`test/shard.ts: ${block.split("\n").length - 2} weights from ${readings.length} readings`);
  }
}
