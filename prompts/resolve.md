You are finishing a merge on branch `{{SOURCE_BRANCH}}` for ticket {{TICKET}}. The branch's work was
implemented, reviewed and gated green in an earlier run, and it did not land because
`{{TARGET_BRANCH}}` moved on. The orchestrator merged `{{TARGET_BRANCH}}` into the branch and the
merge conflicts. Resolving that merge is the whole job. Nobody will answer a question for you.

{{KIT_DRY_RUN}}**Your `.git` is shared with other agents working at the same moment. Never run `git worktree
prune`, `git worktree repair`, `git gc` or `git prune`**, and never edit anything under `.git/`
by hand. From inside this container no other agent's worktree path exists, so a prune deletes
their records mid-run. If git ever tells you this worktree is not a git repository, stop and output
`<promise>COMPLETE</promise>` - do not rebuild it.

**Never `git stash` in this worktree:** the stash list lives in the shared `.git`. Never `pgrep -f` or
`pkill -f` a pattern that also appears in your own command line: it matches your own shell and kills it.
Every test file you run by hand gets a limit, `timeout 300 <command>`: a test that fails can leave
something pending, and the run then never exits. A script fed to an interpreter through a heredoc takes
a delimiter the file it edits cannot contain (`<<'PYEOF'`, not `<<'EOF'`): an `EOF` line in that file
ends the heredoc early and runs the rest as shell. Text that names a git command the guard refuses
(`git push`, deleting an agent branch) - in a heredoc, a script or a commit message - goes through the Edit
or Write tool or a file, never on a shell command line: the guard matches the whole command string, so it
refuses the quoting like the command.

# The conflicted files

!`git diff --name-only --diff-filter=U`

# What this branch changed (already reviewed)

!`git log {{TARGET_BRANCH}}..HEAD --no-merges --format='%h %s'`

# Rules

- **Keep both sides' intent.** `{{TARGET_BRANCH}}`'s side is merged work, not yours to undo.
- **Change nothing beyond resolving the merge.** No refactor, no new behaviour, nothing the ticket
  did not already do. The one exception is a file git merged *without* a conflict that the merge
  itself breaks: a test the base just added that pins the sentence this branch replaced, a call that
  needs the field this branch added to a code path the base added. Change such a file only as far as
  the merge needs, never to take one side whole, and name it (see "Finishing").
- **Make every change inside the merge commit and commit nothing else.** Resolve the files, run the
  typecheck gate and the tests that cover them (see "Gates"), `git add` the files, then
  `git commit --no-edit`.
- Never delete, skip or weaken a test, an assertion or a guard to get green.

{{KIT_PROJECT_RULES}}

# Gates

These are the project's gates. The orchestrator gates the merge commit after you exit, all of them,
the full suite included, so do not run the full suite yourself:

```
{{KIT_GATES}}
```

Run only the typecheck gate (the gate above that type-checks or builds, if there is one) and the test
files that cover the conflicted files, and make them pass. A conflict in a README or another document
that no test file covers needs the typecheck gate alone.

Run each gate in the foreground with the tool's longest timeout (`timeout: 600000` in Claude Code,
whose 2-minute default moves a longer suite to the background) and its output in a file outside the
worktree; never wait on a backgrounded run with `sleep`, `pgrep` or Monitor, and never run the suite
to time it.

A long command that is not a gate - a download, an install, a build - also runs in the foreground
with the tool's longest timeout, never in the background. If one is in the background anyway, wait for
it with a single foreground command that has its own limit, `timeout 600 bash -c 'until <check>; do sleep 5; done'`,
where `<check>` tests a file or a port, never `pgrep -f`. A bare `sleep` is blocked and Monitor is not
available here.

# Finishing

For each file git merged without a conflict that you changed, put one line of its own in your final
message, with the path as it appears in `git status` and the reason in a sentence:

<stray path="test/example.test.ts">the base's new assertion pinned the old sentence this branch replaces</stray>

The kit compares your merge with git's own and holds the ticket for a person if it finds a changed
file you did not name here. A named file goes on to the review and the gates, where the reviewer is
shown your reason. Write no such line when you changed only the conflicted files.

If the merge is resolved, the typecheck gate and the covering tests pass and the merge is committed, output
`<promise>COMPLETE</promise>`.

If it cannot be resolved without changing what the ticket does, leave the merge in progress (do not
abort it, do not commit) and output `<promise>COMPLETE</promise>`: the orchestrator then hands the
branch to the full implementer.
