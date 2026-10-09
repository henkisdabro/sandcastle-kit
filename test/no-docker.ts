// A `docker` that lists nothing and does nothing, first on PATH, for a test that drives a sandbox's close or a pause
// with fake sandboxes: the close first stops the sandbox's container (`stopSandboxContainer` asks `docker ps`), and on
// a developer's machine the real Docker answered slowly enough that the close finished after a test had checked it.
// Call it before the kit's modules load. A test that needs a `docker` of its own puts it on PATH itself.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const useNoDocker = () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-no-docker-"));
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
};
