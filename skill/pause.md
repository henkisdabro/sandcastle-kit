# sandcastle pause and resume - hold a run, carry on

This continues SKILL.md: run its "Before every action" first. Both actions work on the project's
live run, from the project root, and neither calls a model.

## Pause, not stop

A request to **hold** the run is a pause: "hold the run", "pause it", "stop starting new tickets",
"pause it until tomorrow", "I need the machine for an hour", "I am close to my plan limit". Always
prefer `sandcastle pause` for these: nothing in flight is thrown away. A request to **end** the
run ("stop the run", "kill it", "cancel it") is `sandcastle stop`, and only after the user has
confirmed that the passes in flight end mid-way: their sandboxes are killed, the closing summary
is partial, and the tickets it cut short wait for the next `sandcastle run`. Ask with the
harness's question tool (`AskUserQuestion` in Claude Code), pause first among the options, and
run `sandcastle stop` only on a yes to ending it. A bare "stop" that could mean either is that
question too. After a stop, `sandcastle wait` (or `sandcastle report`) shows how the run ended:
hand it back as run.md's "Close the run" step says.

## pause - hold a live run

Done when the user knows the run is paused (or that no run is live), what is still finishing, and
how to resume.

1. Run `sandcastle pause`. It prints one of:
   - `No run is live.` - tell the user there is nothing to pause. `sandcastle status 0` shows how
     the last run ended; do not start one to pause it.
   - `The run (pid <n>) is already paused, since <time>.` - nothing changed; say since when, and go
     on to step 2.
   - `Pausing the run (pid <n>): ...` - go on to step 2.
   - `The run (pid <n>) paused itself at <time> for its plan's usage (...). The pause is yours now:
     ...` - the run had paused itself for `USAGE_PAUSE` and would have resumed after the window's
     reset; the user's pause now holds it until `sandcastle resume`. Say both, and go on to step 2.
2. Run `sandcastle status 0`. The run reads the pause within a second or two; if the run cell does
   not read `PAUSED since <time>` yet, run it again before telling the user it is paused.
3. Tell the user, in a few lines:
   - **What is still finishing.** The run cell names it (`PAUSED since 15:40 - finishing #12
     review, #14 landing`): a pass already running finishes, then its sandbox closes. Each ticket
     parked between two phases reads `paused`, its note naming the phase it resumes at. When the
     cell reads only `PAUSED since 15:40`, nothing is in flight: the run holds no sandbox slot and
     the machine may sleep.
   - **Green branches keep landing.** Gates and landings are no agent passes, so a ticket whose
     pass has ended still gates, and a green branch still lands.
   - **Nothing is lost.** Every ticket's branch keeps its commits, and a resume continues each
     from its next phase in the same run, with one closing summary at the end. The run stays
     live while paused, so no new `sandcastle run` can start in the project, and `sandcastle wait`
     keeps waiting.
   - **Leave the run's branches alone.** The pause frees the machine, not the repository: a commit,
     merge or pull on the base branch or an `agent/*` branch in this checkout stops the run at its
     next landing, or as its next sandbox opens (the resume's, at the latest). Work done meanwhile
     goes in another clone or a worktree.
   - **How to resume.** Ask for it in plain words ("carry on", "resume the run"), or run
     `sandcastle resume`. A pause the user takes has no timer: "until tomorrow" means the run stays
     paused until someone resumes it, so say that, and offer to resume when the user comes back. A
     pause the run took for its plan's usage (`USAGE_PAUSE`, the run cell naming the window) resumes
     by itself a minute after that window's reset, unless the user pauses it too.

## resume - carry a paused run on

Done when the status view no longer reads PAUSED (or the user knows why there was nothing to
resume).

1. Run `sandcastle resume`. It prints one of:
   - `No run is live.` - say so. A run that ended while paused (stopped, crashed) lists its paused
     tickets under Runnable now in `sandcastle report`: each branch holds its work, and the next
     `sandcastle run` picks it up. That spends the user's allowance, so get the yes
     SKILL.md's "Costs" asks for.
   - `The run (pid <n>) is not paused.` - nothing changed; say so.
   - `Resuming the run (pid <n>, paused since <time>): ...` - go on to step 2.
2. Run `sandcastle status 0` and confirm the run cell no longer reads `PAUSED` and the parked
   tickets have left `paused` for a working state. The run reads the resume within a second or two:
   run it again before saying it did not take. Tell the user the run is going again, and that its
   end is heard as run.md's step 3 arranged (the mod's prompt, or `sandcastle wait`).
