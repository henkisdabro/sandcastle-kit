// The kit's one list of Claude Code's built-in tool names, and the source of truth for validating the
// `tool:<Name>` entries of `lean.keep`. Taken from the Claude Code docs, "Tools reference"
// (https://code.claude.com/docs/en/tools-reference), read 20261010. Claude Code ignores an unknown name in
// `--tools` without an error or a warning, so a misspelt name would silently drop the tool: config loading
// checks every `tool:` entry against this list. A Claude Code release that adds a tool is added here by hand.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distance } from "./errors.ts";
import { KIT } from "./sandbox.ts";

export const CLAUDE_CODE_TOOLS: readonly string[] = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EndConversation",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListAgents",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendFeedback",
  "SendMessage",
  "SendUserFile",
  "ShareOnboardingGuide",
  "Skill",
  "SubagentHandback",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
];

/** The tools the managed settings deny in every sandbox (`permissions.deny` of container/managed-settings.json). */
export const managedDenied = (): string[] => {
  const settings = JSON.parse(readFileSync(join(KIT, "container", "managed-settings.json"), "utf8")) as { permissions?: { deny?: unknown } };
  const deny = settings.permissions?.deny;
  return Array.isArray(deny) ? deny.filter((d): d is string => typeof d === "string") : [];
};

/** The built-in tool whose name is the fewest edits from `name`, ignoring case. */
export const nearestTool = (name: string): string => {
  const lower = name.toLowerCase();
  let best = CLAUDE_CODE_TOOLS[0];
  let bestDistance = Infinity;
  for (const tool of CLAUDE_CODE_TOOLS) {
    const d = distance(lower, tool.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [tool, d];
  }
  return best;
};
