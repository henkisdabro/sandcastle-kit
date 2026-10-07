// A `docker` that answers at once, for a test that starts the full `sandcastle doctor` with the host's
// PATH: without it the test reaches the machine's real Docker, and a slow or silent daemon outlasts the
// child's time limit (`docker info` waits up to 30 s). It plays a Docker whose daemon is stopped:
// `--version` works, everything else fails at once. Every call's arguments are appended to `calls`.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** A directory holding only the stub `docker`, and the file its calls are recorded in. Put it first on PATH. */
export const dockerStub = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-docker-stub-"));
  const calls = join(dir, "calls");
  const script = join(dir, "docker");
  writeFileSync(script, `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$1" = --version ] && echo "Docker version 29" && exit 0\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n`);
  chmodSync(script, 0o755);
  return { dir, calls, first: (path: string | undefined) => [dir, path ?? ""].join(delimiter) };
};
