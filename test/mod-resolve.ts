// Imported by test/hermetic-env.ts, so every test process has it. The mod's hooks import each other
// without an extension (`./run-record`): Claude Code's `plugin validate --strict` refuses a `.ts`
// import path (TS5097) and reads no tsconfig that could allow it (#948). Node's type stripping
// resolves only the exact file name, so a test that imports `mod/hooks/run-state.ts` would fail on
// its first import. This hook adds `.ts` to an extensionless relative import made from inside
// `mod/hooks/`, and nowhere else: `src/` keeps naming its extensions, and never loads run-state.ts.

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const extensionless = /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier);
    if (extensionless && context.parentURL?.includes("/mod/hooks/")) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
