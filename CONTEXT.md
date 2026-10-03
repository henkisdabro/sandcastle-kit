# sandcastle-kit

Unattended coding agents that burn a repository's tickets down in Docker sandboxes, and the views
that show a person where each ticket stands.

## Language

### A run and its record

**Run**:
One `sandcastle run`: the tickets it takes, the sandboxes it fills, and its end. It makes one or
more turns.
_Avoid_: job, session

**Turn**:
One pass of a run over the tickets it can take. A run at autonomy 0 makes one; a higher level
lets it turn again, up to the level's cap.
_Avoid_: round, iteration (an agent's own loop)

**Run record**:
The file a live run keeps of itself, its current turn and each of its tickets, which every
view reads.
_Avoid_: run.json (the file's name, not the concept), status file

**Run setting**:
A choice fixed when a run starts that shapes what it does or spends - the run record keeps it,
unchanged for the run's life. A per-ticket override (a ticket's model label) is not one.
_Avoid_: option, flag, config (one of the places a setting comes from, not the setting)

**Ticket state**:
Where one ticket of a run stands, as the run record holds it - one of a closed set. A phase
(implement, review, gates ...) is one kind of ticket state.
_Avoid_: status, phase (for the whole set)

**Requeued**:
A fact about a ticket's second attempt after a conflict or a red at landing, not a ticket state:
the ticket is queued again, and the fact stays with it through that attempt.
_Avoid_: using it as a ticket state

**Attempt**:
One pass of a ticket through the pipeline - implement, review, gates, repair - in a sandbox of its
own. A ticket that conflicts or goes red at landing is requeued for a second attempt; a run gives
a ticket two at most.
_Avoid_: try, retry, run (one `sandcastle run` is the whole run)

**Ending**:
How one ticket's part in a run ends - at landing, in its pipeline, crashed, stopped, never begun,
or still waiting - exactly one per ticket the run took in. Its ticket state and outcome line are
recorded from it.
_Avoid_: last word, result, outcome (the status view's line for it)

### What the views say

**Group**:
One of the status view's buckets a ticket state falls into - working, needs you, ready, queued,
blocked, merged, other - shared by every view so none disagrees about a ticket.
_Avoid_: bucket, category

**Word**:
The status view's short label for a ticket state, where it differs from the state's own name
(`impl` for implement, `gate red` for red).
_Avoid_: label, display state

**Derived state**:
A state the status view works out for itself and no run record holds - a run that died
(stalled, orphaned), a branch from an older run (left over), a branch of this run that waits for
landing to decide it (finished), or an older run's branch whose ticket was labelled again
(requeued).

**Outcome**:
What a run says became of one ticket, as a kind from a closed set (merged, conflict, red, gate
red ...) and its line; recorded from the ticket's ending, and kept in `outcomes.json` across runs.
Every view decides on the kind; the line is only for a person to read.
_Avoid_: result, the prose line alone

**Ledger**:
The module that turns endings and told changes into the run record's verdicts, outcomes, view
words and tracker text.

### Keeping a project up to date

**Kit version**:
The release a kit is at; a kit between releases also says how far past that release it is.
_Avoid_: kit commit (one way of telling a kit between releases, not its version)

**Upgrading note**:
One item in a release's Upgrading section: something an existing project may have to act on.
_Avoid_: migration, upgrade step

**Update record**:
What a project keeps, on one machine, of the Upgrading notes it has acted on.
_Avoid_: marker, kit-updated (the file's name, not the concept)
