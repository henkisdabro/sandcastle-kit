// test/status-lifecycle.test.ts held against the TypeScript view: the same lifecycle - keys, Ctrl-C as a byte,
// INT, TERM, HUP, a resize, the terminal handed back, nothing left running - that file holds the view the suite
// is run with (status.sh by default) to.
//
//   pnpm test:file test/status-lifecycle-ts.test.ts

// Set before the import: the tests read the switch as they start each view.
process.env.SANDCASTLE_TEST_STATUS_IMPL = "ts";
await import("./status-lifecycle.test.ts");

export {};
