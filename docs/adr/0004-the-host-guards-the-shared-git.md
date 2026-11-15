# The host guards the shared `.git`; the git guard inside the sandbox is not a boundary

Every sandbox mounts the project's `.git`, and Sandcastle's open and close run host git in it, so a
filter, merge driver or hook a sandbox planted would run on the operator's machine with their
credentials. The kit defends `.git` from the host: it fingerprints the parts that make git run a
program, checks the fingerprint before every host git call a sandbox could have influenced (a
sandbox's open and close, a repair pass, a landing), and keeps a baseline across runs. A
difference stops the run, or refuses the next start, rather than being repaired. The Claude Code
git guard inside the sandbox only reduces accidents.

## Considered Options

- **Make the git guard a boundary** by scanning script files, `sh -c` and heredocs for guarded git
  commands. Rejected (#591): a command matcher can always be got round, so it would promise a
  protection it cannot keep. The question came back as heredoc refusals (#482, #851) and got the
  same answer.
- **Restore `.git` when it differs.** The kit never writes `.git/config`: a change may be the
  operator's own, so the stop names it and the operator removes it or accepts it as the new
  baseline.

## Consequences

The detail - what is fingerprinted, when it is checked, the start baseline and the changes a clean
end lets through - lives in `docs/safety.md`, and changes there without a new ADR.
