// The check behind test/changelog-released.test.ts, over any repository, so a test can run it
// against a throwaway one: a released version's CHANGELOG.md section must still equal that
// section in its tag. Plain `git` through execFileSync, nothing else.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

// Whether `dir` is the top of a git work tree: a copy of the files without `.git` may sit inside
// some other repository (a temp directory under a checked-out home), and that one's tags are not ours.
export const isWorkTreeRoot = (dir: string): boolean => {
  try {
    return realpathSync(git(dir, "rev-parse", "--show-toplevel").trim()) === realpathSync(dir);
  } catch {
    return false;
  }
};

export const releaseTags = (dir: string): string[] =>
  git(dir, "tag", "--list", "v*").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

// The lines of the `## [version]` section: its heading to the next `## [` heading or to the link
// references at the end of the file (v0.1.0's section runs into them), trailing blank lines left out.
// Null when the text has no such section.
export const sectionOf = (changelog: string, version: string): string[] | null => {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## [") && !/^\[[^\]]+\]: /.test(lines[end])) end++;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
};

// One problem per released version whose section in `file` differs from its tag's, naming the
// version and the first differing line. Empty when every one matches.
export const releasedSectionProblems = (dir: string, file: string, current: string): string[] => {
  const problems: string[] = [];
  for (const tag of releaseTags(dir)) {
    const version = tag.slice(1);
    let tagged: string;
    try {
      tagged = git(dir, "show", `${tag}:${file}`);
    } catch {
      problems.push(`${version}: ${tag} has no ${file}`);
      continue;
    }
    const was = sectionOf(tagged, version);
    const now = sectionOf(current, version);
    if (!was) {
      problems.push(`${version}: ${tag}'s ${file} has no "## [${version}]" section`);
      continue;
    }
    if (!now) {
      problems.push(`${version}: ${file} has no "## [${version}]" section, but ${tag} does`);
      continue;
    }
    const at = was.findIndex((l, i) => l !== now[i]);
    const first = at !== -1 ? at : was.length < now.length ? was.length : -1;
    if (first === -1) continue;
    problems.push(
      `${version}: line ${first + 1} of its section differs from ${tag}\n` +
        `    ${tag}:  ${JSON.stringify(was[first] ?? "(section ends)")}\n` +
        `    now:     ${JSON.stringify(now[first] ?? "(section ends)")}`,
    );
  }
  return problems;
};
