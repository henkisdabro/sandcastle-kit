#!/usr/bin/env bash
# How many shards one pass of the suite gets, so that the passes running at once do not
# oversubscribe the machine. Prints a number from 1 to 6.
#
#   bash test/shard-count.sh [CORES [PASSES]]
#
# CORES defaults to this machine's, PASSES (the suite passes running side by side, the Linux
# container's among them) to 1. Each shard runs one file at a time, but its tests start child
# processes of their own, so a shard needs about two cores: ceil(CORES / (2 * PASSES)). More than
# that and a loaded machine's slowest tests time out, which a rerun does not cure. 6 is the cap:
# the slowest file's weight is a floor on a shard's time, and past it more shards only add startup.
set -u
cores="${1:-$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
passes="${2:-1}"
[ "$cores" -ge 1 ] 2>/dev/null || cores=1
[ "$passes" -ge 1 ] 2>/dev/null || passes=1
n=$(((cores + 2 * passes - 1) / (2 * passes)))
[ "$n" -le 6 ] || n=6
echo "$n"
