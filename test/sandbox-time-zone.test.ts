// Every sandbox gets the host's time zone as TZ, so an agent's commits are dated in the same
// offset as the host's merges. Temp dirs only, no Docker, no network.
//
//   pnpm test:file test/sandbox-time-zone.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { sandboxEnv, sandboxConfig } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const project = { root: mkdtempSync(join(tmpdir(), "sandcastle-tz-")), tracker: fakeTracker() } as unknown as Project;

test("the sandbox env carries the host's IANA time zone as TZ", () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Australia/Perth";
    assert.equal(sandboxEnv(project).TZ, "Australia/Perth");
    process.env.TZ = "America/New_York";
    assert.equal(sandboxEnv(project).TZ, "America/New_York");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("the host's resolved zone is used when TZ is not set, as on a Mac", () => {
  const saved = process.env.TZ;
  try {
    delete process.env.TZ;
    assert.equal(sandboxEnv(project).TZ, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally {
    if (saved !== undefined) process.env.TZ = saved;
  }
});

test("the zone reaches every sandbox through sandboxConfig", () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    const config = sandboxConfig({ ...project, mounts: [], setup: [] } as unknown as Project, "image", "plan");
    assert.equal(JSON.stringify(config).includes('"TZ":"Asia/Tokyo"'), true);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});
