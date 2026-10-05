// The container runtimes and users a run cannot work with, said before anything starts: doctor
// prints it as a FIX line and `sandcastle run` refuses with it. Every read goes through `Reads`,
// so a test hands in captured `docker` output and needs no Linux host, no Podman and no root.
//
// A start asks the daemon once (`readDockerInfo`): the runtime check, the sandbox CPU limit and the
// pool warning share that one answer, and a daemon that gives none within DOCKER_ANSWER_MS stops
// the run with a message, where a hung one used to stall the start for minutes in silence.

import { spawnSync } from "node:child_process";
import { OperatorError } from "./errors.ts";

/** The parked ticket for Podman and rootless Docker on Linux, named in every refusal. */
export const PODMAN_TICKET = "#359";

export type Reads = {
  /** `docker --version`, stdout trimmed; undefined on a non-zero exit. */
  version: () => string | undefined;
  /** `docker version --format '{{json .Server}}'`; `null` under `podman-docker`. */
  server: () => string | undefined;
  /** `docker info --format '{{json .}}'`: the one read of the daemon a start makes. Its `SecurityOptions` say rootless. */
  info: () => string | undefined;
};

export type Problem = { label: string; fix: string };

/** Where a detached run's parent hands its `docker info` reading to the child it starts (src/detach.ts, src/cli.ts). */
export const DOCKER_INFO_ENV = "SANDCASTLE_DOCKER_INFO";

/** How long `docker` has to answer a read of the daemon before it counts as hung. */
export const DOCKER_ANSWER_MS = 10_000;

/**
 * One `docker` read, stdout trimmed; undefined on a non-zero exit (not installed, no daemon, a field
 * the runtime lacks), which a caller takes as no answer worth acting on. A `docker` that is still
 * silent after `DOCKER_ANSWER_MS` is the one failure that stops the run: it started and never replied,
 * and going on would only meet the same daemon in the image check, minutes later.
 */
const read = (args: string[]) => () => {
  const r = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: DOCKER_ANSWER_MS });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new OperatorError(`docker did not answer within ${DOCKER_ANSWER_MS / 1000} s - is the runtime running?`);
  }
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** `docker info --format '{{json .}}'`, once per call: a start takes it once and hands it to everything that needs it. Throws an `OperatorError` when docker does not answer in time. */
export const readDockerInfo = (): string | undefined => read(["info", "--format", "{{json .}}"])() || undefined;

/** The real reads; `info` is the start's one reading when it already has one. */
export const realReads = (info: () => string | undefined = readDockerInfo): Reads => ({
  version: read(["--version"]),
  server: read(["version", "--format", "{{json .Server}}"]),
  info,
});

// Each read is defensive: a runtime that prints something else is not a reason to crash doctor.
const json = (text: string | undefined): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

const components = (server: unknown): string[] => {
  const list = (server as { Components?: unknown } | null | undefined)?.Components;
  return Array.isArray(list) ? list.map((c) => (c as { Name?: unknown } | null)?.Name).filter((n): n is string => typeof n === "string") : [];
};

const securityOptions = (info: unknown): string[] => {
  const list = (info as { SecurityOptions?: unknown } | null | undefined)?.SecurityOptions;
  return Array.isArray(list) ? list.filter((o): o is string => typeof o === "string") : [];
};

/**
 * Why a run cannot work here, or undefined when nothing known stops it. Root fails everywhere:
 * the agent gets the operator's uid and Claude Code refuses `--dangerously-skip-permissions` as
 * root. Podman and rootless or remapped Docker fail on Linux only, where the agent's uid maps to a
 * subuid and the bind-mounted worktree reads as root-owned; macOS's runtimes run in a VM whose
 * file sharing does not, and Podman Desktop's Docker Compatibility reports `name=rootless` there.
 * Podman is checked first, so a rootless Podman socket is named as Podman.
 */
export const runtimeProblem = ({ platform, uid, reads }: { platform: NodeJS.Platform; uid: number | undefined; reads: Reads }): Problem | undefined => {
  if (uid === 0) {
    return {
      label: "sandcastle run as a normal user, not root",
      fix:
        `Run sandcastle as a normal user${platform === "linux" ? " in the docker group (`sudo usermod -aG docker $USER`, then log in again)" : ""}, not as root or with sudo: ` +
        "the agent gets your uid, and Claude Code refuses `--dangerously-skip-permissions` as root.",
    };
  }
  if (platform !== "linux") return undefined;
  // Asked first: a daemon that hangs is met by the read every start makes anyway, before the others.
  const info = json(reads.info());
  const podman = /^podman version/.test(reads.version() ?? "") || components(json(reads.server())).includes("Podman Engine");
  if (podman) {
    return {
      label: "Docker Engine behind `docker` (found Podman)",
      fix:
        `Podman behind \`docker\` is not supported on Linux yet (${PODMAN_TICKET}): the kit needs rootful Docker Engine (https://docs.docker.com/engine/install/), ` +
        "and `docker` must be Docker's own CLI on its socket - check `docker context ls` and DOCKER_HOST.",
    };
  }
  const options = securityOptions(info);
  const rootless = options.includes("name=rootless");
  if (rootless || options.includes("name=userns")) {
    return {
      label: `rootful Docker Engine (found ${rootless ? "rootless Docker" : "Docker with userns-remap"})`,
      fix:
        `${rootless ? "Rootless Docker" : "Docker's userns-remap"} is not supported yet (${PODMAN_TICKET}): the agent's uid maps to a subuid, so it cannot write the bind-mounted worktree. ` +
        `Use rootful Docker Engine${rootless ? " (`docker context use default`, or unset DOCKER_HOST if it selects a rootless daemon)" : " (remove `userns-remap` from the daemon's daemon.json and restart it)"}.`,
    };
  }
  return undefined;
};

/**
 * `runtimeProblem` for this process and machine, over `info`, the start's one `docker info` reading
 * (doctor, which takes none, reads its own). Throws an `OperatorError` when docker does not answer.
 */
export const runtimeProblemNow = (info?: () => string | undefined): Problem | undefined =>
  runtimeProblem({ platform: process.platform, uid: process.getuid?.(), reads: realReads(info) });
