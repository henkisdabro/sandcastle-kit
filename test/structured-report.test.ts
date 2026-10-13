// Replay of a schema-validated agent report (`claude --json-schema`, `codex exec --output-schema`) through
// Sandcastle's own agent invocation, with the kit's own `buildPrintCommand` and `parseStreamLine` overrides
// (src/agents.ts): the investigation behind "should a pass end in a validated report instead of tags parsed
// from prose" (#770). No Docker, model or network: the sandbox is a fake bind-mount handle whose streaming
// `exec` prints hand-built stream lines (no recorded `--json-schema` or `--output-schema` stream exists yet; the
// shapes are the documented ones), and the lines go through `createSandbox(...).run(...)` because the
// library's `invokeAgent` is internal.
//
// These also pin what the kit relies on in the patched dependency today, for its next upgrade: the completion
// signal ends the idle timeout and starts a grace window that every further line restarts, the result of a pass
// is the last `result` line's text (else the raw stdout), and the library's parser drops `structured_output`.
//
//   pnpm test:file test/structured-report.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBindMountSandboxProvider, createSandbox } from "@ai-hero/sandcastle";
import { quietly } from "./quiet.ts";

// Read at import: the codex provider exists only with CROSS_REVIEW=1, and the project's config is the temp one.
process.env.CROSS_REVIEW = "1";
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-sr-xdg-"));
const { crossReview, implAgent, reviewWithFallback, IMPL_MODEL, REVIEW_MODEL } = await import("../src/agents.ts");

const SIGNAL = "<promise>COMPLETE</promise>";
// The completion window of every pass here, in seconds; a gap longer than it after the signal ends the pass.
const WINDOW = 1;
const WINDOW_MS = WINDOW * 1000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-sr-")));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(join(root, "tracked.txt"), "tracked\n");
git("add", "-A");
git("commit", "-q", "-m", "start");
mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });

/** A line the fake sandbox prints, or a pause in milliseconds before the next one. */
type Step = string | number;
/** One agent command's output, and how the process ends. */
type Script = { steps: Step[]; exitCode?: number };

const line = (o: unknown) => JSON.stringify(o);

// The stream-json shapes of `claude --print --verbose --output-format stream-json`; `result` is the text reply,
// `structured_output` the validated object (Claude Code 2.1.x, per the ticket's live check).
const REPLY = `Added the thing.\n\n${SIGNAL}`;
const init = line({ type: "system", subtype: "init", session_id: "sess-1" });
const said = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const structuredCall = (input: unknown) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "StructuredOutput", input }] } });
const toolResult = (isError: boolean, content: string) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: isError, content }] } });
const MODEL_USAGE = { "claude-sonnet-5-5": { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 5 } };
const result = (extra: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", is_error: false, result: REPLY, session_id: "sess-1", modelUsage: MODEL_USAGE, ...extra });

const REPORT = { status: "done", unmet: null, changelog: ["Added: the thing."], followups: [] };

/** A fake sandbox whose agent commands answer with `scripts` in order (the last repeats). */
const open = async (scripts: Script[]) => {
  const commands: string[] = [];
  let finished = 0;
  let closed = false;
  let wake = () => {};
  const closing = new Promise<void>((r) => (wake = r));
  const pause = (ms: number) => Promise.race([new Promise((r) => setTimeout(r, ms)), closing]);
  const provider = createBindMountSandboxProvider({
    name: "fake",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, options) => {
        if (!/^(claude|codex) /.test(command)) return { stdout: "", stderr: "", exitCode: 0 };
        const script = scripts[Math.min(commands.length, scripts.length - 1)];
        commands.push(command);
        let stdout = "";
        for (const step of script.steps) {
          if (typeof step === "number") await pause(step);
          if (closed) return { stdout, stderr: "", exitCode: 1 };
          if (typeof step === "number") continue;
          stdout += `${step}\n`;
          options?.onLine?.(step);
        }
        finished++;
        return { stdout, stderr: "", exitCode: script.exitCode ?? 0 };
      },
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });
  const branch = `agent/sr-${Math.random().toString(36).slice(2, 10)}`;
  const sandbox = await createSandbox({ cwd: root, branch, baseBranch: "main", sandbox: provider });
  return {
    sandbox,
    commands,
    finished: () => finished,
    close: async () => {
      closed = true;
      wake();
      await sandbox.close();
    },
  };
};

type Agent = Parameters<Awaited<ReturnType<typeof open>>["sandbox"]["run"]>[0]["agent"];

/** One pass as the kit runs it: a file log, and the raw lines handed to a callback like `agentLogging`'s. */
const passOf = (fake: Awaited<ReturnType<typeof open>>, agent: Agent, onRaw: (line: string) => void = () => {}) =>
  fake.sandbox.run({
    agent,
    prompt: "do the ticket",
    name: "implement",
    completionSignal: SIGNAL,
    completionTimeoutSeconds: WINDOW,
    logging: { type: "file", path: join(root, ".sandcastle", "logs", `pass-${Math.random().toString(36).slice(2, 8)}.log`), onAgentStreamEvent: (e) => e.type === "raw" && onRaw(e.line) },
  });

const SCHEMA = JSON.stringify({ type: "object", required: ["status"], properties: { status: { type: "string" } } });

/**
 * What a build would add to the kit's own provider, kept to the smallest form: `--json-schema` before the
 * command's closing ` -p -`, and the `structured_output` of the pass's own `result` line kept in the provider
 * object (one per pass, as `claude()` makes one) - the library's parser drops that field.
 */
const withReport = (agent: ReturnType<typeof implAgent>) => {
  const kept: { report?: unknown; lines: number } = { lines: 0 };
  return {
    kept,
    agent: {
      ...agent,
      buildPrintCommand(options: Parameters<typeof agent.buildPrintCommand>[0]) {
        const printed = agent.buildPrintCommand(options);
        return { ...printed, command: printed.command.replace(/ -p -$/, ` --json-schema '${SCHEMA}' -p -`) };
      },
      parseStreamLine(l: string) {
        kept.lines++;
        if (l.includes('"structured_output"')) {
          const parsed = JSON.parse(l) as { type?: string; structured_output?: unknown };
          if (parsed.type === "result" && parsed.structured_output !== undefined) kept.report = parsed.structured_output;
        }
        return agent.parseStreamLine(l);
      },
    } as Agent,
  };
};

const silent = <T>(fn: () => Promise<T>) => quietly(fn).then((r) => r.result);

// --- Claude: question 1 (completion timeout), 2 (missing result), 6 (source of truth) ---

test("a normal schema-validated pass: the reply keeps the completion signal and the library hands over no report", async () => {
  const fake = await open([{ steps: [init, said(REPLY), structuredCall(REPORT), toolResult(false, "Structured output provided successfully"), result({ structured_output: REPORT })] }]);
  const { agent, kept } = withReport(implAgent());
  const raw: string[] = [];
  try {
    const r = await silent(() => passOf(fake, agent, (l) => raw.push(l)));
    assert.match(fake.commands[0], /^claude --print --verbose .* --json-schema '.*' -p -$/, "the flag rides on the kit's own command: no change to the dependency");
    assert.match(fake.commands[0], /--tools 'Bash,Read,Edit,Write,TaskStop'/, "the kit's tool cut is kept");
    assert.equal(r.completionSignal, SIGNAL);
    assert.equal(r.stdout, REPLY, "the pass's result is the text reply; structured_output is not in it");
    assert.ok(!r.stdout.includes("done"), "no field of the report leaked into the result");
    assert.deepEqual(kept.report, REPORT, "only a hook on the pass's own stream sees the validated object");
    assert.equal(r.iterations[0].usage?.outputTokens, 5, "the kit's usage reading still works on a result line that carries structured_output");
    assert.ok(raw.some((l) => l.includes('"structured_output"')), "the raw line reaches the logging callback too");
  } finally {
    await fake.close();
  }
});

test("a report after a validation retry is the one the retry produced", async () => {
  const bad = { status: 3 };
  const fake = await open([{
    steps: [init, said(REPLY), structuredCall(bad), toolResult(true, "status: Expected string, received number"), structuredCall(REPORT), toolResult(false, "ok"), result({ structured_output: REPORT })],
  }]);
  const { agent, kept } = withReport(implAgent());
  try {
    const r = await silent(() => passOf(fake, agent));
    assert.deepEqual(kept.report, REPORT);
    assert.equal(r.completionSignal, SIGNAL);
    assert.equal(r.stdout, REPLY);
    assert.equal(fake.finished(), 1);
  } finally {
    await fake.close();
  }
});

test("a retry that keeps printing lines inside the window outlives the completion timeout in total", async () => {
  // Three gaps of 0.6 s after the signal: 1.8 s in all, past the 1 s window, but each line restarts it.
  const gap = Math.round(WINDOW_MS * 0.6);
  const fake = await open([{
    steps: [init, said(REPLY), gap, structuredCall({ status: 3 }), gap, toolResult(true, "status: Expected string"), gap, structuredCall(REPORT), result({ structured_output: REPORT })],
  }]);
  const { agent, kept } = withReport(implAgent());
  try {
    await silent(() => passOf(fake, agent));
    assert.equal(fake.finished(), 1, "the process was allowed to end by itself");
    assert.deepEqual(kept.report, REPORT);
  } finally {
    await fake.close();
  }
});

test("a StructuredOutput call after a silence longer than the completion window is cut off, and the pass still reads as done", async () => {
  // The model took longer than the window to produce the call (or its retry) after printing the signal.
  const fake = await open([{ steps: [init, said(REPLY), WINDOW_MS * 3, structuredCall(REPORT), result({ structured_output: REPORT })] }]);
  const { agent, kept } = withReport(implAgent());
  try {
    const started = Date.now();
    const r = await silent(() => passOf(fake, agent));
    assert.ok(Date.now() - started < WINDOW_MS * 2.5, "the pass returned at the end of the window, not at the end of the process");
    assert.equal(fake.finished(), 0, "the process had not ended: the library force-completed it");
    assert.equal(r.completionSignal, SIGNAL, "the pass reads as done");
    assert.equal(r.stdout, REPLY, "with the text it had accumulated");
    assert.equal(kept.report, undefined, "and no valid report: a kit must tell the two apart from this, never from the signal");
  } finally {
    await fake.close();
  }
});

test("a pass that ends without structured_output returns the text and the signal, and only the pass's own stream tells", async () => {
  // Anthropic's docs: a run can end successfully without structured_output.
  const fake = await open([{ steps: [init, said(REPLY), result()] }]);
  const { agent, kept } = withReport(implAgent());
  try {
    const r = await silent(() => passOf(fake, agent));
    assert.equal(r.completionSignal, SIGNAL);
    assert.equal(r.stdout, REPLY);
    assert.equal(kept.report, undefined);
  } finally {
    await fake.close();
  }
});

test("retries exhausted: no result text, so the pass returns the whole raw stdout and the signal is found in it by accident", async () => {
  const exhausted = line({ type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: ["Failed to provide valid structured output after 5 attempts"], session_id: "sess-1" });
  const fake = await open([{ steps: [init, said(REPLY), structuredCall({ status: 3 }), toolResult(true, "bad"), exhausted] }]);
  const { agent, kept } = withReport(implAgent());
  try {
    const r = await silent(() => passOf(fake, agent));
    assert.equal(kept.report, undefined);
    assert.ok(r.stdout.includes('"subtype":"error_max_structured_output_retries"'), "resultText was empty, so the library falls back to the process's stdout: raw JSON lines");
    assert.ok(r.stdout.startsWith('{"type":"system"'), "every raw line, not the reply");
    assert.equal(r.completionSignal, SIGNAL, "the reply's signal is inside the raw stdout, so it still matches");
    assert.ok(!r.stdout.split("\n").some((l) => l === SIGNAL), "while no line of that stdout is the reply: a tag scan of it would find nothing");
  } finally {
    await fake.close();
  }
});

test("retries exhausted with a non-zero exit is an agent failure with the raw tail as its cause", async () => {
  const exhausted = line({ type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: ["Failed after 5 attempts"] });
  const fake = await open([{ steps: [init, said(REPLY), exhausted], exitCode: 1 }]);
  const { agent } = withReport(implAgent());
  try {
    await assert.rejects(silent(() => passOf(fake, agent)), /claude-code exited with code 1[\s\S]*error_max_structured_output_retries/);
  } finally {
    await fake.close();
  }
});

test("the report comes from the pass's own stream: a log that cannot be written does not lose it", async () => {
  const fake = await open([{ steps: [init, said(REPLY), result({ structured_output: REPORT })] }]);
  const { agent, kept } = withReport(implAgent());
  try {
    // The kit's logging callback appends to the sidecar and swallows a failure (src/run.ts agentLogging); the
    // library swallows a throwing callback as well, so the pass goes on with the line missing from the log.
    const r = await silent(() => passOf(fake, agent, () => { throw new Error("ENOSPC: no space left on device"); }));
    assert.equal(r.completionSignal, SIGNAL);
    assert.deepEqual(kept.report, REPORT);
  } finally {
    await fake.close();
  }
});

// --- Question 3: a schema failure must not amplify ---

const missing = (): Script => ({ steps: [init, said(REPLY), result()] });

test("a missing report thrown from a review makes the fallback run a whole second editing review", async () => {
  assert.notEqual(REVIEW_MODEL, IMPL_MODEL, "the default pairing: the fallback is a different model");
  const fake = await open([missing(), { steps: [init, said(REPLY), result({ structured_output: REPORT })] }]);
  try {
    const { result: out, lines } = await quietly(() =>
      reviewWithFallback("T-1", async (agent, model) => {
        const { agent: reporting, kept } = withReport(agent as ReturnType<typeof implAgent>);
        await passOf(fake, reporting);
        if (kept.report === undefined) throw new Error(`${model} gave no valid report`);
        return model;
      }),
    );
    assert.equal(out, IMPL_MODEL);
    assert.equal(fake.commands.length, 2, "two full agent passes for one missing field");
    assert.match(fake.commands[0], new RegExp(`--model '${REVIEW_MODEL}'`));
    assert.match(fake.commands[1], new RegExp(`--model '${IMPL_MODEL}'`));
    assert.ok(lines.some((l) => /review failed .* gave no valid report/.test(l)));
  } finally {
    await fake.close();
  }
});

test("a missing report returned as a value is one pass, and the caller decides", async () => {
  const fake = await open([missing()]);
  try {
    const out = await silent(() =>
      reviewWithFallback("T-1", async (agent) => {
        const { agent: reporting, kept } = withReport(agent as ReturnType<typeof implAgent>);
        const r = await passOf(fake, reporting);
        return { report: kept.report, said: r.completionSignal === SIGNAL };
      }),
    );
    assert.deepEqual(out, { report: undefined, said: true });
    assert.equal(fake.commands.length, 1);
  } finally {
    await fake.close();
  }
});

// --- Codex: question 4 ---

/** The kit's own codex provider (CROSS_REVIEW=1), as `crossReview` hands it to a pass. */
const codexAgent = async () => {
  const agent = await crossReview("T-1", async (a) => a);
  assert.ok(agent, "CROSS_REVIEW=1 builds the codex provider");
  return agent;
};

// `codex exec --json` events: each completed agent_message is text and result for the library.
const thread = line({ type: "thread.started", thread_id: "thr-1" });
const message = (text: string) => line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
const turn = line({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
const SCHEMA_FILE = "/etc/claude-code/report.schema.json";

/** `--output-schema` after `--json`; the file is under the kit's read-only `container/` mount, which every sandbox has. */
const withSchemaFile = (agent: Awaited<ReturnType<typeof codexAgent>>) => ({
  ...agent,
  buildPrintCommand(options: Parameters<typeof agent.buildPrintCommand>[0]) {
    const printed = agent.buildPrintCommand(options);
    return { ...printed, command: printed.command.replace(" --json ", ` --json --output-schema ${SCHEMA_FILE} `) };
  },
}) as Agent;

test("codex with an output schema: the result is the JSON, which carries the signal only where the schema asks for it", async () => {
  const agent = withSchemaFile(await codexAgent());
  const json = JSON.stringify({ ...REPORT, signal: SIGNAL });
  const plain = JSON.stringify(REPORT);

  const withField = await open([{ steps: [thread, message(json), turn] }]);
  try {
    const r = await silent(() => passOf(withField, agent));
    assert.match(withField.commands[0], /^codex exec --json --output-schema \/etc\/claude-code\/report\.schema\.json .*; rc=\$\?; .*; exit \$rc$/, "the kit's rate-limit readout still follows the command");
    assert.deepEqual(JSON.parse(r.stdout), { ...REPORT, signal: SIGNAL });
    assert.equal(r.completionSignal, SIGNAL, "a string field holding the signal keeps both the match and the grace window");
  } finally {
    await withField.close();
  }

  const without = await open([{ steps: [thread, message(plain), turn] }]);
  try {
    const r = await silent(() => passOf(without, agent));
    assert.deepEqual(JSON.parse(r.stdout), REPORT, "the pass's result is the final message and nothing else");
    assert.equal(r.completionSignal, undefined, "no signal anywhere: the pass reads as not done, and a hang would wait for the 10 minute idle timeout, not the grace window");
  } finally {
    await without.close();
  }
});

test("codex: an earlier message with the signal arms the grace window, and a final JSON message after a long silence is cut off", async () => {
  const agent = withSchemaFile(await codexAgent());
  const fake = await open([{ steps: [thread, message(`Done.\n${SIGNAL}`), WINDOW_MS * 3, message(JSON.stringify(REPORT)), turn] }]);
  try {
    const r = await silent(() => passOf(fake, agent));
    assert.equal(fake.finished(), 0);
    assert.equal(r.stdout, `Done.\n${SIGNAL}`, "the earlier message is the result; the report never arrived");
    assert.throws(() => JSON.parse(r.stdout), SyntaxError);
  } finally {
    await fake.close();
  }
});

test("codex: a schema the API refuses is an agent failure (exit 1, the error event as the cause), not a report", async () => {
  const agent = withSchemaFile(await codexAgent());
  const refused = line({ type: "error", message: "invalid_json_schema: 'additionalProperties' is required to be supplied and to be false" });
  const fake = await open([{ steps: [thread, refused], exitCode: 1 }]);
  try {
    await assert.rejects(silent(() => passOf(fake, agent)), /codex exited with code 1[\s\S]*invalid_json_schema/);
  } finally {
    await fake.close();
  }
});

test("a cross-review that throws after its pass is swallowed, finding and all; one returned as a value keeps it", async () => {
  const agent = withSchemaFile(await codexAgent());
  const finding = { ...REPORT, followups: ["a finding"] };
  const fake = await open([{ steps: [thread, message(JSON.stringify(finding)), turn] }]);
  try {
    const thrown = await quietly(() =>
      crossReview("T-1", async () => {
        const r = await passOf(fake, agent);
        const report = JSON.parse(r.stdout) as typeof finding;
        if (report.status !== "valid") throw new Error("report failed the schema check");
        return report;
      }),
    );
    assert.equal(thrown.result, undefined, "crossReview returns nothing: the finding the pass produced is gone");
    assert.ok(thrown.lines.some((l) => /cross-review failed \(report failed the schema check\); continuing without it/.test(l)));

    const returned = await silent(() =>
      crossReview("T-1", async () => {
        const r = await passOf(fake, agent);
        return { ok: false as const, report: JSON.parse(r.stdout) as typeof finding };
      }),
    );
    assert.deepEqual(returned?.report.followups, ["a finding"]);
  } finally {
    await fake.close();
  }
});
