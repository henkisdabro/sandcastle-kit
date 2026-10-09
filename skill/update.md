# sandcastle update - bring the kit and this project up to date

Every step is a check that is safe to repeat, so it does not matter which kit version the project
was set up with. Every change to the project or the user's machine is a **proposal**: show it, and
apply it once the user agrees.

1. **The kit.** Its location is doctor's first line. If `git -C <kit> status --porcelain` shows
   local changes, stop and tell the user - never discard them. Then run `sandcastle doctor` and
   look for its `warn  N sandcastle run(s) live on this machine` block before pulling: a live run
   keeps its code loaded but reads the kit's `prompts/`, `container/` and `status.sh` from disk, so
   a pull changes what its later tickets are built from. If it lists runs, ask the user to wait for
   them (`sandcastle wait` in each project) or to confirm the pull anyway, and go no further until
   they answer. Otherwise
   `git -C <kit> pull --ff-only && pnpm -C <kit> install`, then `sandcastle doctor`. This skill is
   a link into the kit, so the pull may have changed it: re-read SKILL.md and this file before going on.
   - If `sandcastle` stops with `cannot run the kit's TypeScript`, the user's Node is older than
     22.18 (or has type stripping turned off in `NODE_OPTIONS`). Tell them, propose Node 24 LTS
     through whatever installed their Node (doctor's FIX names the usual ones), and go on once
     `sandcastle doctor` runs.
   - If doctor lists `opt  Herdr plugin and sidebar rows`, recommend the kit's Herdr plugin: run
     `sandcastle herdr configure` (outside a terminal it prints what it would add and stops), show
     the user that block, and once they agree run it again with `--yes`. It edits Herdr's own
     config, not the project, so it is theirs to decline.
   - If doctor lists the Herdr plugin as `ok` but `${XDG_CACHE_HOME:-~/.cache}/sandcastle-kit/herdr-plugin-linked`
     does not exist (the plugin was linked by an older kit), run `sandcastle herdr configure --yes`
     once: it leaves that file, without which the status view shows no ticket links or Ctrl-click
     hint. It replaces its own block, so running it again is safe.
   - If the plugin is linked (doctor lists it `ok`) but the sandcastle block in Herdr's config names
     no `$sc_usage` row (`grep -c sc_usage` on the file `herdr --help` names after `Config:`
     finds none: the block was written by an older kit), run `sandcastle herdr configure --yes`
     once: it replaces its own block, and the sidebar then shows the plan's usage under a run. It is
     optional, and the block is replaced either way, so running it again is safe.
   - If doctor lists `opt  Claude Code mod` with an `ln -sfn` command, recommend the kit's mod: it
     shows a live run above the prompt, says when a ticket needs the user, and tells the session
     when the run ends. It is code that runs inside Claude Code with the user's permissions (the
     README's "The Claude Code mod" says what it reads), so show them doctor's command and run it
     once they agree.
2. **What's new.** From the project's root, run `sandcastle changes` (read-only, no model calls): the
   CHANGELOG entries of every release since this project's last recorded update, up to the kit's
   own, each cut to its bold lead. With no record it prints only the current release's entries and
   says so: ask which release the project was set up with and run `sandcastle changes --since
   <release>`. After the entries it lists the config keys, environment variables, commands and
   flags added, removed or changed between the two releases' git tags (or says a tag is missing).
   `sandcastle doctor` also lists the **Upgrading** notes the project has not had.
   Sort the entries into three tiers and tell the user in this order, leaving out a tier with
   nothing in it:
   1. **Must act.** The **Upgrading** notes, in full from the kit's `CHANGELOG.md` (`sandcastle
      changes` and doctor print only each note's bold lead): they name what an existing project
      has to do. The steps below carry them out, each as a proposal.
   2. **Decisions.** A new setting, or a new default that changes what a run does or spends, that
      the user may want to change (an `Added` or `Changed` entry; the Upgrading notes name some).
      Ask about them one by one, each with a recommendation and why, through the harness's question
      tool (`AskUserQuestion` in Claude Code) where it has one. Never apply one unasked, and ask
      about a choice once: a project config field is edited only in step 3.2, after the user's
      yes, and autonomy comes up in step 3.10.
   3. **Good to know.** Every other entry, one line each: what it does for the user, in plain
      words. No question, no action.
3. **The project** (from its root, if it has `.sandcastle/config.ts`; otherwise skip to 5):
   Every `sandcastle gates` below refuses while a run of the project is live (it never waits): run
   `sandcastle status 0` first, and if a run is live, wait for it with `sandcastle wait` (or
   come back to the gates step once it has ended).
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
      build` and `sandcastle gates` again. If the project had no Dockerfile until now, also add
      `dockerfile: ".sandcastle/Dockerfile"` to `.sandcastle/config.ts`: without the key the file is
      never built (`sandcastle build` says "Not built").
   2. **Config.** Compare `.sandcastle/config.ts` with the README's Configuration table. A field
      it leaves out takes the kit's default, so nothing breaks - but name every new default that
      changes what a run does or spends (step 2's decisions and Upgrading notes list them) and ask
      whether to set it explicitly. Edit only the fields the user agrees to, one by one.
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
       valid on one OS only, and a versioned directory, so the sandbox's pnpm nests a second
       `v11` store inside the host's), propose replacing it with `pnpmStore: true`, and dropping the
       `pnpm config set store-dir /home/agent/.pnpm-store` line from `setup`: the kit resolves the
       host's store-dir with `pnpm store path` and adds both. Leave any other mount alone. Then
       `sandcastle gates`.
   13. **API credits.** If `sandcastle doctor`, from the project's root, prints a `warn API
       credits` line, an `ANTHROPIC_API_KEY` reaches this project's sandboxes, and Claude Code
       spends it before any `CLAUDE_CODE_OAUTH_TOKEN`: runs bill API credits. Tell the user, naming
       the file the line names; that every run now asks first, and that a run with no terminal
       (`--detach`, a script) refuses without `--api-key` (or
       `SANDCASTLE_API_KEY=1`). If they meant to spend their subscription, propose removing the key
       from that file; add `--api-key` to anything that starts runs only on their explicit yes to
       billing API credits.
   14. **Upgrading lines.** If `.sandcastle/config.ts` sets `changelog: true` and the project's
       rules file names `Added:`, `Changed:` or `Fixed:` but not `Upgrading:`, propose adding a
       sentence there: a change an existing project must act on gets a line starting `Upgrading:`.
       Without it, agents following those rules never suggest one.
   15. **Config syntax Node cannot strip.** If `sandcastle gates` (or any command) says
       `.sandcastle/config.ts does not load` and names an `enum`, a `namespace` or a parameter
       property, propose replacing it: an object of constants for an enum, a plain field for a
       parameter property. Node runs the config with type annotations removed and nothing else.
   16. **Refused mount.** If `sandcastle doctor`, from the project's root, prints a FIX for
       `.sandcastle/config.ts mounts stay out of the run's own state`, a `mounts` entry reaches the
       project root, `.sandcastle/` or `.git`, and the config no longer loads. Tell the user which
       entry the line names, and propose removing it or pointing it at a directory elsewhere (a
       cache directory under the project is fine). Then `sandcastle gates`.
4. **Record and commit.** Run `sandcastle updated` in the project, so doctor and runs stop
   listing these notes (it writes only `.sandcastle/.run/`, gitignored). Commit any project file
   that changed, by the repo's own rules, and report: kit version before and after, what changed
   for this project, and what the user decided.
5. **Fresh sessions.** The skill is a link into the kit, so the pull updated it for every
   harness, but a session that was already open keeps the skill it loaded at its start (and a mod
   linked in step 1 loads only in a new session). Tell the user to start a new session (Claude
   Code, Codex or OpenCode) before the next `/sandcastle` action, and to run this update once in
   each other project that uses the kit: the kit is shared, the project steps (3) are per project.
