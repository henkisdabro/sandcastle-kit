// The Herdr app mod's closing report (herdr-app/main.js, #961, #969): ticket titles and agents' notes in it show as
// written, never as a live link or image, and each run's end shows that run's report.
//
// `herdr-app check` runs no asynchronous state and opens no overlay, so this loads main.js under Node with the app's
// modules (`gpui-kit`, `gpui-base`, `herdr`) as stand-ins, and drives what it defines.
//
//   pnpm test:file test/herdr-app-report.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

type Overlay = { key: string; props: { report: { project: string; bin: string; started: string } } };
type Mod = {
  reportMarkdown: (text: string) => string;
  plain: (text: string) => string;
  SandcastleStatus: new () => { role: string; root: string; run: unknown; reportedRun: unknown; seen: (before: object, now: object) => void; controls: (t: object) => unknown[] };
};

type Element = { id?: string; click?: () => void };

/**
 * main.js with its imports as stand-ins: `div` an element that takes any style and keeps its id and click handler,
 * `openOverlay` an app's, which keeps an open overlay by its key, and every other name a no-op.
 */
const load = () => {
  const overlays = new Map<string, Overlay>();
  const opened: Overlay[] = [];
  const elements: Element[] = [];
  const div = () => {
    const el: Element = {};
    elements.push(el);
    const chain: unknown = new Proxy({}, {
      get: (_t, name) => (...args: unknown[]) => {
        if (name === "id") el.id = args[0] as string;
        if (name === "on_click") el.click = () => (args[0] as (e: unknown, cx: unknown) => void)({}, {});
        return chain;
      },
    });
    return chain;
  };
  let source = readFileSync(join(import.meta.dirname, "../herdr-app/main.js"), "utf8");
  const names: string[] = [];
  source = source.replace(/^import \{([^}]+)\} from "[^"]+";$/gm, (_m, list: string) => (names.push(...list.split(",").map((n) => n.trim())), ""));
  assert.ok(source.includes("export default class SandcastleStatus"), "herdr-app/main.js no longer has `export default class SandcastleStatus`: update this test's seam");
  source = `${source.replace("export default class SandcastleStatus", "class SandcastleStatus")}\nreturn { reportMarkdown, plain, SandcastleStatus };`;
  const stand = (name: string): unknown => {
    if (name === "View") return class {};
    if (name === "div") return div;
    if (name === "props") return () => ({ project: "/p", command: ["/kit/bin/sandcastle", "status", "--json", "--frame"] });
    if (name === "openOverlay")
      return (o: Overlay) => {
        // An app keeps an open overlay by its key: a second open with the same key shows the one already there.
        if (!overlays.has(o.key)) overlays.set(o.key, o);
        opened.push(overlays.get(o.key)!);
      };
    return () => undefined;
  };
  const mod = new Function(...names, source)(...names.map(stand)) as Mod;
  return { mod, opened, elements };
};

test("a markdown link, an image, emphasis and HTML in the report's text are escaped; its headings, lists and code spans are kept", () => {
  const { mod } = load();
  const report = [
    "## 🙋 Needs you",
    "- #7 See [the docs](https://example.test/x) and ![](https://host.test/pixel.png) - held: fix src/_under_scores_.ts and *this* <img src=x>",
    "  #9 Run `sandcastle land 9` after review_notes_",
    "1. Check #919 by hand",
    "```",
    "a [raw](line) in fenced code",
    "```",
    "",
  ].join("\n");
  const md = mod.reportMarkdown(mod.plain(report)).split("\n");
  assert.equal(md[0], "## 🙋 Needs you  ");
  assert.equal(
    md[1],
    "- \\#7 See \\[the docs\\]\\(https\\:\\/\\/example\\.test\\/x\\) and \\!\\[\\]\\(https\\:\\/\\/host\\.test\\/pixel\\.png\\) \\- held\\: fix src\\/\\_under\\_scores\\_\\.ts and \\*this\\* \\<img src\\=x\\>  ",
  );
  // A code span is literal already: a backslash in it would show.
  assert.equal(md[2], "  \\#9 Run `sandcastle land 9` after review\\_notes\\_  ");
  assert.equal(md[3], "1. Check \\#919 by hand  ");
  assert.deepEqual(md.slice(4), ["```", "a [raw](line) in fenced code", "```", ""]);
  // Every escaped mark is markdown's backslash escape of ASCII punctuation: with the escapes taken out, the text is
  // the report's own.
  assert.equal(md.slice(0, 4).map((l) => l.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/ {2}$/, "")).join("\n"), report.split("\n").slice(0, 4).join("\n"));
});

test("a ticket title holding U+2028 or U+2029 is escaped like any other line, not an error", () => {
  const { mod } = load();
  const md = mod.reportMarkdown(mod.plain("- #7 Fix [the](x) thing\u2028now\u2029too"));
  assert.equal(md, "- \\#7 Fix \\[the\\]\\(x\\) thing\u2028now\u2029too  ");
});

test("a second run's end in the same pane shows that run's report, not the first's left open", () => {
  const { mod, opened } = load();
  const view = new mod.SandcastleStatus();
  view.role = "status";
  view.root = "/p";
  view.reportedRun = null;
  const first = { startedAt: "2026-11-14T01:00:00.000Z" };
  const second = { startedAt: "2026-11-14T03:00:00.000Z" };
  view.seen({ ...first, state: "running" }, { ...first, state: "finished" });
  // Run 1's window is left open; run 2 starts and ends in the same pane.
  view.seen({ ...first, state: "finished" }, { ...second, state: "running" });
  view.seen({ ...second, state: "running" }, { ...second, state: "finished" });
  assert.equal(opened.length, 2, "each run's end opens its report");
  assert.notEqual(opened[1].key, opened[0].key, "run 2's report is a window of its own, not run 1's kept by the app");
  assert.deepEqual(Object.keys(opened[1].props.report), ["project", "bin", "started"]);
  assert.match(opened[1].props.report.started, /^\d\d:\d\d$/, "the window's title names the run's start");
  assert.notEqual(opened[1].props.report.started, opened[0].props.report.started);
  // A later reading of the same ended run opens nothing more.
  view.seen({ ...second, state: "finished" }, { ...second, state: "finished" });
  view.seen({ ...second, state: "running" }, { ...second, state: "finished" });
  assert.equal(opened.length, 2);
});

test("Report opens the window of the run the pane shows", () => {
  const { mod, opened, elements } = load();
  const view = new mod.SandcastleStatus();
  const report = () => {
    elements.length = 0;
    view.controls({});
    elements.find((e) => e.id === "run-report")!.click!();
    return opened[opened.length - 1];
  };
  view.root = "/p";
  view.run = { startedAt: "2026-11-14T01:00:00.000Z", state: "finished" };
  const first = report();
  view.run = { startedAt: "2026-11-14T03:00:00.000Z", state: "finished" };
  assert.notEqual(report().key, first.key);
  assert.equal(report().key, opened[opened.length - 1].key, "the same run's Report is the same window");
});
