// Committed files a command writes (`generated` in .sandcastle/config.ts): a merge
// conflict confined to them is not a decision for an agent. Take either side, run the
// command that writes them, commit. Everything here runs through the sandbox's exec, so
// the sandbox's git and shell do the work - POSIX sh, as the container's dash.

import { execFileSync } from "node:child_process";
import { execGate } from "./worktree-lock.ts";

export type Generated = { paths: string[]; regen: string };

export type Exec = {
  exec(cmd: string, options?: { onLine?: (line: string) => void }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

/** A path is a file, or a directory (with or without a trailing `/`) covering everything under it. */
export const covers = (path: string, file: string) =>
  file === path.replace(/\/$/, "") || file.startsWith(path.endsWith("/") ? path : path + "/");

/**
 * The entries to run for these conflicted files: those covering at least one, in config order,
 * each once. `undefined` when any file is covered by none (that conflict is not ours to
 * resolve), and when there is nothing to resolve.
 */
export const regensFor = (files: string[], generated: Generated[]): Generated[] | undefined => {
  if (!files.length || !generated.length) return undefined;
  if (files.some((f) => !generated.some((g) => g.paths.some((p) => covers(p, f))))) return undefined;
  return generated.filter((g) => files.some((f) => g.paths.some((p) => covers(p, f))));
};

export const shq = (t: string) => `'${t.replaceAll("'", "'\\''")}'`;

// Sandcastle sets the container's git identity when an agent run starts; a merge made
// before the first one needs it too. The host's is the author; the container's AGENT_COMMITTER env (sandboxEnv) is the committer.
export const hostIdentity = (root: string) => {
  const who = (key: string, fallback: string) => {
    try {
      return execFileSync("git", ["config", key], { encoding: "utf8", cwd: root }).trim() || fallback;
    } catch {
      return fallback;
    }
  };
  return `-c user.name=${shq(who("user.name", "Sandcastle"))} -c user.email=${shq(who("user.email", "sandcastle@localhost"))}`;
};

const lastLine = (r: { stdout: string; stderr: string }) => (r.stderr + "\n" + r.stdout).trim().split("\n").at(-1)?.slice(0, 160) ?? "";

/**
 * Resolve a merge in progress in the sandbox whose unmerged paths are `o.files`, all of them
 * generated: take a side, rerun `setup`, run each `regen`, stage what they wrote, commit.
 * On `ok: false` the merge is left as it is; the caller decides.
 */
export const resolveGenerated = async (
  sandbox: Exec,
  o: { files: string[]; generated: Generated[]; setup: string[]; message: string; identity: string },
): Promise<{ ok: true; regen: string[] } | { ok: false; reason: string }> => {
  const entries = regensFor(o.files, o.generated);
  if (!entries) {
    const outside = o.files.filter((f) => !o.generated.some((g) => g.paths.some((p) => covers(p, f))));
    return { ok: false, reason: `conflicts outside the generated paths: ${outside.join(", ")}` };
  }
  // Either side will do, regen rewrites the file; the fallbacks cover a file deleted on one side.
  for (const f of o.files) {
    const side = await sandbox.exec(
      `git checkout --ours -- ${shq(f)} 2>/dev/null || git checkout --theirs -- ${shq(f)} 2>/dev/null || git rm -q -- ${shq(f)}`,
    );
    if (side.exitCode !== 0) return { ok: false, reason: `could not take a side for ${f}` };
  }
  // The branch's install ran before the merge; a regen needing the other side's new dependency would fail.
  for (const cmd of o.setup) {
    const r = await execGate(sandbox, cmd);
    if (r.exitCode !== 0) return { ok: false, reason: `setup "${cmd}" exited ${r.exitCode}: ${lastLine(r)}` };
  }
  for (const e of entries) {
    const r = await execGate(sandbox, e.regen);
    if (r.exitCode !== 0) return { ok: false, reason: `regen "${e.regen}" exited ${r.exitCode}: ${lastLine(r)}` };
  }
  // Whatever regen rewrote under the declared paths, not only the conflicted files. `git add` of
  // a pathspec that matches nothing is fatal, so a path is added only if it exists or is tracked.
  const add = (p: string) => `if [ -e ${shq(p)} ] || [ -n "$(git ls-files -- ${shq(p)})" ]; then git add -A -- ${shq(p)}; fi`;
  const stage = [...o.files, ...entries.flatMap((e) => e.paths)].map(add);
  const staged = await sandbox.exec(stage.join(" && "));
  if (staged.exitCode !== 0) return { ok: false, reason: `could not stage: ${lastLine(staged)}` };
  const left = (await sandbox.exec("git diff --name-only --diff-filter=U")).stdout.trim();
  if (left) return { ok: false, reason: `still unmerged after regenerating: ${left.split("\n").join(", ")}` };
  // An explicit -m: --no-edit would keep the `# Conflicts:` lines of MERGE_MSG. --no-verify: the
  // gates run after, as for the landing merge.
  const commit = await sandbox.exec(`git ${o.identity} commit -q --no-verify -m ${shq(o.message)}`);
  if (commit.exitCode !== 0) return { ok: false, reason: `commit failed: ${lastLine(commit)}` };
  return { ok: true, regen: entries.map((e) => e.regen) };
};
