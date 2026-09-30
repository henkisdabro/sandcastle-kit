// An invented example: a Python service using uv, ruff, mypy and pytest.

export default {
  name: "billing-service",
  dockerfile: ".sandcastle/Dockerfile",

  // Share the host uv cache so each sandbox's sync reuses downloaded wheels.
  mounts: [{ hostPath: "~/.cache/uv", sandboxPath: "/home/agent/.cache/uv" }],
  setup: ["uv sync --frozen"],

  gates: [
    { name: "lint", command: "uv run ruff check ." },
    { name: "types", command: "uv run mypy src" },
    { name: "test", command: "uv run pytest -q" },
  ],

  rules: ".sandcastle/rules.md",

  // This repo's Claude Code hooks (a ruff-on-edit hook and a secrets guard) are kept;
  // nothing to drop. No skills or MCP servers are needed by a run.
  lean: { keep: [], dropHooks: [] },
};
