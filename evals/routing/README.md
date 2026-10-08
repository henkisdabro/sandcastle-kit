# Routing eval

Which model and effort should each of the kit's roles get, and can a cheap model take some of the
work without lowering what lands? This eval answers that on real work. It replays tickets this
repository's own runs landed, through the kit itself, under different model pairings. Each one is
graded by the tests the historical fix landed with. It measures quality per dollar, quality per
minute, and how alike repeated runs are.

It spends model allowance. `validate` and `report` make no model calls. `run` makes many, and needs
`--spend`. `judge` uses Codex on the ChatGPT plan.

## The question behind it

Five places can choose a model. From the most deterministic to the least:

| Where | Who decides | Today | What the eval tests |
|---|---|---|---|
| **Role table** - project config, `IMPL_*` / `REVIEW_*` | the operator, once | implement, review; repair and resolve take the implementer's model | every arm is a role table |
| **Ticket label** - `model:` / `effort:` | triage, per ticket | raw model ids | whether a ticket's shape predicts the cheapest tier that resolves it |
| **Escalation** - a stronger tier after a red gate or a held branch | the scheduler, on what it observes | none: a requeue reruns the same model | the "review rescued" column says how much a cheap first try leaves for the next pass |
| **Inside a pass** - subagents, the advisor | the model, within limits the kit sets | unused: recent passes made Bash calls only, no Agent call | `+haiku-subagents` and `+advisor` arms |
| **Prompt wording** | the model | - | nothing; earlier A/B rounds found that wording barely moves a low-effort model |

What the models decide for themselves: how hard to think within an effort level, and whether to
start a subagent or ask an advisor. What they cannot decide is which model and effort they run at,
or what a token costs. Those are the harness's job. The eval's job is to give the role table and
the ticket labels numbers, so that routing is a fixed rule in config and not a judgement made
mid-run.

## A trial

One task (a landed ticket), one arm, one repetition:

1. A fresh repository holds the ticket's **base**, the commit its branch was cut from, and nothing
   later. It is fetched by sha alone, so the reference fix is nowhere an agent can read.
2. The ticket goes in as a ticket file (`tracker: "files"`), so nothing is written to GitHub. It
   carries the issue body and the triage comments made before the branch's first commit. The
   implementer's own report comment is left out, since it describes the solution. Any `Blocked by`
   line is dropped.
3. A `## Seams` section names each export the hidden tests call that the base lacks, as a signature
   with no body. Without it, a correct change that chose another name would fail. Every arm gets the
   same ticket.
4. The kit runs it as it runs anything: `sandcastle run` with the arm's `IMPL_*` / `REVIEW_*`
   (cross-review off). A mechanism arm also writes `.claude/settings.json`.
5. The record is collected: run.json's ticket entry, timings.jsonl, and each agent stream's
   `modelUsage` (subagents and advisor included). It also records each request's prompt size,
   because Haiku 5.5 bills a prompt over 100K tokens at five times its card.

## Grading

- **Hidden tests.** The reference's `test/` changes are copied over the tree, and each test file runs
  alone with a time limit. All must pass. The tree is graded twice:
  - at the implementer's last commit: **impl alone**, which does not depend on the reviewer;
  - at what the run landed: **resolved**, which is the whole pipeline.
- **Probes.** Some historical fixes shipped a bug a later commit fixed, for example #405's half fix.
  For those, the later fix's test is a probe. The reference fails it; a stronger arm may not.
- **Judge.** `judge` asks a model of another family (Codex, on the ChatGPT plan) to score a change
  against the reference. The judge is blind to which change is which, and runs twice with the two
  sides swapped. It scores scope, tests, conventions and risk, which the tests cannot see.
- **Contamination.** A trial whose agents called `gh` or fetched the upstream repository could have
  read the fix. It is reported, and it counts as unresolved.

`validate` grades the base and the reference with no model call. The hidden tests must fail at the
base and pass on the reference, or the task proves nothing and is dropped (`"drop"` in tasks.json).
Hidden tests that read source text instead of behaviour are listed per task, so read their failures
by hand.

## Arms

An arm is `<implement>/<review>[+mechanism]`. A role is a model letter (H = Haiku 5.5, S = Sonnet 5.5,
O = Opus 5.5) and an effort, so `H-high/O-high` means Haiku at high implements and Opus at high
reviews. The two mechanisms are `+advisor` (the implementer may consult Opus 5.5) and
`+haiku-subagents` (any subagent it starts runs on Haiku). Today's default is `S-high/O-high`, the
baseline every arm is paired with.

## Tasks

Sixteen tickets from the v0.9.0 to v0.11.0 runs. Each one is validated: its hidden tests fail at the
base and pass on the reference. `history` in tasks.json records how the ticket went when it landed.
"impl alone then" is the reviewer's own tests run against the historical implementer's last commit;
"caught" means the review fixed a defect the implementer shipped. A probe is a later fix's test that
fails on the reference because of the shipped bug, not because of naming.

| # | kind, size, spec | landed with | impl alone then | probe |
|---|---|---|---|---|
| 477 pilot | bug, S, H | Sonnet high, $0.46, 3m | no review commit | - |
| 416 pilot | feature, M, H | Sonnet high, $0.28, 4m | caught | - |
| 418 pilot | feature, M, H | Sonnet high, $0.81, 4m | caught | - |
| 399 pilot | bug, M, H | Sonnet high, $0.75, 7m | caught | f52de0a |
| 461 pilot | feature, M, M | Sonnet high, $0.69, 4m | caught | #473 |
| 427 pilot | feature (bash 3.2 + TS), M, H | Sonnet high, $0.78, 9m | caught | #467 |
| 458 pilot | bug, L (16 files), M | Opus high by label, $5.25, 17m | caught | #474 |
| 405 pilot | bug, S, H | Sonnet high, $0.32, 4m | no review commit | - (later bug's test is name-coupled) |
| 474 | bug, M, H | Opus high by label, $1.09, 4m | no review commit | - |
| 402 | bug, L, H | Sonnet high, $0.79, 5m | caught | - |
| 413 | feature, L, H | Sonnet high, $0.73, 4m | no review commit | - |
| 398 | bug, L, H | Sonnet high, $1.51, 12m | caught | #448 |
| 394 | refactor, M, L | Sonnet high, $0.42, 6m | passes | - |
| 429 | bug, S, L (a thin follow-up body) | Sonnet high, $0.33, 6m | no review commit | - |
| 469 | feature, L, H | Opus high by label, $4.74, 14m | no test change | - (#472, a security hole, has no test yet) |
| 437 | bug, L, H | Sonnet high, $0.53, 4m | caught | - |

Spec: H means the body has where, fix, Done when and `Touches:`; M means where and fix; L is a
paragraph. Dollars are the historical implement pass at the list prices of the time.

Validated reserves, for a held-out split or a larger run: #392, #397, #401, #403, #414, #417, #431,
#432, #433, #438, #439, #441, #444, #446, #447, #448, #449, #462, #465, #468, #473, #476, #478, #484.
Three tickets fail validation because their tests already pass at the base: #408, #409, #475 (test
infrastructure).

## Stages

Recent history at today's list prices: a median ticket's Sonnet implement pass cost $0.43 and its
Opus review $0.61. The same implement tokens on Haiku 5.5 would cost about $0.02. So with Haiku
implementing, the review is about 96% of a ticket's cost, and the reviewer needs measuring as much as
the implementer: the same review tokens would cost $0.30 on Sonnet and $0.02 on Haiku.
Agent passes started near 45K tokens and peaked near 66K, so a Haiku pass that explores no more than
Sonnet's did stays under the 100K card.

1. **Implementer sweep** - cheap, because it reads only *impl alone*, which no reviewer changes:
   `S-high/H-low`, `S-medium/H-low`, `O-medium/H-low`, `H-medium/H-low`, `H-high/H-low`, `H-max/H-low`.
   Run the pilot first (`--pilot`: 8 tasks, 1 rep), then all 16 tasks with 3 reps.
2. **System** - the baseline, plus the two or three implementers on the sweep's frontier, each with
   reviewers `O-high`, `S-high` and `H-max`. Add `+advisor` on the best Haiku implementer. Add
   `+haiku-subagents` once, to see whether any delegation happens at all. 3 reps.
3. **Routing rule** - for each task, the cheapest arm that resolved it in every rep is its tier.
   Fit a rule on ticket features known at triage (files in `Touches:`, whether the design is decided
   in a comment, the seams it names, kind) on half the tasks. Score it on the other half against
   always-baseline. Only a rule that holds on the held-out half belongs in config, as tier labels or
   a role table.

## Running

```bash
node evals/routing/cli.ts build 405 438 461 477     # tasks.json from landed tickets (gh, read-only)
node evals/routing/cli.ts validate                  # no model calls
node evals/routing/cli.ts run --arms S-high/H-low,H-high/H-low --pilot --reps 1 --spend
node evals/routing/cli.ts judge                     # Codex
node evals/routing/cli.ts report                    # --baseline <arm> to pair with another arm
```

Trials, results.jsonl and validation.jsonl go to `$EVAL_WORK`, by default
`~/.cache/sandcastle-kit/routing-eval`. A trial already in results.jsonl is skipped, so a stopped
`run` resumes where it left off. Each trial is a whole `sandcastle run` and shares the machine's
sandbox pool with other runs (`--parallel`, default 2).

## Limits

- Grading runs on the host, while the kit's gates run in Linux. A test that is red only on one side
  shows up in `validate` as a reference that fails its own tests.
- The tasks come from one repository, a TypeScript CLI, written and triaged in one house style.
  Ticket clarity is high: most carry a recorded decision. That is the condition under which a small
  model should do best, so a project with vaguer tickets should rerun the sweep on its own.
- Run-to-run noise was up to 2x per ticket in earlier prompt A/B rounds. Read a difference through
  the paired interval, never a single run.
- Dollars are list-price API equivalents, with cache writes at the 1-hour rate, as Claude Code's own
  `costUSD` prices them. Each stream's `costUSD` is kept beside them as a check. On a subscription, the
  plan's usage weighting is not published per model, so read dollars as a relative measure there.
