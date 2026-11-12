# 🔒 Safety model

What an unattended agent can and cannot reach, and what holds a branch for a person.


Agents run unattended with permission prompts off, inside Docker, as a plain user without raw
sockets (`NET_RAW` dropped). The container is the boundary, and the kit narrows what can cross it:

- 🔑 **Tokens.** Only a fine-grained GitHub token (issues and metadata on chosen repos) enters the
  sandbox. It cannot push, edit workflows or change settings (`sandcastle doctor --verify` checks it
  cannot push, and that it can see the repository: a fine-grained token whose Repository access
  leaves the repo out gets a FIX there, and `sandcastle run` refuses the same way before any sandbox
  starts). Empty values are refused so a host `ANTHROPIC_API_KEY` cannot leak in. Gates run
  without the kit's tokens, and a token value in gate output is replaced with `<redacted>`. So is
  a token of Codex's login (`~/.codex/auth.json`, mounted read-only when `CROSS_REVIEW=1`) in the
  output a crashed agent's log and crash note show.
- 📜 **Tickets grant no permissions.** The prompts tell agents that a ticket's instructions to touch
  `.git/`, credentials, push or open a pull request are not the work; the guards below hold if an
  agent follows them anyway.
- 💬 **Public repositories.** On a public repository anyone with a GitHub account can comment on a
  queued ticket, and an agent reads the thread with a token in its environment. So the comments in
  an agent's prompt are filtered: only an owner's, a member's or a collaborator's comment, and the
  ticket author's, are shown, and the last line says how many were left out (bots such as
  `github-actions[bot]` included) and that they are untrusted, not to be fetched or acted on.
  Every repository is filtered the same way, private ones too.
  The "blocked by" warnings that comments raise at a run's start and in `sandcastle blockers` read
  the same accounts' comments only.
  The run counts the same accounts when it asks whether a person commented on a carried branch's
  ticket since its review: an outsider's comment never forces a full review. A comment that opens
  with `Sandcastle agent:` is skipped as the agent's own only when the account `GH_TOKEN` belongs to
  wrote it (read once per run with `gh api user`; when that fails the run says so and counts such a
  comment as a person's). The ticket's own body is not filtered: **queueing an outsider's issue
  trusts its body**, so read an issue from a stranger before you label it. What the author writes
  after you label it is held for you: a queued GitHub ticket whose author is not an owner, member
  or collaborator is held (the hold label, as any held ticket, listed under Needs you) when its
  body or title, or one of the author's comments, was written, edited or renamed after the queue
  label was last added (the title reaches every agent pass in `gh issue view`). Only the author's own writing counts; a maintainer's edit of it does not. Read the
  change, then `sandcastle requeue <n>` accepts it: the queue label goes back on, which is a new
  label time. A ticket named on the command line that never carried the label is measured from
  the run's start. The check runs when a ticket's pipeline starts, a carried branch's and a second
  attempt's included, and not again: **an edit made while its agents run is not caught**. A read
  that fails does not hold the ticket; it is not started that turn and stays queued, with a line
  saying why.
- 🪝 **Host git hooks off.** Sandcastle mounts the project's `.git` into every container. During a
  run the host's own git calls ignore hooks, so a branch that adds `.husky/post-merge` does not
  run it on your machine when it lands.
- 🔏 **Read-only git control files.** Sandcastle mounts `.git/config`, `.git/hooks/`, `.git/info/`,
  the sandbox worktree's `.git` file and its record's `commondir` read-only in every container, and
  creates `.git/hooks/` and `.git/info/` on your machine when they are missing, to mount them (the
  kit reads an empty `.git/hooks/` as none).
  So in a sandbox `git config` without `--global` fails, and a setup step that installs hooks or
  writes repo config (`husky`, `pre-commit install`, `lefthook install`, `git lfs install --local`)
  installs nothing there: install hooks on your machine only.
  It is not a guarantee: a rewrite of `.git/config` on your machine by rename may detach the mount
  in a running container, so the fingerprint below stays the guard.
  Sandcastle's own git on your machine also runs with the repository's filters, drivers, hooks and
  remote helpers turned off; the kit's pins below hold beside it.
- 📌 **Command-running config pinned.** For the run's own git calls, `core.fsmonitor` and commit
  signing are off, and every filter, merge or diff driver, pager, editor and signing program
  configured when the run starts keeps that value, through git's command-scope config. A value a
  sandbox writes into `.git/config` mid-run is never the one the host's git runs.
- 📋 **Start baseline.** The pins and the fingerprint take the shared `.git` as they find it when a
  run starts, so a filter or a hook a sandbox planted in a run that was killed before any check
  (Ctrl-C at the wrong moment, a crash, a machine asleep) would become the next run's baseline and
  never be reported.
  So `sandcastle run`, `land`, `gates` and `clean` record what makes git run a program or reach the
  network in `.sandcastle/.run/git-config-baseline.json`, when they start and again when they end
  cleanly (a `gates` or `land` that ends red after its `.git` check passed ends cleanly too):
  - in `.git/config` and in the main worktree's `.git/config.worktree` (present or absent), every
    `filter.*`, `merge.*.driver`, `diff.*.textconv` and `.command`, `diff.external`,
    `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`,
    `core.askPass`, `core.gitProxy`, `sequence.editor`, `gpg.program` and `gpg.*.program`, and
    `include*` key;
  - what your own later git command runs: every `alias.*` (a repo-local alias overrides yours),
    `pager.*`, `difftool.*.cmd`, `mergetool.*.cmd`, `submodule.*.update`, `interactive.diffFilter`,
    `gpg.ssh.defaultKeyCommand`, `core.alternateRefsCommand` and `lfs.*`;
  - what a `git fetch` reads there (your own next fetch runs it on your machine): `remote.*.url`,
    `.pushurl`, `.uploadpack`, `.receivepack` and `.proxy`, `url.*.insteadOf` and `.pushInsteadOf`,
    every `credential.*` and `protocol.*` key, and
    `http.proxy`, `http.sslCAInfo` and `http.sslCAPath`, with or without a URL;
  - `merge.verifySignatures` and `log.showSignature`, which run the signing program, and every
    `extensions.*` key;
  - the hash of `.git/info/attributes`, and of every file under `.git/hooks/` (the kit's git
    ignores hooks, but your next commit runs them) and `.git/modules/` (but for the objects, refs
    and logs a submodule's own use rewrites), by name, content and, for a regular file, executable
    bit (git runs a hook only while it is executable, so `chmod +x` on a disabled hook with the same
    content is a difference, in the fingerprint during a run and in this record at the next start).

  `branch.*` and `remote.*.fetch` stay free: your own work in another worktree changes them, and
  they run nothing.
  Before anything is pinned, the next start compares the present state with that record and refuses
  a difference, naming each added, changed or removed key (no value for a key that runs a program or
  carries credentials) and file, and whether the last run ended cleanly.
  Remove what is not yours; if it is your own (a filter, a driver or a hook you added since the last
  run), start again with `sandcastle run --accept-git-config` (or `land`, `gates` or `clean` with
  it), which records the present state as the new baseline.
  A start after a run that ended **cleanly** takes a narrow class of changes without the flag, since
  nothing a sandbox ran can have written them, and your own tools make them all the time: a **new
  remote** whose URL is plain https or ssh (`git remote add`, the fork remote `gh pr create` adds;
  no credentials in the URL, no `http://`, `file:`, `ext::`), `core.hooksPath` set to an existing
  directory in a **tracked directory of the repo** (husky's `.husky/_`, which its own `.gitignore`
  hides, counts as the tracked `.husky/`), and a **hook file a hook manager writes** (lefthook,
  pre-commit, husky 4: a script directly under `.git/hooks/` that carries the tool's marker).
  It prints one line for each change it took
  (`Took as your own, since the last run ended cleanly - ...`) and records the new baseline.
  Everything else is still refused, and a refusal that has one such change beside others refuses all
  of them: a filter, a driver, a transport command, `insteadOf`, a changed URL on an existing remote
  (`origin` included), a removed remote, a remote's `pushurl`, `proxy` or program, a hooks path
  anywhere else, `info/attributes`, and any other hook.
  After an unclean end (killed, stopped) every change is refused, as before.
  Each refusal says whether the last run ended cleanly, and marks a change that looks like your own
  tooling (`looks like your own tooling: ...`) apart from the rest.
  With no record - the first run under this kit - the first of those four commands to start records
  and goes on, `sandcastle gates` included.
  The same for a record an earlier kit version left (the record is versioned): the first start after
  an update takes the present state again, once, and prints a line saying so, rather than naming
  every alias or pager key as added - unless that earlier run did not end cleanly: then what the
  older record holds is compared as usual (the keys it never listed left out), since a sandbox may
  have written the difference.
  A run killed with all of it unchanged starts again with no question.
  With `worktree.useRelativePaths` on, git writes `extensions.relativeWorktrees` the first time it
  adds a worktree, after the record was taken, so the next start names that key once.
- 🧬 **`.git` fingerprint.** `.git/config`, `.git/HEAD`, `.git/info/` (except `info/refs` and
  `info/exclude`: ignore patterns and a transport index run nothing, and your own tools, Claude Code
  among them, rewrite them while a run is live), `.git/hooks/`, the main worktree's
  `.git/config.worktree` (which git reads once `extensions.worktreeConfig` is on: created, changed
  or removed, it stops the run, naming its keys) and the base branch are fingerprinted; if a sandbox
  changes them, the run stops before the host runs another git command there, naming the file.
  A hook planted there would otherwise run on your next checkout or commit, and so would a disabled
  one made executable (`chmod +x`), so the executable bit of a hook is fingerprinted beside its
  content.
  `.git/modules/` (the git directories of submodules) is fingerprinted too, since a config a sandbox
  adds there would run on a `git status` that looks into a submodule.
  The records of worktrees you made by hand beside a run (`.git/worktrees/<name>/`: `commondir`,
  `gitdir` and `config.worktree`, present or absent, and their content) are watched as they stand at
  the start: one that changes stops the run, naming it, since your next git command in that worktree
  would read config no check has seen.
  A record added mid-run passes only as `git worktree add` writes it (`commondir` is `../..`, no
  `config.worktree`), and one removed passes (`git worktree remove`).
  The kit's own sandbox records keep their checks below.
  While tickets land during the run, the base may move only by the kit's own writes: a merge holding
  exactly the gated tree, or a ticket file's commit.
  Any other movement stops the run.
  The guard cannot tell a person's commit on the base from a sandbox's, so a commit, pull or merge
  there mid-run stops it: use another worktree until the run ends (the start line says so).
  Worktrees share `.git/config`, which is compared by key: an upstream (`branch.<name>.remote` and
  `.merge`) that another worktree gives its own branch (`git worktree add` from a remote branch,
  `git push -u`, `git branch -u`, `gh pr create`) runs no program, so the run prints one line and
  goes on.
  Any other change stops it, and the stop names the keys (with old and new values, except for keys
  that run a program or carry credentials, and with any token in a URL hidden): a remote, a hook
  path, an `include`, `rebase` or `pushRemote`, or an upstream on the base or an `agent/issue-*`
  branch.
- 🛂 **Checked before every sandbox opens.** Sandcastle's open runs git on your machine in the
  project: `git worktree add`, whose checkout writes every file out through the filters
  `.git/config` names, or `git status` in a worktree it reuses (the kit's patch of Sandcastle drops
  the `git fetch` and fast-forward from origin that followed it).
  The pins hold only the filters configured when the run started, so a filter another sandbox
  planted since the last check would run there.
  So the fingerprint is checked last thing before each sandbox is created - a ticket's, as it starts
  and when it resumes after a pause, the gate sandboxes and the landing sandbox, and those of
  `sandcastle land` and `sandcastle gates`, against a reading each takes as it starts - and a change
  stops the run with nothing opened.
  What remains is the moment between that check and Sandcastle's own git calls.
- 🚪 **Checked before every sandbox closes.** Sandcastle's close stops the container, then runs
  `git status` on your machine in the sandbox's worktree, which reads `.git/config` and that
  worktree's record in `.git/worktrees/<name>/`.
  So before each close - a ticket's sandbox at the end of its pipeline or for a pause, the gate
  sandboxes, the landing sandbox - the kit stops the sandbox's container itself, so nothing the
  sandbox left running there (an agent's background job, a server a gate started) can write `.git`
  after the check; then the fingerprint is checked, and the worktree's record is held to what git
  writes: the worktree's `.git` file names that record, the record's `commondir` names the shared
  `.git`, and there is no `config.worktree`.
  A record that differs would have that `git status` read config no check has seen, and a filter
  there would run on your machine.
  The same check refuses a git repository nested in the worktree - any `.git` entry below the
  worktree's root other than its own `.git` file - naming the path, since a `git status` that looks
  into it reads its own config and filters.
  Submodules are not supported in sandboxes (Sandcastle never initialises them).
  The record check also comes before the host runs git in a worktree an earlier run kept (cutting a
  stale branch there, or Sandcastle reusing it as a sandbox opens): a fingerprint taken at this
  run's start would read an earlier sandbox's change as the way things are.
  A failure stops the run, and so does a container Docker refuses to stop; the sandbox's container
  is removed without that close, and its worktree is left for you - inspect its record before
  running any git command in it.
  What remains is the time between that check and Sandcastle's own git call, while it removes the
  stopped container: another sandbox still running could write `.git` then, as it could in the
  milliseconds a landing leaves between its last check and the fast-forward of your base branch.
- 🗄️ **Agent branches checked and backed up.** A container can delete a branch no live sandbox
  holds, and a `gc` there removes its commits for good.
  The same check also covers each ticket's `agent/issue-*` branch: when a pipeline ends with
  commits, the kit copies the branch into a bare repo at `.sandcastle/backup.git`, which no sandbox
  mounts.
  A branch that vanishes is restored from that copy with a warning line; a tip that moves for a
  ticket that is not running stops the run.
  A base that was deleted or moved stops it with the exact `git update-ref` that puts it back, and a
  sandbox's worktree record rewritten to a container path (`git worktree repair`) is named.
  A branch the kit deletes itself, a landed one, is never restored.
  The copy of a branch you merged by hand is dropped at the next run's start (or by
  `sandcastle clean`), so the backup does not grow.
  The copy of an unmerged branch you deleted by hand is kept, so the work can still be restored,
  until `sandcastle clean --all`.
- 🚧 **Git guard.** A Claude Code managed hook (`container/`, mounted read-only at
  `/etc/claude-code`, above any project setting) refuses `git update-ref`, `gc`, `prune`, `stash`
  (its list is shared by every worktree), `push`, `reflog expire`, `worktree prune`, `repair` and
  `add` (a scratch repository's own is allowed), deleting an `agent/*` branch, `rm` or `mv` inside
  the shared `.git`, and writes to it.
  Project hooks still run, and `reset --hard`, `clean`, `checkout .`, `stash list` and
  `worktree remove --force` stay allowed, as do `update-ref`, `gc`, `prune` and `stash` run as
  `git -C <absolute path>` in a scratch repository outside the project (`push` stays refused
  everywhere).
  It reduces accidents and is not a boundary - `sh -c` or a script gets past a command match; the
  host-side checks here are the real protection.
- 🎯 **Landing checks.** Before a green branch merges, its ticket is read again - closed or
  labelled `ready-for-human` during the run means no merge - and the merge takes the exact commit
  the gates passed on. A run that dies between merging and closing is finished by the next one.
- 🏷️ **Who committed.** Sandbox commits and the kit's merges carry the committer
  `Sandcastle agent <agent@sandcastle.invalid>`; you stay the author.
  `git log --format='%h %an / %cn %s'` tells them from your own commits.
  GitHub issues and comments the agents write still show your GitHub account.
- 🛡️ **Protected paths.** A green branch that changes hooks (git - the tracked directory
  `core.hooksPath` names among them -, Claude Code, pre-commit tools, and the config of lint-staged, lefthook,
  husky, simple-git-hooks and yorkie, in their own files or in a `package.json` key, and lefthook's script
  directories `.lefthook/` and `.lefthook-local/`), CI, agent settings
  (`.claude/` settings, `.mcp.json`, `.codex/`, `.agents/`), `.sandcastle/`, package-manager config
  or install scripts - plus anything in `protectedPaths` - is labelled `ready-for-human` and left
  for you to merge; `sandcastle land` refuses it too.
  A branch that adds a file over 50 MB is held the same way: GitHub refuses a push with one over 100
  MB, and a file that size stays in the history for good.
  A ticket whose work lies in a protected path therefore always ends held, so
  `sandcastle queue --lint` and `sandcastle requeue` warn about one (its `Touches:` line, or a kept
  branch, names the path): merge it by hand rather than queue it.
  A run still starts one whose `Touches:` line names the path, and says so in its start plan
  (`#N will be held for a person to merge (paths)`); its `needs a human` line at landing names the
  paths too.
  The implement and review prompts list the protected paths as well (the defaults and
  `protectedPaths`), so an agent does not touch one the ticket did not need, and the review reverts
  such a change.
- 🚫 **Nothing is pushed or deployed** by the kit. Prompts forbid deploys and production commands;
  put the project's own prohibitions in `rules.md`.
- 📁 **Sandbox transcripts** stay in the project's `.sandcastle/logs/`, not in `~/.claude/projects`.

> [!WARNING]
> Do not weaken these rules to make a run start. If a check fails, fix the cause.
