// What a test needs to pass for a live run now that a run is a process whose command line holds
// the kit's entry (mod/hooks/run-live.ts): a process check that says every pid is the kit, and a
// real process that looks like it to `ps`, for the code that asks the system.
import { spawn, spawnSync } from "node:child_process";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";

/** A process check for code that takes one: every pid is a process of the kit. */
export const everyPidIsTheKit = () => `node ${RUN_COMMAND} run`;

/** A process that sleeps under the kit's command line (`exec -a` sets argv[0], bash 3.2 and 5 alike); kill it when the test is done. */
export const kitLikeProcess = () => {
  const child = spawn("bash", ["-c", `exec -a "node ${RUN_COMMAND}" sleep 600`], { stdio: "ignore" });
  // Returned only once `ps` shows the kit's command line: until bash has exec'd, it reads as
  // `bash -c ...`, and under load a check made at once took the lock from a "live" kit process.
  for (let i = 0; i < 500; i++) {
    const seen = spawnSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" }).stdout ?? "";
    if (seen.includes(RUN_COMMAND)) break;
    spawnSync("sleep", ["0.01"]);
  }
  return Object.assign(child, { pid: child.pid as number });
};
