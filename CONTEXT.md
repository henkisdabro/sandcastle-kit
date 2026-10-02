# sandcastle-kit

Unattended coding agents that burn a repository's tickets down in Docker sandboxes, and the views
that show a person where each ticket stands.

## Language

### A run and its record

**Run**:
One `sandcastle run`: the tickets it takes, the sandboxes it fills, and its end.
_Avoid_: job, session

**Run record**:
The file a live run keeps of itself and of each of its tickets, which every view reads.
_Avoid_: run.json (the file's name, not the concept), status file

**Ticket state**:
Where one ticket of a run stands, as the run record holds it - one of a closed set. A phase
(implement, review, gates ...) is one kind of ticket state.
_Avoid_: status, phase (for the whole set)

**Requeued**:
A fact about a ticket's second attempt after a conflict or a red at landing, not a ticket state:
the ticket is queued again, and the fact stays with it through that attempt.
_Avoid_: using it as a ticket state

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
