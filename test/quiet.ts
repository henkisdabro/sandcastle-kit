// Runs fn with console.log captured, so a passing test leaves nothing but node:test's own lines in
// a gate log (test/no-stray.ts fails a test file that prints outside it). Returns what was printed for a test that
// wants to assert on it.
export const quietly = async <T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = real;
  }
};
