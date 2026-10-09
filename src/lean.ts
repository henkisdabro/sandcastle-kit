// Lean sandboxes. Every skill, agent and command a repo ships is listed in
// every sandbox agent's context, and every MCP server adds its tool schemas -
// paid on every turn of every run, whether the task needs them or not. The
// container has no user-level ~/.claude (only the kit's managed git guard, which costs no
// context), so the repo's own config is all an agent loads. This module inventories it, hides everything the project has
// not explicitly kept, and can measure what that saves.
//
// Kept items are named in `.sandcastle/config.ts` -> `lean.keep`:
//   "skill:verify"  "agent:x"  "command:y"  "mcp:server-name"
//   "codex-skill:x" (Codex reads .agents/skills)  "codex-config" (.codex/config.toml)
// Plugins are never kept: the container cannot install them, and an
// enabledPlugins entry only costs a failed install attempt.
//
// HOOKS ARE THE OPPOSITE. They cost no context and they are enforcement -
// guards, linters, test gates, audit logs - so every hook in the project's
// .claude/settings.json is KEPT. `lean.dropHooks` removes a hook whose command
// contains one of its strings; that is for host-only conveniences (rtk, a
// preview server, a notification), never for a guard. checkHooks() proves each
// kept hook can run in the image before any sandbox starts.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { IMPL_MODEL } from "./agents.ts";
import type { Project } from "./config.ts";
import { credentials, sh } from "./sandbox.ts";

export type Item = {
  kind: "skill" | "agent" | "command" | "mcp" | "plugin" | "hook" | "codex-skill" | "codex-config" | "setting";
  id: string;
  path: string;
  /** Rough tokens in every agent's context before anything is invoked; undefined = unknown. */
  tokens?: number;
  kept: boolean;
};

/** A kept Claude Code hook, as it will run in the sandbox. */
export type Hook = { event: string; matcher: string; command: string };

export type Plan = { hide: string[]; write: Record<string, string>; items: Item[]; hooks: Hook[] };

const tracked = (root: string, path: string) =>
  sh("git", ["ls-files", "--", path], root).split("\n").filter(Boolean);

const children = (root: string, dir: string) =>
  [...new Set(tracked(root, dir).map((f) => f.slice(dir.length + 1).split("/")[0]))];

// name + description is what sits in context until a skill or agent is used.
const frontmatterTokens = (file: string): number | undefined => {
  if (!existsSync(file)) return undefined;
  // A command or agent folder (`.claude/commands/audit/`): each .md in it is listed.
  if (lstatSync(file).isDirectory()) {
    return sh("git", ["ls-files", "--", "."], file)
      .split("\n")
      .filter((f) => f.endsWith(".md"))
      .reduce((n, f) => n + (frontmatterTokens(join(file, f)) ?? 0), 0);
  }
  const head = readFileSync(file, "utf8").split(/^---$/m)[1] ?? "";
  let take = false;
  let text = "";
  for (const line of head.split("\n")) {
    const key = line.match(/^([\w-]+):/)?.[1];
    if (key) take = key === "name" || key === "description";
    if (take) text += line;
  }
  return Math.ceil(text.length / 4) + 10;
};

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

// Settings keys that load something, as opposed to permissions, env and hooks.
const LOADERS = ["enabledPlugins", "extraKnownMarketplaces", "enableAllProjectMcpServers", "enabledMcpjsonServers", "statusLine"];

type HookGroup = { matcher?: string; hooks: { type: string; command?: string }[] };

export const plan = (project: Project): Plan => {
  const root = project.root;
  const keep = new Set(project.lean.keep);
  const dropHooks = project.lean.dropHooks ?? [];
  const items: Item[] = [];
  const hooks: Hook[] = [];
  const hide: string[] = [];
  const write: Record<string, string> = {};

  // Only what the harness loads is an item: a skill is a directory with a
  // SKILL.md, an agent or command a .md file or a folder of them. A stray
  // file (a pyrightconfig.json among the skills) is neither listed nor hidden:
  // the harness never loads it, so hiding saves no tokens, and a tool that
  // reads it (`pyright -p .claude/skills`) would lose its config. `work.md`
  // and `work/` are one command, kept or hidden together.
  const dirOf = (kind: Item["kind"], dir: string, loads: (name: string) => string | undefined) => {
    const byId = new Map<string, Item & { paths: string[] }>();
    for (const name of children(root, dir)) {
      const path = `${dir}/${name}`;
      const file = loads(name);
      if (!file) continue;
      const id = name.replace(/\.md$/, "");
      const item = byId.get(id);
      const tokens = frontmatterTokens(join(root, file));
      if (item) {
        item.paths.push(path);
        if (tokens !== undefined) item.tokens = (item.tokens ?? 0) + tokens;
      } else {
        byId.set(id, { kind, id, path, tokens, kept: keep.has(`${kind}:${id}`), paths: [path] });
      }
    }
    for (const { paths, ...item } of byId.values()) {
      items.push(item);
      if (!item.kept) hide.push(...paths);
    }
  };
  const isDir = (path: string) => existsSync(join(root, path)) && lstatSync(join(root, path)).isDirectory();
  const skill = (dir: string) => (n: string) => (existsSync(join(root, dir, n, "SKILL.md")) ? `${dir}/${n}/SKILL.md` : undefined);
  const markdown = (dir: string) => (n: string) => (n.endsWith(".md") || isDir(`${dir}/${n}`) ? `${dir}/${n}` : undefined);
  dirOf("skill", ".claude/skills", skill(".claude/skills"));
  dirOf("agent", ".claude/agents", markdown(".claude/agents"));
  dirOf("command", ".claude/commands", markdown(".claude/commands"));
  dirOf("codex-skill", ".agents/skills", skill(".agents/skills"));

  // A kept item that is a symlink (`.claude/skills/x -> ../../.agents/skills/x`)
  // keeps its target too, or it would point at a deleted directory.
  for (const item of items.filter((i) => i.kept)) {
    const full = join(root, item.path);
    if (!existsSync(full) || !lstatSync(full).isSymbolicLink()) continue;
    const target = relative(root, realpathSync(full));
    for (let k = hide.length - 1; k >= 0; k--) {
      if (target === hide[k] || target.startsWith(hide[k] + "/")) hide.splice(k, 1);
    }
  }

  // Project MCP servers: each one's tool schemas land in context in full.
  const mcp = tracked(root, ".mcp.json").length ? readJson(join(root, ".mcp.json")) : undefined;
  if (mcp) {
    const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
    const keptServers = Object.fromEntries(Object.entries(servers).filter(([name]) => keep.has(`mcp:${name}`)));
    for (const name of Object.keys(servers)) {
      items.push({ kind: "mcp", id: name, path: ".mcp.json", kept: name in keptServers });
    }
    if (Object.keys(keptServers).length === 0) hide.push(".mcp.json");
    else if (Object.keys(keptServers).length < Object.keys(servers).length) {
      write[".mcp.json"] = JSON.stringify({ ...mcp, mcpServers: keptServers }, null, 2) + "\n";
    }
  }

  if (tracked(root, ".codex/config.toml").length) {
    const kept = keep.has("codex-config");
    items.push({ kind: "codex-config", id: "config.toml", path: ".codex/config.toml", kept });
    if (!kept) hide.push(".codex/config.toml");
  }

  // Settings stay - permissions and env are the project's own - minus what loads things. An ask rule
  // among them is refused in a sandbox, where nobody can answer: the report names those (askRuleLines).
  const settingsPath = ".claude/settings.json";
  const settings = tracked(root, settingsPath).length ? readJson(join(root, settingsPath)) : undefined;
  if (settings) {
    const lean: Record<string, unknown> = { ...settings };
    for (const key of LOADERS) {
      if (!(key in settings)) continue;
      if (key === "enabledPlugins") {
        for (const id of Object.keys(settings[key] as object)) items.push({ kind: "plugin", id, path: settingsPath, kept: false });
      } else {
        items.push({ kind: "setting", id: key, path: settingsPath, kept: false });
      }
      delete lean[key];
    }
    // Hooks: kept one by one, minus the commands lean.dropHooks names.
    let dropped = 0;
    if (settings.hooks) {
      const kept: Record<string, HookGroup[]> = {};
      for (const [event, groups] of Object.entries(settings.hooks as Record<string, HookGroup[]>)) {
        const keptGroups = groups
          .map((g) => ({
            ...g,
            hooks: g.hooks.filter((h) => {
              const drop = !!h.command && dropHooks.some((d) => h.command!.includes(d));
              const id = `${event}${g.matcher ? `[${g.matcher}]` : ""} ${h.command ?? h.type}`;
              items.push({ kind: "hook", id, path: settingsPath, kept: !drop });
              if (drop) dropped++;
              else if (h.command) hooks.push({ event, matcher: g.matcher ?? "*", command: h.command });
              return !drop;
            }),
          }))
          .filter((g) => g.hooks.length);
        if (keptGroups.length) kept[event] = keptGroups;
      }
      lean.hooks = kept;
    }
    if (dropped || Object.keys(lean).length !== Object.keys(settings).length) {
      write[settingsPath] = JSON.stringify(lean, null, 2) + "\n";
    }
  }

  return { hide, write, items, hooks };
};

// Where the worktree hook reads the plan from; a sandbox without it is not lean. `dir` elsewhere is a plan file only
// to key the green-base record by (`sandcastle lean`): a live run's sandboxes read the one under `.sandcastle/.run`.
export const writePlan = (project: Project, dir = join(project.root, ".sandcastle/.run")) => {
  const p = plan(project);
  const file = join(dir, "lean-plan.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(p, null, 2));
  return { plan: p, file };
};

// Runs in a fresh worktree (a Sandcastle host hook). skip-worktree makes git
// ignore the removals and rewrites, so they can never be committed by an
// agent's `git add -A`.
export const apply = (p: Plan, cwd = process.cwd()) => {
  const files = [...p.hide.flatMap((path) => tracked(cwd, path)), ...Object.keys(p.write).flatMap((path) => tracked(cwd, path))];
  if (files.length) execFileSync("git", ["update-index", "--skip-worktree", "--", ...files], { cwd });
  for (const path of p.hide) rmSync(join(cwd, path), { recursive: true, force: true });
  for (const [path, content] of Object.entries(p.write)) writeFileSync(join(cwd, path), content);
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const instructionsTokens = (root: string) => {
  // CLAUDE.md plus the files it imports with @path - always loaded, always kept.
  const seen = new Set<string>();
  const walk = (file: string): number => {
    const full = join(root, file);
    if (seen.has(full) || !existsSync(full) || lstatSync(full).isDirectory()) return 0;
    seen.add(full);
    const text = readFileSync(full, "utf8");
    const imports = [...text.matchAll(/^@(\S+)$/gm)].map((m) => m[1]);
    return Math.ceil(text.length / 4) + imports.reduce((n, f) => n + walk(f), 0);
  };
  return walk("CLAUDE.md") || walk("AGENTS.md");
};

// Tracked files, outside what lean hides, that name a hidden path. Hiding a
// skill a test reads (a guard over agent docs, say) turns the test gate red
// on every branch - and on the base branch - for a reason no agent can fix.
// Markdown is skipped: docs mention these paths all the time and never run.
//
// A dropped hook is checked the same way, by the lean.dropHooks string that
// dropped it: a test that compares .claude/settings.json with the hooks it
// expects is red in every sandbox once one of them is gone.
export const hiddenReferences = (root: string, p: Plan, dropHooks: string[] = []) => {
  const grep = (text: string, exclude: string[]) => {
    try {
      return sh("git", ["grep", "-l", "-F", text, "--", ".", ":(exclude)*.md", ...exclude.map((h) => `:(exclude)${h}`)], root)
        .split("\n")
        .filter(Boolean);
    } catch {
      return []; // git grep exits 1 when nothing matches
    }
  };
  const droppedBy = dropHooks.filter((d) => p.items.some((i) => i.kind === "hook" && !i.kept && i.id.includes(d)));
  return [
    ...p.hide.map((path) => ({ path, by: grep(path, p.hide) })),
    // The hook's own script names the string too, and the config that drops
    // it; only other files count.
    ...droppedBy.map((d) => ({
      path: `hook "${d}"`,
      by: grep(d, [...p.hide, ".claude/settings.json", ".sandcastle"]).filter((f) => !p.items.some((i) => i.kind === "hook" && i.id.includes(f))),
    })),
  ].filter((r) => r.by.length);
};

/**
 * `lean.keep` entries that name nothing the repo loads, and `lean.dropHooks` strings that match no
 * hook: a typo there kept or dropped nothing, without a word - a skill a gate reads stayed hidden.
 */
export const unmatched = (project: Project, p: Plan) => ({
  keep: (project.lean.keep ?? []).filter((k) => !p.items.some((i) => i.kind !== "hook" && (`${i.kind}:${i.id}` === k || (i.kind === "codex-config" && k === "codex-config")))),
  dropHooks: (project.lean.dropHooks ?? []).filter((d) => !p.items.some((i) => i.kind === "hook" && !i.kept && i.id.includes(d))),
});

/** The warning lines for unmatched(), empty when every entry matched. */
export const unmatchedLines = (u: { keep: string[]; dropHooks: string[] }) => [
  ...u.keep.map((k) => `lean.keep names ${k}, which this repo does not have - check the spelling against \`sandcastle lean\`'s list (kind:id)`),
  ...u.dropHooks.map((d) => `lean.dropHooks "${d}" matches no hook in .claude/settings.json - nothing is dropped by it`),
];

/**
 * The project's `permissions.ask` rules a sandbox gets: from the tracked .claude/settings.json only
 * (settings.local.json is untracked, so no sandbox has it). The agents run with permissions bypassed,
 * yet an ask rule still stops a matching command, and nobody in a sandbox can answer it.
 */
export const askRules = (root: string): string[] => {
  if (!tracked(root, ".claude/settings.json").length) return [];
  const ask = (readJson(join(root, ".claude/settings.json"))?.permissions as { ask?: unknown } | undefined)?.ask;
  return Array.isArray(ask) ? ask.filter((r): r is string => typeof r === "string") : [];
};

/** The lines that name those rules, none when there are none; lean and doctor print the same words. */
export const askRuleLines = (root: string): string[] => {
  const rules = askRules(root);
  if (!rules.length) return [];
  return [
    `${rules.length} permissions.ask rule(s) in .claude/settings.json are refused in sandboxes, where nobody can answer:`,
    ...rules.map((r) => `    ${r.length > 90 ? r.slice(0, 87) + "..." : r}`),
    "  A command matching one fails with \"you haven't granted it yet\". Move a rule to allow or deny, or drop it if it only guards a person's own session.",
  ];
};

export const report = (project: Project, p: Plan) => {
  const rows = p.items.map((i) => [
    i.kept ? "keep" : i.kind === "hook" ? "drop" : "hide",
    i.kind,
    i.id.length > 90 ? i.id.slice(0, 87) + "..." : i.id,
    i.tokens === undefined ? (i.kind === "mcp" ? "tool schemas" : "-") : `~${i.tokens}`,
  ]);
  const hiddenTokens = p.items.filter((i) => !i.kept).reduce((n, i) => n + (i.tokens ?? 0), 0);
  const hiddenMcp = p.items.filter((i) => !i.kept && i.kind === "mcp").length;
  console.log(`Lean check for ${project.name} - what a sandbox agent would load from the repo:\n`);
  if (rows.length) {
    const w = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
    for (const r of rows) console.log(`  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`);
  } else {
    console.log("  nothing - no project skills, agents, commands, MCP servers or plugins");
  }
  const instr = instructionsTokens(project.root);
  console.log(
    `\n  Hidden: ~${hiddenTokens} tokens of descriptions${hiddenMcp ? ` and ${hiddenMcp} MCP server(s)' tool schemas` : ""}, per agent turn.` +
      `\n  Always loaded: CLAUDE.md and its imports, ~${instr} tokens${instr > 10_000 ? " - worth trimming" : ""}.`,
  );
  const kept = p.items.filter((i) => i.kept && i.kind !== "hook");
  if (kept.length) console.log(`  Kept on purpose (lean.keep): ${kept.map((i) => `${i.kind}:${i.id}`).join(", ")}`);
  for (const line of unmatchedLines(unmatched(project, p))) console.log(`  WARN ${line}`);

  const refs = hiddenReferences(project.root, p, project.lean.dropHooks);
  if (refs.length) {
    console.log("\n  Hidden or dropped, but named by files a sandbox keeps - if a gate, test or hook reads one, keep it:");
    for (const r of refs) console.log(`    ${r.path}  <- ${r.by.slice(0, 3).join(", ")}${r.by.length > 3 ? ` (+${r.by.length - 3})` : ""}`);
  }

  // Enforcement that lives outside the repo never reaches a sandbox.
  const local = readJson(join(project.root, ".claude/settings.local.json"));
  if (local?.hooks) {
    console.log(
      "  WARNING: .claude/settings.local.json defines hooks. It is untracked, so sandboxes never get them -\n" +
        "  move any guard or check among them into .claude/settings.json.",
    );
  }
  // The same, one step short: a settings.json that git ignores or never added.
  if (readJson(join(project.root, ".claude/settings.json"))?.hooks && !tracked(project.root, ".claude/settings.json").length) {
    console.log(
      "  WARNING: .claude/settings.json defines hooks but git does not track it (is .claude/ gitignored?), so sandboxes never get them -\n" +
        "  commit it, or un-ignore it, so its guards reach every sandbox.",
    );
  }
  const [askHead, ...askRest] = askRuleLines(project.root);
  if (askHead) console.log([`  WARNING: ${askHead}`, ...askRest].join("\n"));
  // The hook check proves a guard CAN run; only a hook test proves it blocks.
  const guards = p.hooks.filter((h) => h.event === "PreToolUse").length;
  if (guards && !project.hookTests.length) {
    console.log(
      `  WARNING: ${guards} PreToolUse guard(s) kept, but no hookTests in the config: nothing proves they block\n` +
        "  anything in a sandbox. Add one test per guard that matters (README: Hook tests).",
    );
  } else if (project.hookTests.length) {
    console.log(`  Hook tests: ${project.hookTests.length} configured - run by \`sandcastle gates\` and every run's base check.`);
  }
  const gitHooks = gitHooksDir(project.root);
  const outside = hooksPathOutside(project.root);
  if (outside) {
    console.log(`  WARNING: ${hooksPathLines(outside).join("\n  ")}`);
  } else if (gitHooks) {
    console.log(`  Git hooks (${gitHooks}) run on every agent commit in the sandbox; \`sandcastle gates\` checks they can.`);
  }
};

// `--local`: the shared `.git/config` is what a sandbox sees. The host's own hooks are switched off through the
// environment (`disableHostGitHooks`), which a plain read would answer with, and a global value never reaches a sandbox.
const localHooksPath = (root: string) => {
  try {
    return sh("git", ["config", "--local", "--get", "core.hooksPath"], root) || undefined;
  } catch {
    return undefined;
  }
};

const gitHooksDir = (root: string) => localHooksPath(root) ?? (existsSync(join(root, ".husky")) ? ".husky" : undefined);

/**
 * The project's `core.hooksPath` when it cannot name a directory of the sandbox's worktree: an absolute host path
 * (`/Users/...`, `C:\...`, `~/...`) does not exist in the container, and a relative one that climbs out of the
 * worktree leaves it. Git then finds no hooks and every agent commit runs none, with no error to say so.
 */
export const hooksPathOutside = (root: string): string | undefined => {
  const value = localHooksPath(root);
  if (!value) return undefined;
  const absolute = value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  const climbs = posix.normalize(value.replaceAll("\\", "/")).split("/")[0] === "..";
  return absolute || climbs ? value : undefined;
};

/**
 * What doctor, `lean` and `gates` say of `hooksPathOutside`: the value, what follows, and the fix. The next start
 * compares the config with its baseline (`assertGitConfigBaseline`): after a clean end it takes a relative path to a
 * tracked directory of the repo without a question, and asks for `--accept-git-config` once for any other value.
 */
export const hooksPathLines = (value: string): string[] => [
  `core.hooksPath is ${JSON.stringify(value)}, which is not a directory of the project, so it does not exist inside a sandbox: git finds no hooks there and agent commits run none.`,
  "-> `git config core.hooksPath <relative path>`, the hooks directory relative to the project root (for example `.githooks`). The next start takes that change without a question when the path is a tracked directory of the repo and the last run ended cleanly; any other value needs `--accept-git-config` once.",
];

// ---------------------------------------------------------------------------
// Hook check: can every kept hook run in the image? For each command, in a
// container over an export of HEAD with the plan applied: its executable is on
// PATH, every script it names exists, a Python script compiles, and its
// top-level imports resolve. Nothing is executed, so no hook has side effects
// here. A missing module is a warning, not a failure: the project's `setup`
// commands (uv sync, pip install) run later and may provide it.
// ---------------------------------------------------------------------------

const WORKSPACE = "/home/agent/workspace";

const PY_IMPORTS = `
import ast, importlib.util, os, sys
f = sys.argv[1]
try:
    tree = ast.parse(open(f).read(), f)
except SyntaxError as e:
    print("SYNTAX", e); sys.exit(0)
mods = set()
for n in tree.body:
    if isinstance(n, ast.Import): mods |= {a.name.split(".")[0] for a in n.names}
    elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module: mods.add(n.module.split(".")[0])
sys.path.insert(0, os.path.dirname(f))
missing = [m for m in sorted(mods) if importlib.util.find_spec(m) is None]
if missing: print("MODULES", " ".join(missing))
`;

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// HEAD as plain files, through a tar file rather than a shell pipe: a temp
// path is then never parsed by a shell, whatever TMPDIR holds.
const exportHead = (root: string, into: string) => {
  const tar = `${into}.tar`;
  mkdirSync(into, { recursive: true });
  try {
    execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], { cwd: root });
    execFileSync("tar", ["-x", "-f", tar, "-C", into]);
  } finally {
    rmSync(tar, { force: true });
  }
};

// `ranClean`: commands of the hooks a passing hook test ran without error (`hooksThatRanClean`). Such a hook imported
// what it needs, so the static import check's MODULES warning - blind to a `sys.path.insert` the hook makes at run
// time - is dropped for it; a syntax error and every other finding stay.
export const checkHooks = (project: Project, image: string, p: Plan, ranClean: readonly string[] = []) => {
  if (!p.hooks.length) return { failures: [] as string[], warnings: [] as string[] };
  const lines = ["cd " + WORKSPACE];
  p.hooks.forEach((h, i) => {
    const cmd = h.command.replaceAll("$CLAUDE_PROJECT_DIR", WORKSPACE).replaceAll("${CLAUDE_PROJECT_DIR}", WORKSPACE);
    // Each simple command of `a && b; c | d`, minus leading VAR=value words.
    // `cd` is a builtin; a node_modules/.bin tool appears only after setup
    // installs dependencies, so its absence here is a warning, not a failure.
    const segments = cmd.split(/&&|\|\||;|\|/).map((seg) =>
      [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).filter((w) => w !== undefined),
    );
    const words = segments.flat();
    for (const seg of segments) {
      const exe = seg.find((w) => !/^[A-Za-z_]\w*=/.test(w));
      if (!exe || ["cd", "true", "exit", "export", "test", "["].includes(exe)) continue;
      const late = exe.includes("node_modules/.bin/") || exe.includes(".venv/bin/");
      lines.push(`command -v ${shq(exe)} >/dev/null || [ -x ${shq(exe)} ] || echo "${late ? "WARN" : "FAIL"} ${i} executable not in the image: ${exe}"`);
    }
    for (const w of words.filter((w) => /\.(py|sh|js|mjs|cjs|ts|rb)$/.test(w))) {
      lines.push(`[ -f ${shq(w)} ] || echo "FAIL ${i} script missing: ${w}"`);
      if (w.endsWith(".py")) {
        lines.push(`r=$(python3 -c ${shq(PY_IMPORTS)} ${shq(w)} 2>&1); case "$r" in SYNTAX*) echo "FAIL ${i} $r";; MODULES*) echo "WARN ${i} $r";; esac`);
      }
    }
  });
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-hooks-"));
  try {
    exportHead(project.root, dir);
    for (const path of p.hide) rmSync(join(dir, path), { recursive: true, force: true });
    for (const [path, content] of Object.entries(p.write)) writeFileSync(join(dir, path), content);
    const out = execFileSync(
      "docker",
      ["run", "--rm", "-v", `${dir}:${WORKSPACE}`, "--entrypoint", "sh", image, "-c", lines.join("\n")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    const describe = (line: string) => {
      const [, idx, ...rest] = line.split(" ");
      const h = p.hooks[Number(idx)];
      return `${h.event}[${h.matcher}] ${h.command.slice(0, 70)} - ${rest.join(" ")}`;
    };
    const all = out.split("\n").filter(Boolean);
    return {
      failures: all.filter((l) => l.startsWith("FAIL")).map(describe),
      warnings: all
        .filter((l) => l.startsWith("WARN"))
        .filter((l) => !(l.split(" ")[2] === "MODULES" && ranClean.includes(p.hooks[Number(l.split(" ")[1])].command)))
        .map(describe),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const reportHookCheck = (r: { failures: string[]; warnings: string[] }, hookCount: number) => {
  if (!hookCount) return;
  if (!r.failures.length && !r.warnings.length) {
    console.log(`\n  Hooks: all ${hookCount} kept hook(s) can run in the image.`);
    return;
  }
  for (const f of r.failures) console.log(`  HOOK FAIL  ${f}`);
  for (const w of r.warnings) console.log(`  hook warn  ${w} (fine if the project's setup installs it - a hook test proves it)`);
  if (r.failures.length) {
    console.log(
      "  Fix a failing hook in the project's image layer, or - only if it is a host-only convenience,\n" +
        "  never a guard - drop it with lean.dropHooks and say why in a comment.",
    );
  }
};

// ---------------------------------------------------------------------------
// Measure: the real input tokens of a one-line reply in the project image,
// from a checkout as it is and from one with the plan applied.
// ---------------------------------------------------------------------------

const probe = (project: Project, image: string, dir: string) => {
  const env = credentials(project);
  const out = execFileSync(
    "docker",
    [
      "run", "--rm", ...Object.keys(env).flatMap((k) => ["-e", k]),
      "-v", `${dir}:/home/agent/workspace`, "-w", "/home/agent/workspace",
      "--entrypoint", "/home/agent/.local/bin/claude", image,
      "--print", "--dangerously-skip-permissions", "--model", IMPL_MODEL, "--effort", "low",
      "--output-format", "json", "-p", "Reply OK",
    ],
    { encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const u = JSON.parse(out).usage ?? {};
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
};

export const measure = (project: Project, image: string, p: Plan) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-lean-"));
  const tree = join(dir, "tree");
  try {
    // A plain export of HEAD, not a worktree: nothing to prune, nothing shared.
    exportHead(project.root, tree);
    const before = probe(project, image, tree);
    for (const path of p.hide) rmSync(join(tree, path), { recursive: true, force: true });
    for (const [path, content] of Object.entries(p.write)) writeFileSync(join(tree, path), content);
    const after = probe(project, image, tree);
    console.log(
      `\n  Measured (${IMPL_MODEL}, one "Reply OK" turn): ${before} input tokens as the repo is, ` +
        `${after} lean - ${before - after} fewer on every agent turn.`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
