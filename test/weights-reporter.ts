// A node:test reporter that measures each test file for test/shard.ts's WEIGHTS table: a file's
// milliseconds are the sum of its top-level test:pass and test:fail durations. It prints one
// reading, JSON, which test/weights.ts turns into the table:
//
//   {"platform":"darwin","files":{"test/a.test.ts":1234.5,...}}
//
// CI's shards run it beside the spec reporter (`pnpm test:shard --test-reporter=...`), so every run
// on main measures each file as a shard runs it, sharing the runner's cores with its neighbours; a
// file's figure there is what it costs its shard. `pnpm test:weights` runs it one file at a time on
// this machine instead. A file run alone, or in a shard, has none of its startup in these sums.

import { relative } from "node:path";

type Event = { type: string; data: { file?: string; nesting?: number; details?: { duration_ms?: number } } };

export default async function* weightsReporter(source: AsyncIterable<Event>) {
  const files: Record<string, number> = {};
  for await (const { type, data } of source) {
    if ((type !== "test:pass" && type !== "test:fail") || data.nesting !== 0 || !data.file) continue;
    // The path as shard.ts spells it: relative to the repository root, with forward slashes.
    const file = relative(process.cwd(), data.file).split("\\").join("/");
    files[file] = (files[file] ?? 0) + (data.details?.duration_ms ?? 0);
  }
  yield `${JSON.stringify({ platform: process.platform, files })}\n`;
}
