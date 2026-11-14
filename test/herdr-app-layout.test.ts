// The Herdr app mod's lane cards (herdr-app/main.js) keep every word readable: a long value wraps between its
// pieces and grows its row, an unbreakable piece cuts with an ellipsis inside its card, and nothing is clipped. A
// row once kept one line's height while its pieces wrapped onto two, and the next row painted over the second (#960).
//
// `herdr-app check` lays nothing out, so this holds the structure that makes it so, in the element tree it prints
// (`--print-spec`): the mod drawn from real `status --json --frame` readings (a live run and a finished one), every
// lane given long values - a killed run's words, long model ids, long reset strings, one unbreakable piece - at a
// narrow, a half and a wide pane. It needs the Herdr app's `herdr-app` (macOS); without it the test is skipped.
//
//   pnpm test:file test/herdr-app-layout.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { retryOnInterrupted } from "./herdr-app-retry.ts";
import { buildFixture, type FixtureKind } from "./status-fixture.ts";
import { spawnStatus, viewEnv } from "./status-run.ts";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-app-layout-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// The real `herdr-app`, past the stand-in the hermetic environment puts on PATH (one that exits 127).
const realApp = (() => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "herdr-app");
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    if (spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0) return candidate;
  }
  return undefined;
})();
const skip = realApp ? false : "no Herdr app (herdr-app) on this machine";

type Segment = { text: string; tone: string; bold?: true };
type Doc = { table: unknown; frame: { lanes: { name: string; rows: Segment[][] }[] } & Record<string, unknown> };

const reading = (kind: FixtureKind): Doc => {
  const fixture = buildFixture(kind, mkdtempSync(join(TMP, `${kind}-`)));
  try {
    const r = spawnStatus(["--json", "--frame"], { encoding: "utf8", env: viewEnv(fixture), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as Doc;
  } finally {
    fixture.stop();
  }
};

const LONG: Segment[] = [
  { text: " · ", tone: "gry" },
  { text: "killed", tone: "hot" },
  { text: " · no clean exit · started 10 Oct 18:00 · ", tone: "mute" },
  { text: "claude-opus-5-5-20261113/high, review claude-sonnet-5-5-20261113/high, repair gpt-6.1-sol/high", tone: "plain" },
  { text: " · resets Tue 20:00 (in 3 days 4 hours) · ", tone: "mute" },
  { text: "an-unbreakable-piece-with-no-space-in-it-at-all-0123456789abcdefghijklmnopqrstuvwxyz", tone: "plain" },
];
/** Every row of every lane with the long values after its own. */
const longer = (doc: Doc): Doc => ({ ...doc, frame: { ...doc.frame, lanes: doc.frame.lanes.map((l) => ({ ...l, rows: l.rows.map((r) => (r.length ? [...r, ...LONG] : r)) })) } });

/** The mod, drawing `doc` at `width` px from its first render: a copy whose first reading is the given one. */
const spec = (doc: Doc, width: number): string => {
  const dir = mkdtempSync(join(TMP, "mod-"));
  for (const f of readdirSync(join(KIT, "herdr-app"))) if (/\.(svg|json)$/.test(f) && f !== "jsconfig.json") copyFileSync(join(KIT, "herdr-app", f), join(dir, f));
  let main = readFileSync(join(KIT, "herdr-app/main.js"), "utf8");
  const swap = (from: string, to: string) => {
    assert.ok(main.includes(from), `herdr-app/main.js no longer has \`${from}\`: update this test's seam`);
    main = main.replace(from, to);
  };
  swap("this.doc = null;", `this.doc = ${JSON.stringify(doc)};`);
  swap("this.width = 900;", `this.width = ${width};`);
  swap("this.run = null;", `this.run = ${JSON.stringify((doc as { run?: unknown }).run ?? null)};`);
  writeFileSync(join(dir, "main.js"), main);
  const check = () => spawnSync(realApp!, ["check", dir, "--print-spec"], { encoding: "utf8", timeout: 60_000 });
  let r = check();
  // The app stops a render that runs past about 50 ms of wall-clock time, which a full suite's load can cause:
  // run it once more for that error only. A spawn the timeout killed has no status and is not run again.
  if (r.status !== null && r.status !== 0 && retryOnInterrupted(`${r.stdout}\n${r.stderr}`)) r = check();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

type Node = { line: string; children: Node[]; parent?: Node };
/** The printed tree: one element per line, its children indented two spaces under it. */
const tree = (printed: string): Node => {
  const root: Node = { line: "", children: [] };
  const stack: { depth: number; node: Node }[] = [{ depth: -1, node: root }];
  for (const line of printed.split("\n")) {
    if (!line.trim() || line.startsWith("check passed")) continue;
    const depth = line.length - line.trimStart().length;
    while (stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node: Node = { line: line.trim(), children: [], parent };
    parent.children.push(node);
    stack.push({ depth, node });
  }
  return root;
};
const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
const isText = (n: Node) => n.line.startsWith("text ");
const hasText = (n: Node): boolean => isText(n) || n.children.some(hasText);
const lanesOf = (root: Node) => all(root).filter((n) => /:id\[Str\("lane-[A-Z]+"\)\]/.test(n.line));

const cases: [string, number][] = [
  ["narrow", 420],
  ["half", 760],
  ["wide", 1500],
];

for (const kind of ["live", "ended"] as const) {
  test(`${kind} run: every lane's row grows with its wrapped value and cuts an unbreakable piece inside its card, narrow, half and wide`, { skip }, () => {
    const doc = longer(reading(kind));
    for (const [name, width] of cases) {
      const root = tree(spec(doc, width));
      const lanes = lanesOf(root);
      assert.equal(lanes.length, doc.frame.lanes.length, `${name}: one card per lane`);
      for (const lane of lanes) {
        const where = `${name} ${lane.line.match(/lane-[A-Z]+/)?.[0]}`;
        const rows = lane.children.filter((n) => /:id\[Str\("lane-[A-Z]+-\d+"\)\]/.test(n.line));
        assert.ok(rows.length > 0, `${where}: its rows`);
        for (const node of all(lane)) {
          // A height set on anything holding text would clip a second line; only a gauge's bar has one.
          if (hasText(node)) assert.doesNotMatch(node.line, /\.(h|max_h|line_clamp)\[/, `${where}: a fixed height on ${node.line}`);
          // A row in the card's column with a 0 basis or no content minimum keeps one line's height (the bug).
          if (node.parent === lane && node !== lane.children[0]) assert.doesNotMatch(node.line, /\.flex_1\b|\.overflow_hidden\b/, `${where}: ${node.line}`);
          // A row's value: its pieces wrap between them, and none is stretched in the column.
          if (node.line.startsWith("h_flex") && node.children.filter(hasText).length > 1 && node.children.every((c) => !isText(c))) {
            const pieces = node.children.filter((c) => c.children.some(isText));
            if (pieces.length > 1) assert.match(node.line, /\.flex_wrap\b/, `${where}: pieces that cannot wrap in ${node.line}`);
          }
          // A piece kept on one line is cut with an ellipsis inside its card, never run past its edge.
          if (node.children.some(isText) && /\.whitespace_nowrap\b/.test(node.line)) {
            assert.match(node.line, /\.text_ellipsis\b/, `${where}: an uncut piece ${node.line}`);
            assert.match(node.line, /\.min_w\[Number\(0\.0\)\]/, `${where}: a piece that cannot shrink ${node.line}`);
          }
        }
        // Keyed rows: the key on the value's first line, the value taking the rest of the row.
        for (const row of rows.filter((r) => r.line.startsWith("h_flex") && /\.items_start\b/.test(r.line))) {
          assert.match(row.children[1]?.line ?? "", /\.flex_1\b/, `${where}: a keyed value that does not take the row`);
        }
      }
      // The status line (#961), pinned above everything: its words cut with an ellipsis on their one row, every
      // button whole beside them.
      const line = all(root).find((n) => /:id\[Str\("line"\)\]/.test(n.line));
      assert.ok(line, `${name}: the status line`);
      const words = line.children.find((n) => /\.text_ellipsis\b/.test(n.line));
      assert.ok(words, `${name}: the line's words`);
      assert.match(words.line, /\.min_w\[Number\(0\.0\)\]/);
      assert.match(words.line, /\.flex_1\b/);
      for (const button of line.children.filter((n) => /on_click/.test(n.line))) assert.match(button.line, /\.flex_none\b/, `${name}: a button that can be squeezed: ${button.line}`);
      assert.match(JSON.stringify(words.children.map((n) => n.line)), /\d+\/\d+/, `${name}: the run's line`);
      // The cards of one line stretch to the tallest, one gap between them all.
      const header = lanes[0].parent!;
      assert.match(header.line, /\.flex_wrap\b/);
      assert.match(header.line, /\.items_stretch\b/);
      const pads = new Set(lanes.map((l) => l.line.match(/\.p\[Number\(([\d.]+)\)\]/)?.[1]));
      const gaps = new Set(lanes.map((l) => l.line.match(/\.gap\[Number\(([\d.]+)\)\]/)?.[1]));
      assert.equal(pads.size, 1, `${name}: one padding for every card`);
      assert.equal(gaps.size, 1, `${name}: one row gap in every card`);
    }
  });
}

// Fails here, not as a skipped test, when a mod folder cannot be built: the copy reads the kit's own files.
test("the layout check's copy of the mod reads the kit's files", () => {
  mkdirSync(join(TMP, "probe"), { recursive: true });
  assert.ok(readFileSync(join(KIT, "herdr-app/main.js"), "utf8").includes("this.doc = null;"));
});
