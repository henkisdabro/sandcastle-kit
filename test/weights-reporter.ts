// A node:test reporter that prints test/shard.ts's WEIGHTS table, measured: each file's seconds are
// the sum of its top-level test:pass and test:fail durations. Run it one file at a time, so a
// file's time is not inflated by the others sharing the cores (`pnpm test:weights`):
//
//   node --test --test-concurrency=1 --test-reporter=./test/weights-reporter.ts test/*.test.ts
//
// A file under MIN_SECONDS is left out, as the table leaves it: shard.ts counts a file it does not
// list as one second, so only the slow files are worth a line. A file run alone has none of its
// neighbours' startup in these sums; the file's header in shard.ts says how its figures were taken.

import { relative } from "node:path";

/** Files that took less than this are left out of the table. */
export const MIN_SECONDS = 2.5;

type Event = { type: string; data: { file?: string; nesting?: number; details?: { duration_ms?: number } } };

/** The table's lines for each file's total milliseconds: heaviest first, then by name, whole seconds. */
export const weightsBlock = (totals: Map<string, number>): string => {
  const rows = [...totals]
    .filter(([, ms]) => ms / 1000 >= MIN_SECONDS)
    .map(([file, ms]) => [file, Math.round(ms / 1000)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ["const WEIGHTS: Record<string, number> = {", ...rows.map(([file, s]) => `  "${file}": ${s},`), "};", ""].join("\n");
};

export default async function* weightsReporter(source: AsyncIterable<Event>) {
  const totals = new Map<string, number>();
  for await (const { type, data } of source) {
    if ((type !== "test:pass" && type !== "test:fail") || data.nesting !== 0 || !data.file) continue;
    // The path as shard.ts spells it: relative to the repository root, with forward slashes.
    const file = relative(process.cwd(), data.file).split("\\").join("/");
    totals.set(file, (totals.get(file) ?? 0) + (data.details?.duration_ms ?? 0));
  }
  yield weightsBlock(totals);
}
