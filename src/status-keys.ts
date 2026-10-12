// The keys in what the status view reads from its terminal. One read can hold several keys - fast typing, key
// repeat, a paste: "\x1b[Aq" is an arrow key and then q - so an escape sequence is taken as one key and what
// follows it as keys of their own, never swallowed with it.

// oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern is for
const SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O[\s\S]|[^\x1b])/y;
// A sequence the read ends inside: its rest comes with the next read, or it was the Esc key alone.
// oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern is for
const PARTIAL = /\x1b(?:\[[0-?]*[ -/]*|O)?$/y;

/** The keys in `input`, an escape sequence one key, and `rest`: a sequence it ends inside (a lone Esc too), held for the next read. */
export const keysOf = (input: string): { keys: string[]; rest: string } => {
  const keys: string[] = [];
  for (let i = 0; i < input.length; ) {
    if (input[i] !== "\x1b") {
      keys.push(input[i]!);
      i++;
      continue;
    }
    PARTIAL.lastIndex = i;
    if (PARTIAL.test(input)) return { keys, rest: input.slice(i) };
    SEQUENCE.lastIndex = i;
    // Esc and Esc again: the first is the Esc key.
    const key = SEQUENCE.exec(input)?.[0] ?? "\x1b";
    keys.push(key);
    i += key.length;
  }
  return { keys, rest: "" };
};
