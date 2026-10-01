// `sandcastle init`: scaffold .sandcastle/ with gates guessed from the stack.
//
// The template's pnpm gates were right for one kind of repo and a silent
// trap for every other: a Python repo got `pnpm run lint` and learned about
// it from a red first run. The files at the root say what the stack is;
// the gates written from them are a starting point to check against CI, not
// a verdict.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { CONFIG_PATH } from "./config.ts";
import { KIT } from "./sandbox.ts";
import { OperatorError } from "./errors.ts";

type Stack = { label: string; block: string; dockerfile?: string };

const gatesBlock = (gates: [string, string][]) =>
  `  gates: [\n${gates.map(([name, command]) => `    { name: ${JSON.stringify(name)}, command: ${JSON.stringify(command)} },`).join("\n")}\n  ],`;

// The project layer for a toolchain the base image lacks. COPY --from an
// official image needs no build context, which the kit's builds do not have.
const layer = (lines: string) =>
  `# Project layer on sandcastle-base, written by \`sandcastle init\`.\nARG BASE=sandcastle-base:latest\nFROM \${BASE}\n\n${lines}\n`;

const node = (root: string): Stack | undefined => {
  if (!existsSync(join(root, "package.json"))) return undefined;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  const has = (f: string) => existsSync(join(root, f));
  const pm = has("pnpm-lock.yaml") ? "pnpm"
    : has("yarn.lock") ? "yarn"
    : has("bun.lock") || has("bun.lockb") ? "bun"
    : has("package-lock.json") ? "npm"
    : (pkg.packageManager?.split("@")[0] ?? "npm");
  // A frozen install needs a lockfile to be frozen against; Yarn 1 spells
  // it --frozen-lockfile, Yarn Berry (`__metadata:` in yarn.lock) --immutable.
  const locked = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"].some(has);
  const berry = has("yarn.lock") && readFileSync(join(root, "yarn.lock"), "utf8").includes("__metadata:");
  const frozen = { pnpm: "pnpm install --frozen-lockfile", yarn: berry ? "yarn install --immutable" : "yarn install --frozen-lockfile", bun: "bun install --frozen-lockfile", npm: "npm ci" }[pm];
  // Without a lockfile, an install that writes one leaves every sandbox's
  // worktree with an uncommitted file, which Sandcastle then keeps.
  const unlocked = { pnpm: "pnpm install --no-lockfile", yarn: "yarn install --no-lockfile", bun: "bun install --no-save", npm: "npm install --no-package-lock" }[pm];
  const install = (locked ? frozen : unlocked) || `${pm} install`;
  const scripts = pkg.scripts ?? {};
  // npm init's placeholder test script fails by design; it is not a gate.
  const real = (name: string) => scripts[name] !== undefined && !/no test specified/.test(scripts[name]);
  const names = ["lint", "typecheck", "type-check", "check", "build", "test"].filter(real);
  const gates: [string, string][] = names.map((n) => [n, `${pm} run ${n}`]);
  if (!gates.length) gates.push(["test", `${pm} test`]);

  let mounts = "";
  let setup = [install];
  if (pm === "pnpm") {
    // The host store, so each sandbox's install hardlinks instead of downloading.
    let store = platform() === "darwin" ? "~/Library/pnpm/store/v11" : "~/.local/share/pnpm/store/v11";
    try {
      store = execFileSync("pnpm", ["store", "path"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 })
        .trim()
        .replace(homedir(), "~");
    } catch {
      /* pnpm not on the host - the platform default */
    }
    mounts = `  mounts: [{ hostPath: ${JSON.stringify(store)}, sandboxPath: "/home/agent/.pnpm-store" }],\n`;
    setup = ["pnpm config set store-dir /home/agent/.pnpm-store", install];
  }
  return {
    label: `Node (${pm}; scripts: ${names.join(", ") || "none - check the test gate"})`,
    block: `${mounts}  setup: [${setup.map((c) => JSON.stringify(c)).join(", ")}],\n${gatesBlock(gates)}`,
    dockerfile: pm === "bun" ? layer("# Bun, which the base image lacks.\nCOPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun") : undefined,
  };
};

const python = (root: string): Stack | undefined => {
  if (!existsSync(join(root, "pyproject.toml")) || !existsSync(join(root, "uv.lock"))) return undefined;
  const text = readFileSync(join(root, "pyproject.toml"), "utf8");
  const gates: [string, string][] = [];
  if (/\bruff\b/.test(text)) gates.push(["lint", "uv run ruff check ."]);
  if (/\bmypy\b/.test(text)) gates.push(["types", "uv run mypy ."]);
  if (/\bpytest\b/.test(text) || !gates.length) gates.push(["test", "uv run pytest -q"]);
  return {
    label: `Python (uv; ${gates.map(([n]) => n).join(", ")})`,
    block:
      `  // Share the host uv cache so each sandbox's sync reuses downloaded wheels.\n` +
      `  mounts: [{ hostPath: "~/.cache/uv", sandboxPath: "/home/agent/.cache/uv" }],\n` +
      `  setup: ["uv sync --frozen"],\n${gatesBlock(gates)}`,
    dockerfile: layer("# uv, which fetches the Python the project pins.\nCOPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/"),
  };
};

const go = (root: string): Stack | undefined =>
  existsSync(join(root, "go.mod"))
    ? {
        label: "Go",
        block: `  setup: ["go mod download"],\n${gatesBlock([["vet", "go vet ./..."], ["build", "go build ./..."], ["test", "go test ./..."]])}`,
        // go.mod's toolchain line makes this Go fetch the exact version needed.
        dockerfile: layer(
          "# Go, which the base image lacks.\nCOPY --from=golang:1-trixie /usr/local/go /usr/local/go\n" +
            'ENV PATH="/usr/local/go/bin:/home/agent/go/bin:$PATH"',
        ),
      }
    : undefined;

const rust = (root: string): Stack | undefined =>
  existsSync(join(root, "Cargo.toml"))
    ? {
        label: "Rust",
        block: `  setup: ["cargo fetch"],\n${gatesBlock([["clippy", "cargo clippy --all-targets -- -D warnings"], ["test", "cargo test"]])}`,
        // rustup honours a rust-toolchain.toml in the repo.
        dockerfile: layer(
          "# Rust, which the base image lacks.\n" +
            "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy\n" +
            'ENV PATH="/home/agent/.cargo/bin:$PATH"',
        ),
      }
    : undefined;

// No stack detected: gates that fail, saying why, rather than a guess. A pnpm
// guess in a project without pnpm failed at setup, far from its cause, and a
// gate that happened to pass would vouch for nothing.
const FALLBACK = `  // Project image layer on top of sandcastle-base (toolchains, browsers, pinned
  // package manager). Omit to run on the base image.
  // dockerfile: ".sandcastle/Dockerfile",

  // Commands run once in each fresh sandbox before any agent, e.g. installing dependencies.
  setup: [],

  // What CI runs, in order. Until these are filled in, every run stops at its base check.
  gates: [
    { name: "gates-not-set", command: "echo 'No gates yet: set them in .sandcastle/config.ts' >&2; exit 1" },
  ],`;

// The branch runs land on. origin/HEAD says what the remote treats as default;
// without a remote, the checked-out branch is the best evidence (symbolic-ref
// still answers on an unborn branch, and fails when detached or outside a repo).
export const detectBaseBranch = (root: string): string | undefined => {
  const ask = (ref: string[]) => {
    try {
      return execFileSync("git", ["symbolic-ref", "--quiet", "--short", ...ref], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  return (ask(["refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") || ask(["HEAD"])) || undefined;
};

export const init = (root: string) => {
  if (existsSync(join(root, CONFIG_PATH))) {
    throw new OperatorError(
      `${CONFIG_PATH} already exists. To start over, move it aside (git keeps the old one) and run \`sandcastle init\` again; to update an existing project, use /sandcastle update.`,
    );
  }
  mkdirSync(join(root, ".sandcastle"), { recursive: true });

  const stack = [node, python, go, rust].map((detect) => detect(root)).find(Boolean);
  const dockerfile = stack?.dockerfile && !existsSync(join(root, ".sandcastle/Dockerfile"));
  const block = stack
    ? `  // Detected: ${stack.label}. A starting point - check each command against CI.\n` +
      (stack.dockerfile ? `  dockerfile: ".sandcastle/Dockerfile",\n\n` : "") +
      stack.block
    : FALLBACK;
  // Docker image names are lowercase [a-z0-9._-].
  const name = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "my-project";
  // A repo whose base is not main would otherwise refuse its first run with "expected main".
  const base = detectBaseBranch(root);
  let config = readFileSync(join(KIT, "templates/config.ts"), "utf8")
    .replace('"my-project"', () => JSON.stringify(name))
    .replace("  // {{KIT_STACK}}", () => block);
  if (base && base !== "main") config = config.replace('  // baseBranch: "main",', () => `  baseBranch: ${JSON.stringify(base)},`);
  writeFileSync(join(root, CONFIG_PATH), config);
  if (dockerfile) writeFileSync(join(root, ".sandcastle/Dockerfile"), stack!.dockerfile!);
  if (!existsSync(join(root, ".sandcastle/rules.md"))) copyFileSync(join(KIT, "templates/rules.md"), join(root, ".sandcastle/rules.md"));

  // Sandcastle's working files never belong in the repo.
  const ignore = join(root, ".sandcastle/.gitignore");
  const want = [".env", "logs/", "worktrees/", ".run/", "triage/"];
  const have = existsSync(ignore) ? readFileSync(ignore, "utf8").split("\n") : [];
  const add = want.filter((w) => !have.includes(w));
  if (add.length) appendFileSync(ignore, add.join("\n") + "\n");

  console.log(
    `Wrote ${CONFIG_PATH}${dockerfile ? ", .sandcastle/Dockerfile" : ""} and .sandcastle/rules.md.\n` +
      (stack
        ? `Detected ${stack.label} - gates and setup are filled in from it; check them against what CI runs.`
        : "No known stack detected (package.json, pyproject.toml + uv.lock, go.mod, Cargo.toml). The gates are a placeholder that " +
          "fails, so no run starts until you fill in gates and setup.") +
      "\nNext, in order: `sandcastle build`, `sandcastle lean`, `sandcastle gates`." +
      "\nAgents only work on queued tickets, so file issues (or ticket files) for the work, then triage them into the queue with " +
      "`/sandcastle queue` (the queue label is `label` in .sandcastle/config.ts, default ready-for-agent).\n",
  );
};
