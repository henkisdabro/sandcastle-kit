// Sandcastle project config - read by sandcastle-kit (https://github.com/henkisdabro/sandcastle-kit).
// Only what differs from the kit's defaults belongs here. Every other key is listed commented out,
// at its default or with an example, as in templates/config.ts; README -> Configuration says what each does.

export default {
  name: "sandcastle-kit",
  // baseBranch: "main",
  // label: "ready-for-agent",
  // concurrency: 4,
  // cpus: 2,                               // per sandbox; unset shares the VM's CPUs out, false lifts the limit
  // land: "merge",                         // or "squash": one commit per ticket on the base branch
  // autonomy: 0,                           // 1 asks to re-run conflicted and unblocked tickets; 2 or 3 re-run them
  // autonomy: "drain",                     // runs turns until the queue is drained or a stop condition holds (20 at most)
  // keepWarm: true,                        // false: the session that started the run stops keeping its prompt cache warm
  // herdr: { panes: "none" },              // "all": a Herdr pane per sandbox (SANDBOX_PANES)

  // A run pauses at 95% of a plan window and resumes after its reset, rather than stopping its
  // queue when an agent hits the limit. USAGE_PAUSE overrides it for one run.
  usagePause: 95,

  // Agents and gates get the latest Claude Code, not the stable channel: the mod's own tests
  // (`pnpm test`) skip below the version `stable` carries, so a ticket that changes mod/ would
  // land with them never run. Only this repo needs it; other projects keep the default.
  claudeCode: "latest",
  // autoCompactWindow: 400000,             // tokens at which a sandbox's Claude agent compacts; unset: Claude Code's default

  // Where tickets live. Unset, the kit reads docs/agents/issue-tracker.md (written by
  // Matt Pocock's /setup-matt-pocock-skills, if you ran it) and otherwise uses GitHub.
  // tracker: "github",
  // tracker: "files",                      // .scratch/<feature>/issues/NN-<slug>.md, `Status:` line
  // tracker: { type: "files", dir: "tickets", done: ["done", "shipped"] },
  // Extra things a ticket may wait for: Linear issues, ticket files. README -> Blockers.
  // blockers: { linear: ["ENG"] },

  // Adds gitleaks: the repo's pre-commit hook refuses every commit without it.
  dockerfile: ".sandcastle/Dockerfile",

  // The same checks as .github/workflows/check.yml - AGENTS.md -> "Verifying a change".
  pnpmStore: true,
  setup: ["pnpm install --frozen-lockfile"],
  gates: [
    { name: "lint", command: "pnpm run lint" },
    { name: "typecheck", command: "pnpm run typecheck" },
    { name: "shell-syntax", command: "bash -n status.sh bin/sandcastle .githooks/pre-commit container/git-guard.sh" },
    { name: "test", command: "pnpm run test" },
  ],

  // Extra bind mounts; never the project root, .sandcastle/ or .git.
  // mounts: [{ hostPath: "~/.cache/my-tool", sandboxPath: "/home/agent/.cache/my-tool", readonly: true }],

  // The site's renderer copy, held to src/ by test/site-renderer-copy.test.ts: two tickets that both
  // change the status renderer would otherwise conflict on it and neither would land.
  generated: [{ paths: ["site/js/status-render.js"], regen: "pnpm site:renderer" }],

  // Paths a branch may not change and still land by itself, on top of the kit's own list.
  // protectedPaths: ["migrations/"],

  rules: ".sandcastle/rules.md",

  // rules.md keeps agents out of CHANGELOG.md: they give each line in a <changelog> tag instead,
  // and the closing summary lists the lines of the tickets that merged.
  changelog: true,

  // Models and effort differ from the kit's defaults only when set here, per agent.
  // IMPL_* / REVIEW_* env vars still override them for one run. Repair uses implement's.
  // implement: { model: "claude-sonnet-5-5", effort: "high" },
  // Review at high effort: in three runs at medium, 2 of 24 reviews committed a fix (about 1 in 2 at
  // high), and one passed a race its implementer's own check had flagged.
  review: { model: "claude-opus-5-5", effort: "high" },

  // A red gate gets this many repair passes, fed its output. 0 turns it off.
  // repair: { attempts: 1 },

  // Proof that each kept PreToolUse guard blocks what it should: a made-up tool
  // call handed to the matching hooks in the base-gate sandbox (no model call).
  // hookTests: [
  //   { name: "guard refuses X", tool: "Write", input: { file_path: "a", content: "b" }, expect: "block" },
  // ],

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
