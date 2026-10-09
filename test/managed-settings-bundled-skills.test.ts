// The managed settings switch off Claude Code's bundled skills (`schedule`, `loop`, `design-sync`,
// `deep-research` and others): about 19 of them are listed in every sandbox session, cost prompt
// tokens in every pass and invite actions that make no sense unattended. The repo's own skills stay.
//
//   pnpm test:file test/managed-settings-bundled-skills.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { KIT, MANAGED_SETTINGS, sandboxMounts } from "../src/sandbox.ts";

// The settings file as the sandbox gets it: found through the read-only mount of container/.
const mount = sandboxMounts({ mounts: [] } as unknown as Project).find((m) => m.sandboxPath === MANAGED_SETTINGS);
const settings = JSON.parse(readFileSync(join(mount!.hostPath, "managed-settings.json"), "utf8"));

test("a sandbox's Claude Code lists none of its bundled skills", () => {
  assert.equal(settings.disableBundledSkills, true);
});

test("the repo's own skills are not denied", () => {
  const deny: string[] = settings.permissions.deny;
  assert.deepEqual(
    deny.filter((rule) => rule.startsWith("Skill")),
    [],
  );
  assert.equal(settings.skillOverrides, undefined);
});

test("the lean line at the start of a run says its count covers the repo's items, not the bundled skills", () => {
  const source = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
  assert.match(source, /`Lean: hiding [^\n]*\n[^\n]*keeping[^\n]*\n(?:[^\n]*\/\/[^\n]*\n)?\s*"; Claude Code's bundled skills off"/);
});
