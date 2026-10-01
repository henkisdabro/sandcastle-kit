// A refusal the operator acts on (a missing config, a red gate, a live run): printed as a message, never a stack trace.
export class OperatorError extends Error {}

/** Edit distance between two words, for "did you mean" on a typo. */
export const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

/** The candidate nearest `word`, within two edits, if any. */
export const nearest = (word: string, candidates: string[]) =>
  candidates.filter((c) => distance(word, c) <= 2).sort((a, b) => distance(word, a) - distance(word, b))[0];
