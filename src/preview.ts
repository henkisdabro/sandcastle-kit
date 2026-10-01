// Landing preview: `git merge-tree` of each unlanded agent branch onto the base, oldest
// first, in the project image. Nothing is merged and nothing is written to the repo.
//
// `merge-tree --write-tree` needs git 2.38; the host minimum is 2.31, so the merges run in
// the image (git 2.47). The repo's `.git` is mounted read-only; the trees and commits git
// writes go to a scratch object directory under the project root, removed afterwards.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { sh } from "./sandbox.ts";
import { refOf } from "./tracker.ts";
import { largeFiles, protectedChanges } from "./guard.ts";

export type PreviewRow = { branch: string; id: string; head: string; result: "clean" | "conflict" | "error"; files: string[]; detail?: string };
export type Runner = (script: string, args: string[], dirs: { gitDir: string; scratch: string }) => { status: number | null; stdout: string; stderr: string };

// POSIX sh, run as `sh -c SCRIPT sh <base sha> <branch sha>...`. It reads only SHAs, never
// branch names (the host resolves those), and always exits 0: a failed merge is a row, not a
// crash. A clean merge becomes the next branch's base, as landing would make it; a conflicting
// branch is skipped, as landing leaves it out.
export const PREVIEW_SCRIPT = `
export GIT_DIR="$REPO_GIT" GIT_OBJECT_DIRECTORY="$SCRATCH" GIT_ALTERNATE_OBJECT_DIRECTORIES="$REPO_GIT/objects"
export GIT_AUTHOR_NAME=sandcastle-preview GIT_AUTHOR_EMAIL=preview@localhost
export GIT_COMMITTER_NAME=sandcastle-preview GIT_COMMITTER_EMAIL=preview@localhost
g() { git -c safe.directory='*' "$@"; }
last() { grep -v '^$' | tail -n 1; }
head=$1
shift
for b in "$@"; do
  out=$(g merge-tree --write-tree --name-only --no-messages "$head" "$b" 2>"$SCRATCH/stderr")
  rc=$?
  if [ "$rc" -eq 0 ]; then
    tree=$(printf '%s\\n' "$out" | head -n 1)
    if next=$(g commit-tree "$tree" -p "$head" -p "$b" -m preview 2>"$SCRATCH/stderr"); then
      head=$next
      printf '%s\\tclean\\n' "$b"
    else
      printf '%s\\terror\\t%s\\n' "$b" "$(last <"$SCRATCH/stderr")"
    fi
  elif [ "$rc" -eq 1 ]; then
    printf '%s\\tconflict' "$b"
    printf '%s\\n' "$out" | tail -n +2 | grep -v '^$' | while read -r f; do printf '\\t%s' "$f"; done
    printf '\\n'
  else
    printf '%s\\terror\\t%s\\n' "$b" "$({ cat "$SCRATCH/stderr"; printf '%s\\n' "$out"; } | last)"
  fi
done
exit 0
`;

// A run lands in the order branches finish, with carried branches first; an older tip is the
// closest the branches alone can say to both.
export const unlanded = (project: Project): { branch: string; id: string; head: string }[] => {
  const listed = sh("git", ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)", "refs/heads/agent/"], project.root);
  const found: { branch: string; id: string; head: string; date: number }[] = [];
  for (const line of listed.split("\n")) {
    const [branch, head, date] = line.split("\t");
    const id = /^agent\/issue-(.+)$/.exec(branch ?? "")?.[1];
    if (!id) continue;
    if (Number(sh("git", ["rev-list", "--count", `refs/heads/${project.baseBranch}..refs/heads/${branch}`], project.root)) > 0) {
      found.push({ branch, id, head, date: Number(date) });
    }
  }
  found.sort((a, b) => a.date - b.date || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
  return found.map(({ branch, id, head }) => ({ branch, id, head }));
};

export const preview = (project: Project, run: Runner): PreviewRow[] => {
  const branches = unlanded(project);
  if (!branches.length) return [];
  const gitDir = sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project.root);
  const baseSha = sh("git", ["rev-parse", `refs/heads/${project.baseBranch}`], project.root);
  // Under the project root, not os.tmpdir(): the root is shared with the container runtime on
  // macOS, a temp dir there is not guaranteed to be.
  const runDir = join(project.root, ".sandcastle/.run");
  mkdirSync(runDir, { recursive: true });
  const scratch = mkdtempSync(join(runDir, "preview-"));
  try {
    const r = run(PREVIEW_SCRIPT, [baseSha, ...branches.map((b) => b.head)], { gitDir, scratch });
    if (r.status !== 0) {
      const last = (r.stderr ?? "").split("\n").filter((l) => l.trim()).pop() ?? `exit status ${r.status}`;
      throw new OperatorError(`The landing preview could not run in the image: ${last}`);
    }
    // One line per branch, in order; two branches can share a tip, so never match by sha.
    const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim());
    return branches.map((b, i) => {
      const [, result, ...rest] = (lines[i] ?? "").split("\t");
      if (result === "clean") return { ...b, result, files: [] };
      if (result === "conflict") return { ...b, result, files: [...new Set(rest.filter(Boolean))] };
      return { ...b, result: "error", files: [], detail: rest.join(" ") || "no result from the image" };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export const previewLines = (project: Project, base: string, rows: PreviewRow[]): string[] => {
  if (!rows.length) return ["No unlanded agent/issue-* branches."];
  let at = base;
  try {
    at = `${base} at ${sh("git", ["rev-parse", "--short", `refs/heads/${base}`], project.root)}`;
  } catch {
    // A base that cannot be resolved still gets a preview line.
  }
  const lines = [`Landing preview: ${rows.length} unlanded branch(es) against ${at}, oldest first. Nothing is merged.`];
  // A clean merge that landing would still hold for a person (a protected path, a file over 50 MB)
  // read as "clean", as if it would land.
  const heldFor = (r: PreviewRow) => {
    if (r.result !== "clean") return [];
    try {
      return [...protectedChanges(project, r.branch), ...largeFiles(project, r.branch)];
    } catch {
      return [];
    }
  };
  let held = 0;
  for (const r of rows) {
    const human = heldFor(r);
    if (human.length) held++;
    const label = (human.length ? "held" : { clean: "clean", conflict: "CONFLICT", error: "ERROR" }[r.result]).padEnd(10);
    const files = r.files.length > 5 ? `${r.files.slice(0, 5).join(", ")} and ${r.files.length - 5} more` : r.files.join(", ");
    const tail = human.length ? `: merges cleanly, but needs a human merge - ${human.join(", ")}` : r.result === "conflict" ? `: ${files}` : r.result === "error" ? `: ${r.detail ?? ""}` : "";
    lines.push(`  ${label}${refOf(r.id)}  ${r.branch}${tail}`);
  }
  if (rows.some((r) => r.result === "conflict")) lines.push("A conflicting branch is left out of the merges after it, as landing would leave it out.");
  const count = (n: number, what: string) => (n ? [`${n} ${what}`] : []);
  lines.push(
    `${[
      ...count(rows.filter((r) => r.result === "clean").length - held, "clean"),
      ...count(held, "held for a human merge"),
      ...count(rows.filter((r) => r.result === "conflict").length, "conflicting"),
      ...count(rows.filter((r) => r.result === "error").length, "failed to preview"),
    ].join(", ")}.`,
  );
  return lines;
};

export const dockerRunner =
  (image: string): Runner =>
  (script, args, { gitDir, scratch }) => {
    const r = spawnSync(
      "docker",
      ["run", "--rm", "--network", "none", "-v", `${gitDir}:/repo.git:ro`, "-v", `${scratch}:/objects`, "-e", "REPO_GIT=/repo.git", "-e", "SCRATCH=/objects", "--entrypoint", "sh", image, "-c", script, "sh", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
    );
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
  };
