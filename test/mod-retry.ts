// When `claude plugin test mod` may be run a second time: only when every test it reports failed
// by the harness's own per-test limit ("timed out after 5000 ms"). The mod's tests drive fakes and a
// fake clock, so a timeout there is a starved process, not a defect; an assertion failure, or any
// other failure beside a timeout, is a defect and is never run again.

/** The failed tests in `claude plugin test` output, and whether any output beyond them is unexplained. */
export function failedTests(output: string): { names: string[]; timedOut: string[]; unexplained: boolean } {
  const names: string[] = [];
  const timedOut: string[] = [];
  let unexplained = false;
  let open: { name: string; body: string[] } | undefined;
  const close = () => {
    if (!open) return;
    // A timeout block says so and nothing else (a stack line may follow it).
    const lines = open.body.map((l) => l.trim()).filter(Boolean);
    const only = lines.every((l) => /^(?:Error: )?(?:this )?(?:test )?timed out after \d+ ?ms\.?$|^at /.test(l));
    if (only && lines.some((l) => /timed out after \d+ ?ms/.test(l))) timedOut.push(open.name);
    open = undefined;
  };
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const fail = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (fail) {
      close();
      names.push(fail[1]);
      open = { name: fail[1], body: [] };
    } else if (line.startsWith("(pass) ") || /^tests\/\S+:$/.test(line) || /^ *\d+ (pass|fail)$/.test(line) || /^Ran \d+ tests? /.test(line)) {
      close();
    } else if (open && (line.trim() === "" || /^\s/.test(line))) {
      open.body.push(line);
    } else if (line.trim() === "") {
      continue;
    } else {
      close();
      unexplained = true;
    }
  }
  close();
  return { names, timedOut, unexplained };
}

/** True for a failed run whose every failure is a harness timeout: the one case worth a second run. */
export function retryOnTimeout(output: string): boolean {
  const { names, timedOut, unexplained } = failedTests(output);
  return names.length > 0 && !unexplained && timedOut.length === names.length;
}
