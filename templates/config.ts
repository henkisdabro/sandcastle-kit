// Sandcastle project config - read by sandcastle-kit (https://github.com/henkisdabro/sandcastle-kit).
// Only what differs from the kit's defaults belongs here.

export default {
  name: "my-project",
  // baseBranch: "main",
  // label: "ready-for-agent",
  // concurrency: 4,

  // Project image layer on top of sandcastle-base (toolchains, browsers, pinned
  // package manager). Omit to run on the base image.
  // dockerfile: ".sandcastle/Dockerfile",

  // Mount the host pnpm store so each sandbox's install hardlinks instead of
  // downloading. `pnpm store path` prints yours: ~/Library/pnpm/store/v11 on
  // macOS, ~/.local/share/pnpm/store/v11 on Linux.
  mounts: [{ hostPath: "~/Library/pnpm/store/v11", sandboxPath: "/home/agent/.pnpm-store" }],
  setup: ["pnpm config set store-dir /home/agent/.pnpm-store", "pnpm install --frozen-lockfile"],

  gates: [
    { name: "lint", command: "pnpm run lint" },
    { name: "build", command: "pnpm run build" },
    { name: "test", command: "pnpm test" },
  ],

  rules: ".sandcastle/rules.md",

  // A red gate gets this many repair passes, fed its output. 0 turns it off.
  // repair: { attempts: 1 },

  // Sandboxes load NONE of the repo's skills, agents, commands, MCP servers or
  // plugins unless kept here. Keep only what a run literally needs (e.g. a
  // skill rules.md tells agents to use). Every hook is KEPT - they enforce the
  // repo's rules; dropHooks removes host-only conveniences by a substring of
  // their command, each with a comment saying why. `sandcastle lean` checks both.
  lean: {
    keep: [],
    dropHooks: [
      // "rtk hook claude", // host-only token compressor; not in the image
    ],
  },
};
