// Sandcastle project config - read by sandcastle-kit (https://github.com/henkisdabro/sandcastle-kit).
// Only what differs from the kit's defaults belongs here.

export default {
  name: "my-project",
  // baseBranch: "main",
  // label: "ready-for-agent",
  // concurrency: 4,

  // {{KIT_STACK}}

  rules: ".sandcastle/rules.md",

  // Models and effort differ from the kit's defaults only when set here, per agent.
  // IMPL_* / REVIEW_* env vars still override them for one run. Repair uses implement's.
  // review: { model: "claude-opus-5-5", effort: "medium" },

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
