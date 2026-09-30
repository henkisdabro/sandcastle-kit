// An invented example: a TypeScript web app using pnpm, Vitest and Playwright.

export default {
  name: "shopfront",
  dockerfile: ".sandcastle/Dockerfile",

  // `pnpm store path` on the host; this is the macOS default.
  mounts: [{ hostPath: "~/Library/pnpm/store/v11", sandboxPath: "/home/agent/.pnpm-store" }],
  setup: ["pnpm config set store-dir /home/agent/.pnpm-store", "pnpm install --frozen-lockfile"],

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
