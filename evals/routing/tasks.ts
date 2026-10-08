// The eval's tasks: tickets this repository's own runs landed, each replayed from the commit its
// branch was cut from. Built from git and the tracker, then curated by hand in tasks.json.
//
// A hidden test that imports a function the ticket never names would fail a correct change that
// chose another name, so every export the hidden tests need and the base lacks is written into the
// ticket as a `## Seams` section - the shape the kit's own ticket rules ask for (skill/queue.md).
// `probes`, `history`, `pilot`, `drop` and `note` are curated by hand and survive a rebuild.
// All arms get the same ticket, so the hint costs no comparison its fairness.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const TASKS_FILE = join(REPO, "evals/routing/tasks.json");

/**
 * A later fix's test for a bug the historical branch shipped: a stronger arm may not ship it.
 * `overlay` is every test/ file that fix changed, helpers included, copied in before `tests` run.
 */
export type Probe = { commit: string; tests: string[]; overlay: string[]; bug: string };

export type Task = {
  issue: number;
  title: string;
  merge: string;
  /** Where the branch was cut: what a trial starts from. */
  base: string;
  /** The historical branch tip: the reference solution. */
  ref: string;
  files: number;
  lines: number;
  /** test/ files the reference added or changed, copied over a candidate before grading. */
  overlay: string[];
  /** The overlay's runnable tests: all must pass for a trial to count as resolved. */
  hidden: string[];
  /** Hidden tests that read source text rather than behaviour: name-coupled, so a failure there is read by hand. */
  sourceReading: string[];
  ticket: { body: string; comments: string[]; seams: string[] };
  probes?: Probe[];
  /** How the ticket went when it landed: what an arm is measured against besides the reference's tests. */
  history?: History;
  /** In the first, smaller round of trials. */
  pilot?: boolean;
  drop?: string;
  note?: string;
};

export type History = {
  kind: string;
  /** S under 120 changed lines, M under 300, L above. */
  size: "S" | "M" | "L";
  /** H: the body has where, fix, Done when and Touches; M: where and fix; L: a paragraph. */
  clarity: "H" | "M" | "L";
  implement: string;
  implementUSD: number;
  reviewUSD: number;
  implementMinutes: number;
  /** The reviewer's own tests against the implementer's last commit: "caught" is a defect the review fixed. */
  implAlone: "caught" | "passes" | "no test change" | "no review commit";
  laterBug?: string;
};

const git = (...args: string[]) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const gitOr = (fallback: string, ...args: string[]) => {
  try {
    return git(...args);
  } catch {
    return fallback;
  }
};

const slug = () => {
  const url = git("remote", "get-url", "origin");
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!m) throw new Error(`origin (${url}) is not a GitHub repository`);
  return m[1];
};

const mergeOf = (issue: number) => {
  const line = git("log", "--merges", "--format=%H %P %s", "origin/main")
    .split("\n")
    .find((l) => new RegExp(`^\\S+ \\S+ \\S+ Merge agent/issue-${issue}\\b`).test(l));
  if (!line) return undefined;
  const [merge, main, branch] = line.split(" ");
  return { merge, base: git("merge-base", main, branch), ref: branch };
};

// Named imports a test takes from the code under test: `import { a, b } from "../src/x.ts"` and
// `const { a, b } = await import("../src/x.ts")`.
const importsOf = (text: string) => {
  const out: { file: string; names: string[] }[] = [];
  const re = /(?:import\s*(?:type\s*)?\{([^}]+)\}\s*from|const\s*\{([^}]+)\}\s*=\s*await\s+import\s*\()\s*["']\.\.\/((?:src|mod)\/[^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const names = (m[1] ?? m[2])
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*/)[0])
      .filter(Boolean);
    out.push({ file: m[3], names });
  }
  return out;
};

const exported = (source: string, name: string) =>
  new RegExp(`export\\s+(?:async\\s+)?(?:const|let|function\\*?|class|type|interface)\\s+${name}\\b`).test(source) ||
  new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b`).test(source);

// A declaration's name, parameters and return type, never its body: a one-line function is its own answer.
export const shapeOf = (line: string) => {
  const s = line.trim();
  if (/^export\s+(?:type|interface)\b/.test(s)) return s;
  const open = s.indexOf("(");
  if (open < 0) return s.split("=")[0].trim();
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(0, i + 1) + (s.slice(i + 1).match(/^\s*(:\s*.+?)?\s*(?:=>|\{\s*$)/)?.[1] ?? "");
  }
  return s.replace(/\s*[={]\s*$/, "");
};

const seamsOf = (base: string, ref: string, hidden: string[]) => {
  const lines = new Set<string>();
  for (const test of hidden) {
    for (const { file, names } of importsOf(git("show", `${ref}:${test}`))) {
      const before = gitOr("", "show", `${base}:${file}`);
      const after = gitOr("", "show", `${ref}:${file}`);
      for (const name of names) {
        if (exported(before, name)) continue;
        const sig = after.split("\n").find((l) => exported(l, name));
        lines.add(`- \`${name}\` exported from \`${file}\`${before ? "" : " (a new file)"}${sig ? `: \`${shapeOf(sig).slice(0, 240)}\`` : ""}`);
      }
    }
  }
  return [...lines];
};

const ticketOf = (repo: string, issue: number, before: string) => {
  const raw = JSON.parse(execFileSync("gh", ["issue", "view", String(issue), "--repo", repo, "--json", "title,body,comments"], { encoding: "utf8" })) as {
    title: string;
    body: string;
    comments: { body: string; createdAt: string }[];
  };
  // A body line naming a GitHub blocker would hold a ticket-file run waiting for a tracker it cannot read.
  const body = raw.body
    .split("\n")
    .filter((l) => !/^\s*blocked by\b/i.test(l))
    .join("\n")
    .trim();
  // Only what the implementer could have read: comments from before the branch's first commit. An
  // agent reports on the ticket after its commits, and that report describes the solution.
  const comments = raw.comments.filter((c) => c.createdAt < before && !/agent\/issue-\d/.test(c.body)).map((c) => c.body.trim());
  return { title: raw.title, body, comments };
};

export const loadTasks = (): Task[] => (existsSync(TASKS_FILE) ? (JSON.parse(readFileSync(TASKS_FILE, "utf8")) as Task[]) : []);

export const buildTasks = (issues: number[]) => {
  const repo = slug();
  const kept = new Map(loadTasks().map((t) => [t.issue, t]));
  const out: Task[] = [];
  for (const issue of issues) {
    const m = mergeOf(issue);
    if (!m) {
      console.log(`#${issue}: no "Merge agent/issue-${issue}" on origin/main - landed by hand or not at all; skipped`);
      continue;
    }
    const changed = git("diff", "--no-renames", "--name-status", m.base, m.ref)
      .split("\n")
      .map((l) => l.split("\t"))
      .filter(([status]) => status !== "D");
    const overlay = changed.map(([, path]) => path).filter((p) => p.startsWith("test/"));
    const hidden = overlay.filter((p) => /\.test\.(ts|sh)$/.test(p));
    const sourceReading = hidden.filter((p) => /readFileSync\([^)]*(src|status\.sh|prompts)/.test(git("show", `${m.ref}:${p}`)));
    const stat = git("diff", "--shortstat", m.base, m.ref);
    const count = (word: string) => Number(stat.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    const first = git("log", "--reverse", "--format=%aI", `${m.base}..${m.ref}`).split("\n")[0];
    const ticket = ticketOf(repo, issue, new Date(first).toISOString());
    const old = kept.get(issue);
    out.push({
      issue,
      title: ticket.title,
      ...m,
      files: changed.length,
      lines: count("insertion") + count("deletion"),
      overlay,
      hidden,
      sourceReading,
      ticket: { body: ticket.body, comments: ticket.comments, seams: seamsOf(m.base, m.ref, hidden) },
      ...(old?.probes ? { probes: old.probes } : {}),
      ...(old?.history ? { history: old.history } : {}),
      ...(old?.pilot ? { pilot: old.pilot } : {}),
      ...(old?.drop ? { drop: old.drop } : {}),
      ...(old?.note ? { note: old.note } : {}),
    });
    console.log(`#${issue}: base ${m.base.slice(0, 7)}, ${changed.length} files, ${hidden.length} hidden tests, ${out.at(-1)!.ticket.seams.length} seams`);
  }
  writeFileSync(TASKS_FILE, JSON.stringify(out, null, 2) + "\n");
  return out;
};

/** The ticket file a trial's run reads: the body, the seams, the triage comments under `## Comments` (the files tracker's split). */
export const ticketFile = (t: Task) =>
  [
    `# ${t.title}`,
    "",
    "Status: ready-for-agent",
    "",
    t.ticket.body,
    ...(t.ticket.seams.length ? ["", "## Seams", "", "The acceptance tests call these; keep the names and shapes:", "", ...t.ticket.seams] : []),
    ...(t.ticket.comments.length ? ["", "## Comments", "", ...t.ticket.comments.flatMap((c) => [c, ""])] : []),
    "",
  ].join("\n");
