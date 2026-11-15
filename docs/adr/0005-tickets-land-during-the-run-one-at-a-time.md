# Tickets land during the run, one at a time, at exactly the commit their gates passed

Each ticket lands as soon as its gates go green, on one serial landing worker that is the only
writer of host git during the run, rather than in one batch after every agent has finished. A
landing merges only the commit the gates passed, and the run's `.git` check lets the base move only
through the kit's own writes, so any other movement of the base stops the run.

## Considered Options

- **Land in one batch at the end** (the earlier design). In the first field run the first finished
  ticket waited 22 minutes to land, and 27 of 67 tickets conflicted (#100).

## Consequences

- Landings queue behind each other, so the landing gates added up are a floor on the run's end.
- The guard cannot tell a person's commit on the base from a sandbox's, so a commit, pull or merge
  on the base mid-run stops the run: the operator works in another worktree until it ends.
