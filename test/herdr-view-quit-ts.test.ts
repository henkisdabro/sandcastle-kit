// test/herdr-view-quit.test.ts with the TypeScript view in the status pane: INT there marks the view record
// `quit`, and a hangup, a TERM, another pane or no Herdr marks nothing, as with status.sh.
//
//   pnpm test:file test/herdr-view-quit-ts.test.ts

// Set before the import: the tests read the switch as they start each view.
process.env.SANDCASTLE_TEST_STATUS_IMPL = "ts";
await import("./herdr-view-quit.test.ts");

export {};
