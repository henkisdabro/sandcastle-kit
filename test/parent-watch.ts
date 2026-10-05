// Preloaded into every node process test/cli-spawn.ts starts (`--import`): the process ends itself
// once the test process that started it is gone, so a test run killed outright (SIGKILL runs no
// handler in the parent) leaves no fixture behind, alive with parent pid 1 for days.
//
// The helper sets SANDCASTLE_TEST_PARENT to the test process's pid. It counts only where that is
// this process's own parent at the start: a process this one starts in turn (`sandcastle run
// --detach` passes its execArgv, and so this preload, to the run it detaches; node's test runner
// does the same for each test file) has another parent, and is not watched - the detached run is
// meant to outlive the process that started it. The variable is dropped once read, for whatever
// this process starts next.

export {};
const testPid = Number(process.env.SANDCASTLE_TEST_PARENT);
delete process.env.SANDCASTLE_TEST_PARENT;

if (testPid > 0 && process.ppid === testPid) {
  // unref: the check must not be what keeps a finished process alive.
  setInterval(() => {
    // A reparented process (to init, or a subreaper) has a different parent pid.
    if (process.ppid !== testPid) process.kill(process.pid, "SIGKILL");
  }, 500).unref();
}
