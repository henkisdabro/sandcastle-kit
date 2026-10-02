# sandcastle update - bring the kit and this project up to date

Every step is a check that is safe to repeat, so it does not matter which kit version the project
was set up with.

1. **The kit.** Its location is doctor's first line. If `git -C <kit> status --porcelain` shows
   local changes, stop and tell the user - never discard them. Otherwise
   `git -C <kit> pull --ff-only && pnpm -C <kit> install`, then `sandcastle doctor`. This skill is
   a link into the kit, so the pull may have changed it: re-read SKILL.md and this file before going on.
   If doctor lists `opt  Herdr plugin and sidebar rows`, offer the kit's Herdr plugin: run
   `sandcastle herdr configure` (outside a terminal it prints what it would add and stops), show
   the user that block, and only after they agree run it again with `--yes`. It edits Herdr's own
   config, not the project, so it is theirs to decline.
2. **What changed.** Read the kit's `CHANGELOG.md` - `[Unreleased]` and the releases since the
   last update, if the user knows when that was. Its **Upgrading** notes name what an existing
   project may act on.
3. **The project** (from its root, if it has `.sandcastle/config.ts`; otherwise stop after 2):
   1. `sandcastle build` - or `sandcastle build --force` when doctor warns that the base image is
      more than 30 days old (it pulls Debian and Node updates) - then `sandcastle lean`: new
      images, and the hook check against them.
      If it refuses the config instead (`unknown key`, `must be ...`: a typo or a wrong type that
      older versions ignored), fix the key it names - it suggests the nearest real one - with
      the user's agreement, and run it again.
      Fix a `HOOK FAIL` as in SKILL.md's init step 4. Then `sandcastle gates` (no model calls): a new image
      can turn a gate red or green on base. Fix a red gate as in SKILL.md's init step 6.
   2. **Config.** Compare `.sandcastle/config.ts` with the README's Configuration table. A field
      it leaves out takes the kit's default, so nothing breaks - but name every new default that
      changes what a run does or spends (the Upgrading notes list them) and ask whether to set it
      explicitly. Edit only what the user agrees to; never rewrite the config wholesale.
   3. **Gates.** Check they still match what CI runs; CI drifts. Run `sandcastle queue`: it names
      the tracker and queue label the kit chose (`docs/agents/` can change either). If that is not where this project's tickets live (a repo that
      moved to `.scratch/` files, or back), set `tracker` in the config.
   4. **Blocked issues recorded the old way.** Earlier triage left blocked issues with a "blocked
      by" comment, which runs do not read. Run `sandcastle blockers`: it lists open tickets - queued
      or not - whose comment names a blocker the body does not, and marks those whose blockers are
      all closed as stale. For each that is not stale, propose moving the line into the body as `Blocked by ...`
      (and, for an unlabelled issue, adding the queue label - only if its spec is otherwise closed,
      see queue). If the project tracks work in Linear or task files, check `blockers` in its
      config covers them. Apply after the user agrees.
   5. **Unproven guards.** If `sandcastle lean` warns that `PreToolUse` guards are kept with no
      `hookTests`, propose tests as in SKILL.md's init step 4, then `sandcastle gates`.
   6. **Triage directory.** If `.sandcastle/.gitignore` has no `triage/` line, append it (commit
      it with the other project changes in step 4). Without it, triage files show as untracked and
      a run's clean-tree check refuses to start.
   7. **Leftovers.** `git branch --list 'agent/*'` and `git worktree list`: if either holds
      entries no run is using, show them and offer `sandcastle clean` (never `--all` without a
      yes).
   8. **Generated files.** If a gate regenerates committed files (the README's "A gate for
      generated files" recipe, or any gate that runs a build and diffs its output) and `generated`
      is not set in `.sandcastle/config.ts`, propose declaring those paths with the command that
      writes them. Apply after the user agrees.
   9. **Gates and the kit's tokens.** Gates run without `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
      `ANTHROPIC_API_KEY`. Run `git grep -nE 'GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY'`
      in the project: if a gate's command or a test it runs reads one, it now sees nothing. Propose
      giving that test its own variable in `.sandcastle/.env` (a token scoped to what the test
      needs), and run `sandcastle gates` after the user agrees.
4. **Commit** any project file that changed, by the repo's own rules, and report: kit version
   before and after, what changed for this project, and what the user decided.
