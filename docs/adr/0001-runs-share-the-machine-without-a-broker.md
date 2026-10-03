# Runs share the machine without a broker, and never lose a slot they hold

Runs of different projects share one machine pool by an equal split of its sandbox slots, worked
out by each run from the lock files they already share - not through a central service, and not
by one run taking tickets from many projects. A run above its share stops taking slots but is
never stopped: an agent stopped mid-ticket wastes the allowance it spent and costs the ticket one
of its two attempts, so a share is reached as tickets finish, not at once.

## Considered Options

- **A central service** that owns the pool and hands out slots. It could also enforce a shared
  usage budget, but it is a process to install, keep alive, recover and keep in step with kit
  updates, while detached runs already outlive the session that started them. Worth revisiting
  only once a cross-project usage budget needs one owner, which first needs a token that can read
  plan usage.
- **One run across projects.** Every part of a run - image, gates, guard, ledger, landing - assumes
  one project; it would be several runs in one process, with more risk and no gain.
- **Taking slots back** (stopping the newest attempts when a share shrinks). Rejected for the cost
  above.

## Consequences

A run that starts while another fills the pool waits for that run's tickets to finish, often
tens of minutes. A run started by an older kit ignores shares until it ends.
