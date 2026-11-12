# 🚦 Concurrency

How many sandboxes run at once, the machine-wide pool shared by every project's run, and how to size
it.


Several projects can run at once; one project runs once at a time (`run.lock`). A machine-wide
pool caps live sandboxes (default 6) and gate runs (default 2) across all projects. Agents mostly
wait on the model, so the sandbox cap mainly limits memory and plan usage; gates are the
CPU-heavy part, and running too many at once produces false test failures. Change the caps in your
[personal settings](configuration.md#personal-settings). The gate cap does not reach the tests an agent runs in its
own sandbox, so each sandbox also gets a CPU limit (the project's `cpus`, by default the VM's CPUs
divided by the run's concurrency for a ticket's sandbox, and by `maxGates` for a gate-only one: a
landing, the base and verify gates, `sandcastle gates` and `sandcastle land`).
Each sandbox gets a **memory limit** too, swap included (the project's `memory`, by default 1.5 x
its measured anonymous memory once it has 10 samples, else none; see
[Configuration](configuration.md)).
A Docker Desktop or OrbStack VM is one ceiling for every sandbox on it: without a limit, one suite
that balloons pushes the others into the VM's OOM killer, which picks its victim across all of them.
Inside a limit the kernel kills inside that sandbox only, and the gate or pass says so
(`exit 137, out of memory: ...`) rather than a bare exit 137.

The limit is `docker run --cpus`: a CPU time quota in the container's cgroup, not a set of pinned
cores, so some CPU counts inside a sandbox still show every CPU of the VM. Node 24's
`os.availableParallelism()` reads the quota and returns it, so a runner that sizes its workers from
it (vitest) fits the limit. `nproc` (GNU coreutils reads a cgroup quota only from release 9.8),
`os.cpus().length` and Python's `os.cpu_count()` count the VM's CPUs, so a runner sized from one of
them (`make -j"$(nproc)"`, pytest-xdist's `-n auto`) starts more workers than the limit lets run:
give its gate command a worker count (`pytest -n <N>`, `make -j<N>`). The load average a sandbox
shows (`uptime`, `/proc/loadavg`) is the whole VM's, every sandbox and every run on it included, not
the sandbox's own.

When every slot is taken, a freed slot goes to the run that has waited longest, across projects, for
sandbox and gate slots alike: a run that has just freed one does not take it back from another run
that was already waiting.
The one exception is a landing's sandbox slot while another of the run's green branches is queued to
land: it goes straight to that next landing (and back to the pool if that landing does not use it
within a minute), so the queued branch does not wait behind another run's ticket.
Within one run, a landing's gates (and the base and verify gates) take a freed gate slot before the
run's ticket gates, since the one landing worker sets the run's end, and a landing still goes before
its next ticket for a sandbox slot.
A wait or a slot left by a run that was killed is ignored.
The status header shows the pool (`machine: sandboxes 3/6 · gates 1/2`).
The base check a run makes mid-run starts its sandbox inside the slot of the ticket that asked, so
it never waits for one, but it is counted: while it lives the pool can read one past its cap
(`7/6`).
So can a ticket whose sandbox only waits for a gates slot: it moves off the sandbox count
(`maxSandboxes`) while it waits and while its gates then run, so another ticket's agent pass can use
the slot, and the header still counts its container.
The status view's MACHINE lane keeps those apart: its sandboxes gauge counts the slots against the
limit and adds `+N for gates` for the N sandboxes outside it (`sandboxes 3/3 +1 for gates`), the
same figure the run's start line gives as `1 waiting for a gates slot, outside the limit`.
Up to `maxGates` tickets per run wait so; a ticket leaves that limit once its gates slot is granted,
so the next ticket that waits can move off the count too.
It takes a counted slot again before a repair pass, ahead of tickets that have not started.

Live runs also split the sandbox slots between them, by **share**.
A run's **demand** is how many slots it could use now: the tickets in a sandbox or ready to start,
plus one while a green branch waits to land, never more than its concurrency; a ticket held for a
blocker adds nothing until the blocker lands, and a run that has drained its queue asks for none,
nor does a [paused](running.md#-pausing-a-run) run once the passes in flight have ended (its tickets give
their slots back).
The pool is divided equally between the runs that ask for slots, and a run that needs less than an
equal part releases the rest to the others, again equally.
A run's share is its part of the pool less the one slot kept for landing (below): with two runs
wanting 5 each on 6 slots, they get 3 and 2 (the earlier gets the odd one); a run wanting 1 leaves 4
to the other; a run alone gets everything it asks for, as before.
A run at or above its share (the slots it holds count) takes no new slot while another run below its
share wants one; with no one wanting one, a free slot is taken as usual.
Nothing is stopped: a run over its share keeps every slot it holds and shrinks as its tickets
finish, so a second run that starts while the first fills the pool waits for tickets to end (often
tens of minutes) and then fills up, and when a run ends the others grow back.
One slot of the pool is kept for any run's landing, not one per run: beside another run the shares
split the pool less that slot, so a run's tickets use their whole share, and no ticket takes the
pool's last free slot while another run is live and a landing is near (a ticket of either run in its
gates, or a branch queued to land or landing; with none near the slot is any ticket's, and a run
from an older kit counts as near).
A landing may take it, whatever its run holds against its share, and any other free slot one past
its run's share, and when two runs' landings want it, the longer wait goes first (a run alone keeps
one of the machine's slots the same way, in its worker count).

The run's start line names this cap when it cuts the workers below `CONCURRENCY`: which setting holds
the pool (`SANDCASTLE_MAX_SANDBOXES`, `maxSandboxes` in the machine settings, or the default of 6),
that one slot is kept for landing, and that gate passes run beside the workers on the gate slots
(`sandcastle size` suggests a figure).
A ticket in its gates pass is not counted in "up to N at a time", so more than N tickets can be in a
sandbox at once.
With two runs wanting 5 each on 6 slots that is 3 + 2 tickets and a free slot for landing; with
three, 2 + 2 + 1; with four, 2 + 1 + 1 + 1; on 3 slots between two runs, 1 + 1.
While a landing runs, a ticket that ends does not hand its slot to a new ticket until the landing is
done.
Gate slots have no shares: they go to the longest wait.
The status header's `this run` row shows the run's demand and share (`wants 4 · share 3`), the Herdr
tab bar shows each live run's share, and while the run waits for a slot its share holds back, the
tickets next to start say `waits for the run's share` (or `waits: slot kept to land`, when the
pool's last free slot is kept for a landing).
A run started by an older kit knows no shares and ignores them until it ends; it counts as wanting
its concurrency.
All runs share one plan allowance; the first ticket that hits the usage limit (a session or weekly
limit message in its log) stops that run's queue; the tickets it cut short end as not started and
runnable again, not as crashes, and the closing summary gives the reset time.
With `USAGE_CHECK=1` a run stops starting tickets before that, once a usage window passes
`USAGE_STOP` percent; with `USAGE_PAUSE` it pauses instead of stopping, and resumes after the
window's reset ([Pausing a run](running.md#-pausing-a-run)).

**Capping a run.** `sandcastle cap N` limits the project's live run to N sandbox slots while it
runs, so another run gets more of the machine; `sandcastle cap off` lifts it, and a bare
`sandcastle cap` prints the run's demand, share, what it holds and its cap.
`--project <name>` acts on another project's live run from any directory (the `name` in that
project's `.sandcastle/config.ts`, as live runs record it).
N is a whole number of 1 or more, at most the run's concurrency (the most a run ever wants); `cap`
refuses anything else, and refuses when no run is live.
A cap only lowers the run's share: the slots it frees go to the other live runs, up to their demand,
and with two runs wanting 5 each on 6 slots, a cap of 1 on one gives the other 5; lifting it returns
both to 3 and 3.
A capped run takes no slot at its cap even when no other run wants one.
Like any share, it is never taken from a run that holds slots: a run above its cap keeps the ones it
holds and shrinks as its tickets finish.
The cap lives in the run's registration and ends with the run: the next run of the project starts
uncapped.
The status header's `this run` row shows it beside demand and share (`wants 4 · share 2 · cap 2`).

**Sizing the pool.** `sandcastle size` is read-only: it reads the container runtime's VM
(`docker info`: its CPUs and memory), the host's RAM and the free disk where images and worktrees
live, and recommends the limits above, naming the figure that set each.
A gate runs inside a sandbox, so the gates' sandboxes are priced at a **gate figure** and the rest
at an **agent baseline**, what a sandbox needs between gates.
Gates are the smaller of `floor(VM CPUs / 6)` and `floor((VM memory - 2 GiB) / the gate figure)`, at
least 1; sandboxes are those gates plus
`floor((VM memory - 2 GiB - gates x the gate figure) / the agent baseline)`, at least 1 and at most
the smaller of 12 and the VM's CPUs, and the gates never more than the sandboxes.
The 2 GiB headroom and the 6 CPUs a gate wants are assumptions, and are printed with the answer.
On native Linux Docker the VM's memory is the whole host's, so the 2 GiB covers less: the desktop
and everything else share it.

The two figures are **measured** once runs have been recorded, and both assumed (1.5 GiB, and the
answer says so) until then.
Every sandbox's peak memory is read from inside it, from the kernel's own high-water mark (cgroup v2
`memory.peak`), after each gate pass and again before it closes.
Gates run in the agent's own sandbox, and the base and verify gates in a throwaway one, so a
sandbox's peak covers its gates, and a heavy gate (a browser test suite, say) shows in it.
The largest reading goes into the gate pass's line in the project's `.sandcastle/logs/timings.jsonl`
(`peakMib`) and, one line per sandbox, into `peaks.jsonl` in the kit's cache directory
(`~/.cache/sandcastle-kit/`, or under `XDG_CACHE_HOME`) beside the live-runs directory.
A line holds a time, the run's start time, the peak, the anonymous-memory figure below when the
kernel gives one, and a hash of the project root: no path and no project name.
A ticket's sandbox whose agents ran also records `agentMib`, its peak read just before its first
gate pass (the peak cannot be reset, so after a gate it is the gate's), and `agentAnonMib`, the
anonymous memory read while its agents worked; a line without them is a gate peak only.
Memory pressure is read in the same 10-second loop: the sandbox's own cgroup `memory.pressure`
(PSI), `some` and `full` `avg10` (the percent of the last 10 seconds its tasks stalled on memory,
`full` being all of them at once).
The highest goes onto each gate pass's `timings.jsonl` line (`pressureSome`, `pressureFull`) and
onto the sandbox's `peaks.jsonl` line, where it was above 0; a kernel with no PSI records nothing,
and a run says so once, at the first reading (`Memory pressure: the sandboxes' kernel has no PSI
...`): OrbStack's kernel is one, so there the pressure figures stay empty, which is not calm.
`size` shows the highest of the runs it rests on and, at 5% `full` or more, says the VM was short of
memory at that pool size; a run's closing summary has a `Memory pressure` line under the same
condition.
It is a warning only: `size` does not yet lower its recommendation for it.
CPU pressure is read in the same loop, as two figures.
The one a run judges is the **machine-wide** CPU pressure (PSI `some` `avg10`), read by the kit
itself, not through a sandbox: on Linux and WSL2 the host's own `/proc/pressure/cpu` (on WSL2
Docker's engine shares the VM's kernel, so it is the file a container sees), and on macOS, which has
no PSI, an estimate from the 1-minute load average, `max(0, (load1 - cores) / load1) x 100`, marked
as an estimate wherever it is shown; anywhere else, or where the file is unreadable, nothing is
read.
Each gate pass's `timings.jsonl` line carries its highest and its mean (`cpuMachine`,
`cpuMachineMean`, and `cpuEstimate` for the macOS figure), and the pass's mean at 60% or more counts
as a busy machine.
A run's closing summary has a `CPU pressure: high` line when its busiest pass reached that: it gives
the mean, names the pass, and says to run `sandcastle gates` when the machine is quiet or to lower
`maxSandboxes`.
The sandbox cgroup's own `cpu.pressure` is recorded too (`cpuSome`, `cpuSomeMean`, and on the
`peaks.jsonl` line) and never judged: the kit's own `--cpus` limit raises it, so it cannot tell
other work on the machine from the kit's own.
Three things to know: the macOS estimate reaches 60% only at a load of 2.5 times the core count or
more; WSL2's PSI sees the Linux VM, not load on the Windows side; and the machine figure includes
the kit's own gates and agents, not only other work.
A run **holds a gate pass while the machine is busy** (`LOAD_PAUSE`, on by default at 60%).
Before a gate pass asks for its gates slot, the run reads the machine-wide CPU pressure (`some`
`avg60`); at or over the threshold the pass waits, and goes on once the readings have stayed under
it for 2 minutes (a reading at or over restarts the 2 minutes).
Every gate pass of the run is held - a ticket's, a landing's, the base gates and the verify - and
its ticket shows `waiting: machine load`; a ticket's own sandbox slot is freed meanwhile, as in a
wait for a gates slot, and agent passes go on.
It is not the usage pause: no ticket parks and no sandbox closes.
The hold gives up after 30 minutes in all per run (two passes held at once count once): every hold
releases, the run holds nothing again, and the closing summary has a `Load pause` line with the time
and, if it gave up, that later passes ran under load.
A machine that gives no reading (see above) never holds.
`LOAD_PAUSE=0`, or `loadPause: false` in `.sandcastle/config.ts`, turns it off.
The wait is its own figure in the gates log (`# held Ns for machine load`) and the timings
(`loadHeldMs`), apart from the gates slot wait.
`size` takes the project whose peak figure (priced as below) is highest over its last 5 measured
runs (and older ones while those hold fewer than 10 samples), of the projects measured in the last
30 days, and prices each figure at the 90th percentile of that project's samples over those runs
(every sandbox's line is one sample), plus 10%: one pass that peaked far above the rest would
otherwise set every later pool, so the highest is shown beside the figure (`90th of 34 samples;
highest 5.1 GiB`) and not priced.
A figure needs 10 samples of one project before it counts: the nearest-rank 90th percentile of
fewer is their highest, and one outlier among seven once set a pool of one sandbox for every
project.
A figure short of them falls back as one never recorded does (the anonymous gate figure to the peak,
the agent's to `agentMib`, then to the gate figure), and a project with fewer than 10 peak samples
does not count at all.
The gate figure is `anonMib` when any of the runs recorded it, else the peak; the agent baseline is
`agentAnonMib` when the gate figure is `anonMib` and a run recorded it, else `agentMib`, else the
gate figure ("no agent baseline measured yet").
It prints each figure with where it came from, the project (`this project` when you run it inside
it, else the hash), the runs it rests on and the resulting limits; run inside another project, it
adds that project's own gate figure, or that it has too few samples yet.
Where the kernel gives no figure (cgroup v1, a kernel before 5.19), nothing is recorded and `size`
keeps the assumed one.
The peak counts page cache the kernel has not yet reclaimed, so it is on the high side, which suits
a limit but can overstate a sandbox's need; `memory.stat`'s `anon` (memory no file backs) is read
once as a gate pass starts and every 10 seconds while it runs, and recorded as `anonMib` (the
largest reading: `anon` has no high-water mark of its own, so a reading after the test workers have
exited would miss them, and none is taken then), and `size` prices the gate from it.
A line records that it was written this way (`sampled`): the anonymous figures of an older line,
which may hold a reading taken after the gates, are not used, and a figure under 256 MiB is a
sandbox at rest and does not count either, so those runs are priced from the peak until a newer run
has recorded them.
A VM whose memory less the headroom is under one gate figure is told it cannot fit one gate sandbox;
the pool keeps 1 and 1.
When the gate figure is `anonMib`, the agent baseline is not the cache-inclusive `agentMib` and the
effective limits, priced the same way (`min(maxGates, maxSandboxes)` gates at the gate figure, the
other sandboxes at the agent baseline), need more than the VM's memory less the headroom, doctor and
the run's start line warn, naming both numbers and the `config.json` key (or the `SANDCASTLE_MAX_*`
variable that overrides it).
From `memory.peak` alone (the gate's or the agent baseline's) or the assumed figures nothing is
warned (a pool it priced past the VM ran clean: page cache is reclaimed), and doctor keeps its
`info` pointer.
The pool's shares divide whatever limit you set; nothing about them changes.
`size` shows the current limits beside the recommendation (environment, then `config.json`, then the
defaults) and says when they already match; it changes nothing, so you copy the numbers into your
[personal settings](configuration.md#personal-settings) yourself.
It also says where the runtime's own CPU and memory setting lives (OrbStack `orb config set`, Docker
Desktop Settings -> Resources, `podman machine set`, `colima start`; native Linux Docker has none)
and, only when the VM has more than half of the host's RAM or all of its CPUs, why to lower it:
leave the host room for your other apps, memory beyond what the containers use only grows the VM's
file cache (which the host then swaps), and too few CPUs slow gates and can flake timing-sensitive
tests (2 gates want about 8 CPUs).
Applying a runtime change restarts it and stops a live run's containers, so wait for runs to finish
first.
A `docker info` that fails is refused with a reminder to start the runtime, and one that gives no
answer within 10 s with that said.
