// An invented example: a TypeScript web app using pnpm, Vitest and Playwright.

export default {
  name: "shopfront",
  dockerfile: ".sandcastle/Dockerfile",

  // The host's pnpm store, mounted into each sandbox; the kit asks `pnpm store path` at run time.
  pnpmStore: true,
  setup: ["pnpm install --frozen-lockfile"],

  gates: [
    { name: "lint", command: "pnpm run lint" },
    { name: "typecheck", command: "pnpm run typecheck" },
    { name: "test", command: "pnpm test" },
    { name: "e2e", command: "pnpm run test:e2e" },
  ],

  rules: ".sandcastle/rules.md",

  lean: {
    // Agents are told in rules.md to use this skill to check UI changes.
    keep: ["skill:ui-check"],
    dropHooks: [
      "notify-send", // desktop notification on the host; nothing to notify in a sandbox
    ],
  },
};
