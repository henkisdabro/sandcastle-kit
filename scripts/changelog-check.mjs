// A pull request that changes what users run must add to CHANGELOG.md's Unreleased section, or carry
// the `no-changelog` label (the workflow skips this script then). AGENTS.md asks for the line; until
// this check it was a habit, and a release found the gaps by reading `git log` against the changelog.
import { execFileSync } from 'node:child_process';

const base = process.argv[2];
if (!base) throw new Error('Use: node scripts/changelog-check.mjs <base-ref>');

// What reaches a user's machine or a sandbox. Tests, docs, the site and CI change nothing a user runs.
const shipped = /^(bin|src|prompts|skill|container|docker|herdr|mod|templates)\/|^status\.sh$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const from = git('merge-base', base, 'HEAD').trim();
const changed = git('diff', '--name-only', from, 'HEAD').split('\n').filter((path) => shipped.test(path));
if (!changed.length) process.exit(0);

// A release moves the section's lines under a version heading, which changes it too.
const unreleased = (ref) => {
  const text = git('show', `${ref}:CHANGELOG.md`);
  const start = text.indexOf('## [Unreleased]');
  if (start < 0) throw new Error(`CHANGELOG.md at ${ref} has no ## [Unreleased] heading`);
  const end = text.indexOf('\n## [', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
if (unreleased(from) !== unreleased('HEAD')) process.exit(0);

console.error(
  `CHANGELOG.md: this pull request changes shipped files but adds nothing under ## [Unreleased]:\n` +
    changed.map((path) => `  ${path}\n`).join('') +
    `Add a line there, or label the pull request no-changelog if nobody outside the code would notice.`,
);
process.exitCode = 1;
