# sandcastle update - bring the kit and this project up to date

Every step is a check that is safe to repeat, so it does not matter which kit version the project
was set up with. Every change to the project or the user's machine is a **proposal**: show it, and
apply it once the user agrees.

1. **The kit.** Its location is doctor's first line. If `git -C <kit> status --porcelain` shows
   local changes, stop and tell the user - never discard them. Otherwise
   `git -C <kit> pull --ff-only && pnpm -C <kit> install`, then `sandcastle doctor`. This skill is
   a link into the kit, so the pull may have changed it: re-read SKILL.md and this file before going on.
   - If doctor lists `opt  Herdr plugin and sidebar rows`, recommend the kit's Herdr plugin: run
     `sandcastle herdr configure` (outside a terminal it prints what it would add and stops), show
     the user that block, and once they agree run it again with `--yes`. It edits Herdr's own
     config, not the project, so it is theirs to decline.
   - If doctor lists `opt  Claude Code mod` with an `ln -sfn` command, recommend the kit's mod: it
     shows a live run above the prompt, says when a ticket needs the user, and tells the session
     when the run ends. It is code that runs inside Claude Code with the user's permissions (the
     README's "The Claude Code mod" says what it reads), so show them doctor's command and run it
     once they agree.
2. **What changed.** From the project's root, `sandcastle doctor` lists the **Upgrading** notes
   in the kit's `CHANGELOG.md` that this project has not had since its last update (or says it has
   no record, if it was never updated this way: then read the notes of every release since it was
   set up). Read those notes in full: they name what an existing project may act on.
3. **The project** (from its root, if it has `.sandcastle/config.ts`; otherwise skip to 5):
   1. `sandcastle build` - or `sandcastle build --force` when doctor warns that the base image is
      more than 30 days old (it pulls Debian and Node updates) - then `sandcastle lean`: new
      images, and the hook check against them.
      If it refuses the config instead (`unknown key`, `must be ...`: a typo or a wrong type that
      older versions ignored), fix the key it names - it suggests the nearest real one - and run
      it again.
      Fix a `HOOK FAIL` as in init.md step 4. Then `sandcastle gates` (no model calls): a new image
      can turn a gate red or green on base. Fix a red gate as in init.md step 6. It also runs the
      repo's `pre-commit` and `commit-msg` hooks in the sandbox: a refused hook means the tool it
      needs is missing from the image, so add it to `.sandcastle/Dockerfile`, then `sandcastle
      build` and `sandcastle gates` again.
   2. **Config.** Compare `.sandcastle/config.ts` with the README's Configuration table. A field
      it leaves out takes the kit's default, so nothing breaks - but name every new default that
      changes what a run does or spends (the Upgrading notes list them) and ask whether to set it
      explicitly. Edit only the fields the user agrees to, one by one.
   3. **Gates.** Check they still match what CI runs; CI drifts. Run `sandcastle queue`: it names
      the tracker and queue label the kit chose (`docs/agents/` can change either). If that is not
      where this project's tickets live (a repo that moved to `.scratch/` files, or back), set
      `tracker` in the config.
   4. **Blocked tickets recorded the old way.** Earlier triage left blocked tickets with a "blocked
      by" comment, which runs do not read. Run `sandcastle blockers`: it lists open tickets - queued
      or not - whose comment names a blocker the body does not, and marks those whose blockers are
      all closed as stale. For each that is not stale, propose moving the line into the body as
      queue.md's "Writing a ticket body" shows (and, for an unlabelled ticket, adding the queue
      label - only if its spec is otherwise closed). If the project tracks work in Linear or task
      files, check `blockers` in its config covers them.
   5. **Unproven guards.** If `sandcastle lean` warns that `PreToolUse` guards are kept with no
      `hookTests`, propose tests as in init.md step 4, then `sandcastle gates`.
   6. **Ignored paths.** If `.sandcastle/.gitignore` lacks any of `.env`, `logs/`, `worktrees/`,
      `.run/`, `triage/`, append the missing ones (commit it with the other project changes in
      step 4). Without them, files the kit writes show as untracked and a run's clean-tree check
      refuses to start.
   7. **Leftovers.** `git branch --list 'agent/*'` and `git worktree list`: if either holds
      entries no run is using, show them and offer `sandcastle clean` (never `--all` without a
      yes).
   8. **Generated files.** If a gate regenerates committed files (the README's "A gate for
      generated files" recipe, or any gate that runs a build and diffs its output) and `generated`
      is not set in `.sandcastle/config.ts`, propose declaring those paths with the command that
      writes them.
   9. **Gates and the kit's tokens.** Gates run without `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
      `ANTHROPIC_API_KEY`. Run `git grep -nE 'GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY'`
      in the project: if a gate's command or a test it runs reads one, it sees nothing. Propose
      giving that test its own variable in `.sandcastle/.env` (a token scoped to what the test
      needs), then `sandcastle gates`.
   10. **Chains and overlaps.** Run `sandcastle queue --lint` (read-only, no model calls).
       - A `Blocked by` chain of queued tickets drains in one run whatever the autonomy level. If
         the lint shows tickets that share an unmergeable file or are likely to conflict, and
         `autonomy` is unset, suggest `autonomy: "drain"`: it re-runs conflicted tickets, and those
         they release, in further turns and names why it stops. It spends more per
         `sandcastle run`.
       - If queued tickets have no `Touches:` line, say what that costs: a run holds a ticket back
         for a file git cannot merge that another ticket in flight changes, read from each
         ticket's branch and `Touches:` line. A ticket without the line is never held back at the
         start, and holds another back only once its own branch has such a file. Offer to add the lines (queue.md's "Writing a ticket body") to the
         queued tickets the user picks, as an edit to each ticket body.
   11. **Hold label.** The kit holds a ticket for a person with `ready-for-human` (or what
       `docs/agents/triage-labels.md` maps that role to), and still treats the older `needs-human`
       as held. Skip this step if that file maps `ready-for-human` to `needs-human`. Otherwise
       look for open tickets carrying the old one: `gh issue list --state open --label needs-human`
       (GitHub), or `Status: needs-human` under the ticket directory (files). If there are any,
       offer either to move them across (`gh issue edit <n> --add-label ready-for-human
       --remove-label needs-human`, or the `Status:` line), or to keep `needs-human` by mapping
       `ready-for-human` to it in `triage-labels.md`.
   12. **Literal pnpm store mount.** If `.sandcastle/config.ts` has a `mounts` entry whose
       `sandboxPath` is `/home/agent/.pnpm-store` (a host path such as `~/Library/pnpm/store/v11`,
       valid on one OS only), propose replacing it with `pnpmStore: true`, and dropping the
       `pnpm config set store-dir /home/agent/.pnpm-store` line from `setup`: the kit resolves the
       store with `pnpm store path` on the host and adds both. Leave any other mount alone. Then
       `sandcastle gates`.
4. **Record and commit.** Run `sandcastle updated` in the project, so doctor and runs stop
   listing these notes (it writes only `.sandcastle/.run/`, gitignored). Commit any project file
   that changed, by the repo's own rules, and report: kit version before and after, what changed
   for this project, and what the user decided.
5. **Fresh sessions.** The skill is a link into the kit, so the pull updated it for every
   harness, but a session that was already open keeps the skill it loaded at its start (and a mod
   linked in step 1 loads only in a new session). Tell the user to start a new session (Claude
   Code, Codex or OpenCode) before the next `/sandcastle` action, and to run this update once in
   each other project that uses the kit: the kit is shared, the project steps (3) are per project.
