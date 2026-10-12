// Preloaded into the TypeScript status view by test/status-run.ts: when `SANDCASTLE_TEST_NOW` (epoch
// seconds) is set, the view's clock is that instant, so a frame drawn by it is the one the bash view draws
// through the fixture's `date` (test/status-fixture.ts). The view itself has no test seam.

const fixed = Number(process.env.SANDCASTLE_TEST_NOW) * 1000;

if (Number.isFinite(fixed) && process.env.SANDCASTLE_TEST_NOW) {
  const Real = Date;
  class FixedDate extends Real {
    constructor(...args: unknown[]) {
      // @ts-expect-error: the spread is checked by Date's own overloads at run time
      super(...(args.length === 0 ? [fixed] : args));
    }
    static override now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
}
