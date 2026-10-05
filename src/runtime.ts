// The container runtimes and users a run cannot work with, said before anything starts: doctor
// prints it as a FIX line and `sandcastle run` refuses with it. Every read goes through `Reads`,
// so a test hands in captured `docker` output and needs no Linux host, no Podman and no root.

import { spawnSync } from "node:child_process";

/** The parked ticket for Podman and rootless Docker on Linux, named in every refusal. */
export const PODMAN_TICKET = "#359";

export type Reads = {
  /** `docker --version`, stdout trimmed; undefined on a non-zero exit. */
  version: () => string | undefined;
  /** `docker version --format '{{json .Server}}'`; `null` under `podman-docker`. */
  server: () => string | undefined;
  /** `docker info --format '{{json .SecurityOptions}}'`; exit 125 under `podman-docker`. */
  securityOptions: () => string | undefined;
};

export type Problem = { label: string; fix: string };

const read = (args: string[]) => () => {
  const r = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

export const realReads = (): Reads => ({
  version: read(["--version"]),
  server: read(["version", "--format", "{{json .Server}}"]),
  securityOptions: read(["info", "--format", "{{json .SecurityOptions}}"]),
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

const securityOptions = (text: string | undefined): string[] => {
  const list = json(text);
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
  const podman = /^podman version/.test(reads.version() ?? "") || components(json(reads.server())).includes("Podman Engine");
  if (podman) {
    return {
      label: "Docker Engine behind `docker` (found Podman)",
      fix:
        `Podman behind \`docker\` is not supported on Linux yet (${PODMAN_TICKET}): the kit needs rootful Docker Engine (https://docs.docker.com/engine/install/), ` +
        "and `docker` must be Docker's own CLI on its socket - check `docker context ls` and DOCKER_HOST.",
    };
  }
  const options = securityOptions(reads.securityOptions());
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

/** `runtimeProblem` for this process and machine. */
export const runtimeProblemNow = (): Problem | undefined =>
  runtimeProblem({ platform: process.platform, uid: process.getuid?.(), reads: realReads() });
