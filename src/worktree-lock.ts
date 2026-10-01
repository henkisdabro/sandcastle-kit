// Keeps a live sandbox's git worktree record out of every `git worktree prune`.
//
// Every sandbox shares the host repo's `.git`. Inside a container no other
// sandbox's worktree path exists, so an agent that runs `git worktree prune`
// (tidying a scratch worktree it made) deletes every other live sandbox's
// record - and the host's own prune, which Sandcastle runs before each new
// sandbox, then deletes the worktree directory an agent "repaired" with a
// container path. Two sandboxes of one run crashed that way
// (`safe.directory ... not a git repository`). Git never prunes a LOCKED
// worktree, from either side, so each sandbox's worktree is locked for its
// whole life and unlocked just before Sandcastle removes it.

import { execFileSync } from "node:child_process";

const REASON = "sandcastle: live sandbox";

const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Idempotent: the worktree hook locks each worktree the moment it exists, and
// the pipeline locks again in case Sandcastle reused one.
export const lockWorktree = (path: string) => {
  try {
    git(["worktree", "lock", "--reason", REASON, path]);
  } catch (error) {
    if (!/already locked/.test(String((error as { stderr?: string }).stderr ?? error))) throw error;
  }
};

// `git worktree remove --force` (Sandcastle's close) refuses a locked worktree.
export const unlockWorktree = (path: string) => {
  try {
    git(["worktree", "unlock", path]);
  } catch {
    // Already unlocked, or already gone - either way nothing holds it.
  }
};

// A run that crashed before its `finally` leaves its branch's worktree locked,
// and Sandcastle's create would then fail to clear it. Only this run ever
// works on `branch`, so releasing the lock here cannot touch a live sandbox.
export const releaseBranchWorktree = (branch: string) => {
  for (const entry of git(["worktree", "list", "--porcelain"]).split("\n\n")) {
    const lines = entry.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (path && lines.includes(`branch refs/heads/${branch}`) && lines.some((l) => l.startsWith("locked"))) {
      unlockWorktree(path);
    }
  }
};

// Every worktree this kit locked, for a run that ends before its `finally`
// (Ctrl-C, a crash): Sandcastle then prints `git worktree remove --force
// <path>` as the clean-up, which a locked worktree refuses. One run per
// project at a time (guard.ts), so every lock with our reason is that run's.
export const unlockAll = () => {
  try {
    for (const entry of git(["worktree", "list", "--porcelain"]).split("\n\n")) {
      const lines = entry.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      if (path && lines.includes(`locked ${REASON}`)) unlockWorktree(path);
    }
  } catch {
    /* not a repository any more - nothing to release */
  }
};

// A gate that hangs holds its whole step: one sat for twelve hours until it
// was killed by hand, with Docker itself unresponsive.
// Two bounds: `timeout` in the container catches a hung test run, and the host
// race catches a Docker that never answers. Either reads as a red gate (124),
// never as a pass. The output is returned so a red gate can be repaired.
// `-k`: a gate that ignores TERM is killed, not left running in the container
// after its slot is freed. The host race cancels nothing - Sandcastle's exec
// takes no signal - and only the sandbox's close ends what it started.
export const GATE_TIMEOUT_SECONDS = 45 * 60;
const HOST_GRACE_MS = 5 * 60 * 1000;

type ExecResult = { exitCode: number; stdout: string; stderr: string };
type Execs = {
  exec(cmd: string, options?: { onLine?: (line: string) => void }): Promise<ExecResult>;
};

// The kit's own credentials. A gate is the project's code - on a branch, code an agent wrote - and
// never needs them: run with them in its environment, a test that printed its environment put both
// tokens in the gate log, the terminal and the repair agent's prompt. So gates run without them, and
// any value that still turns up in their output is replaced.
export const KIT_CREDENTIALS = ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const secrets = new Set<string>();
/** Registers credential values to cut out of gate output (credentials() calls it). */
export const hideFromGates = (values: (string | undefined)[]) => {
  for (const v of values) if (v && v.length >= 8) secrets.add(v);
};
export const redact = (text: string) => {
  let out = text;
  for (const v of secrets) out = out.split(v).join("<redacted>");
  return out;
};

export const execGate = async (
  sandbox: Execs,
  cmd: string,
  options?: { onLine?: (line: string) => void },
): Promise<ExecResult> => {
  const unset = KIT_CREDENTIALS.map((k) => `-u ${k}`).join(" ");
  const bounded = `timeout -k 30 ${GATE_TIMEOUT_SECONDS} env ${unset} sh -c '${cmd.replace(/'/g, "'\\''")}'`;
  const onLine = options?.onLine;
  options = onLine ? { ...options, onLine: (line) => onLine(redact(line)) } : options;
  let timer: NodeJS.Timeout | undefined;
  const hostBound = new Promise<ExecResult>((resolve) => {
    timer = setTimeout(() => {
      console.log(`  gate "${cmd}" did not return within ${GATE_TIMEOUT_SECONDS / 60} min - counted as red`);
      resolve({ exitCode: 124, stdout: "", stderr: "timed out" });
    }, GATE_TIMEOUT_SECONDS * 1000 + HOST_GRACE_MS);
  });
  const since = Date.now();
  try {
    const raw = await Promise.race([sandbox.exec(bounded, options), hostBound]);
    const r = { ...raw, stdout: redact(raw.stdout), stderr: redact(raw.stderr) };
    // `timeout` exits 137, not 124, when it had to follow up with KILL. It is
    // still a timeout: nothing a repair pass could fix, and it would hang again.
    return r.exitCode === 137 && Date.now() - since >= GATE_TIMEOUT_SECONDS * 1000 ? { ...r, exitCode: 124 } : r;
  } finally {
    clearTimeout(timer);
  }
};
