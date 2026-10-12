// The live status window: the status view's own renderer (status-render.js, the TypeScript renderer with its
// types stripped by scripts/site-renderer.mjs) drawing a scripted overnight run. This file makes up the run
// and hands the renderer what the view would read - a snapshot and a table of rows - then turns the ANSI
// frame it draws into text with coloured spans. Drawn as text rather than canvas, so it stays sharp at any
// zoom and can be selected; the columns drop out the way the real view's do.

// A line is a list of [text, colour] segments; the colours are the status view's own variable names,
// styled in site.css as .c-<name>.
(function () {
  'use strict';

const { renderFrame, ago } = window.SandcastleRender;

// ---------------------------------------------------------------------------
// The run. Times are minutes after the start; each event sets a ticket's
// state, its activity note and its commit count. Made up, but every state and
// note is one the real view shows. A note starting with @ is an agent's log
// line, which carries its own time: "[10:44:31 pm] Editing src/api/x.ts".
// Each branch lands as it goes green, on one landing worker, its row moving
// down into the merged group while the others work; a ticket whose blocker
// lands starts at once, in the same run.

const SETUP = 'setting up its sandbox';
const LAND = 'merging into main';
const REVIEW = 'reviewing the diff against main';
const EVENTS = [
  [0, '#41', 'queued', 'next to start'], [0, '#42', 'queued', '1 ahead of it'],
  [0, '#43', 'queued', '2 ahead of it'], [0, '#44', 'queued', '3 ahead of it'],
  [0, '#45', 'queued', '4 ahead of it'], [0, '#46', 'queued', '5 ahead of it'],
  [0, '#48', 'queued', '6 ahead of it'], [0, '#49', 'queued', '7 ahead of it'],
  [0, '#52', 'queued', '8 ahead of it'], [0, '#53', 'queued', '9 ahead of it'],
  [0, '#47', 'blocked', 'waits for #41 (lands this run)'],
  [0, '#50', 'blocked', 'waits for #44 to close'], [0, '#51', 'blocked', 'waits for #46 to close'],
  // Six sandboxes, the machine's whole pool.
  [2, '#41', 'setup', SETUP], [2, '#42', 'setup', SETUP], [2, '#43', 'setup', SETUP],
  [2, '#44', 'setup', SETUP], [2, '#45', 'setup', SETUP], [2, '#46', 'setup', SETUP],
  [2, '#48', 'queued', 'next to start'], [2, '#49', 'queued', '1 ahead of it'],
  [2, '#52', 'queued', '2 ahead of it'], [2, '#53', 'queued', '3 ahead of it'],
  [3, '#41', 'impl', '@Reading src/api/middleware.ts'], [3, '#42', 'impl', '@Reading src/billing/invoice.ts'],
  [3, '#43', 'impl', '@Reading src/checkout/totals.ts'], [3, '#44', 'impl', '$ pnpm outdated date-fns'],
  [3, '#45', 'impl', '@Reading src/api/orders.ts'], [3, '#46', 'impl', '@Reading .github/workflows/ci.yml'],
  [5, '#43', 'impl', '@Editing src/checkout/totals.ts', 1], [5, '#46', 'impl', '@Editing .github/workflows/ci.yml', 1],
  [6, '#41', 'impl', '@Editing src/api/rate-limit.ts', 1], [6, '#42', 'impl', '@Editing src/billing/invoice.ts', 1],
  [7, '#44', 'impl', '@Editing package.json', 1], [8, '#45', 'impl', '@Editing src/api/orders.ts', 1],
  [8, '#43', 'impl', '@Committing: test: cover checkout totals', 2],
  [9, '#43', 'review', REVIEW, 2], [9, '#42', 'impl', '$ pnpm test -- invoice', 2],
  [10, '#41', 'impl', '@Committing: feat: rate limit the public API', 2], [10, '#44', 'impl', '$ pnpm exec tsc --noEmit', 2],
  [10, '#46', 'review', REVIEW, 1],
  [11, '#43', 'gates', '2/4 test'], [11, '#41', 'review', REVIEW], [11, '#45', 'impl', 'usually 4m - $ pnpm test -- orders', 2],
  [12, '#43', 'ready', 'gates green', 3], [12, '#42', 'review', REVIEW], [12, '#46', 'gates', '2/4 test'],
  [13, '#46', 'ready', 'human merge: .github/ - held for you at landing', 1], [13, '#45', 'review', REVIEW, 3],
  [13, '#48', 'setup', SETUP], [13, '#49', 'queued', 'next to start'], [13, '#52', 'queued', '1 ahead of it'], [13, '#53', 'queued', '2 ahead of it'],
  [14, '#48', 'impl', '$ git rm src/export/legacy-csv.ts', 1], [14, '#41', 'gates', '3/4 test', 3],
  [14, '#49', 'setup', SETUP], [14, '#52', 'queued', 'next to start'], [14, '#53', 'queued', '1 ahead of it'],
  [15, '#41', 'repair', 'repair 1 - 2 failing in rate-limit.test.ts'], [15, '#42', 'gates', '1/4 lint', 3],
  [15, '#45', 'gates', '3/4 test'], [15, '#49', 'impl', '@Reading test/cart.test.ts'],
  [16, '#42', 'ready', 'gates green', 3], [16, '#45', 'ready', 'gates green', 3], [16, '#44', 'review', REVIEW, 3],
  [17, '#52', 'setup', SETUP], [17, '#53', 'setup', SETUP], [17, '#41', 'gates', '3/4 test', 4],
  [18, '#41', 'review', 'reviewing the repair commits'], [18, '#48', 'review', REVIEW, 2],
  [18, '#49', 'impl', '@Committing: fix: stop the cart test racing the clock', 1],
  [18, '#52', 'impl', '@Editing src/emails/receipt.tsx'], [18, '#53', 'impl', '@Reading docs/webhooks.md'],
  [19, '#44', 'gates', '3/4 test'], [20, '#41', 'ready', 'gates green', 4],
  [20, '#44', 'repair', 'repair 1 - 3 failing in dates.test.ts', 4], [20, '#48', 'gates', '4/4 build'],
  [20, '#49', 'review', REVIEW, 1], [20, '#53', 'impl', '@Editing docs/webhooks.md', 1],
  [21, '#48', 'ready', 'gates green', 2], [21, '#52', 'impl', '@Committing: feat: itemise the receipt email', 1],
  [22, '#49', 'gates', '3/4 test'], [22, '#52', 'review', REVIEW, 1],
  [23, '#49', 'ready', 'gates green', 1], [23, '#44', 'gates', '3/4 test', 5], [23, '#53', 'review', REVIEW, 1],
  [24, '#44', 'gate red', 'test: 3 failing in dates.test.ts - after 2 repairs', 5], [24, '#52', 'gates', '3/4 test', 2],
  [25, '#52', 'ready', 'gates green', 2], [25, '#53', 'gates', '1/4 lint'],
  [26, '#53', 'ready', 'gates green', 1],
  // The landing worker: each branch as it goes green, one at a time, while
  // the sandboxes keep working. A branch that touches CI is held for a person.
  [12.5, '#43', 'landing', LAND], [13.5, '#43', 'merged', 'merged'],
  [14, '#46', 'held', 'needs a human merge: .github/workflows/ci.yml changed'],
  [16.5, '#42', 'landing', LAND], [17.5, '#42', 'merged', 'merged'],
  [17.5, '#45', 'landing', LAND], [18.5, '#45', 'merged', 'merged'],
  [20.5, '#41', 'landing', LAND], [21.5, '#41', 'merged', 'merged'], [21.5, '#47', 'queued', 'blocker landed - starts now'],
  [21.5, '#48', 'landing', LAND], [22.5, '#48', 'merged', 'merged'],
  [23.5, '#49', 'landing', LAND], [24.5, '#49', 'merged', 'merged'],
  [25.5, '#52', 'landing', LAND], [26.5, '#52', 'merged', 'merged'],
  [26.5, '#53', 'landing', LAND], [27.5, '#53', 'merged', 'merged'],
  // Its blocker has landed: the waiting ticket starts in a free sandbox, in the same run.
  [22, '#47', 'setup', SETUP], [23, '#47', 'impl', '@Reading src/api/orders.ts'],
  [25, '#47', 'impl', '@Committing: feat: paginate the orders endpoint', 1],
  [26, '#47', 'review', REVIEW, 1], [27, '#47', 'gates', '3/4 test', 2],
  [28, '#47', 'ready', 'gates green', 2], [28.5, '#47', 'landing', LAND], [29.5, '#47', 'merged', 'merged'],
];
// In time order: snapshot() stops at the first event still to come. Equal times keep their order.
EVENTS.sort((a, b) => a[0] - b[0]);
const END = 31; // minutes; the run is finished from here
const RUN_STAGES = [[0, 'base gates'], [2, 'agents'], [30, 'verify'], [END, 'finished']];

const WORKING = ['setup', 'impl', 'review', 'codex', 'gates', 'repair', 'landing'];
const NEEDS = ['gate red', 'held', 'conflict', 'crashed'];
// glyph, tone, rank and group of a state word, as the table gives them (src/status-rows.ts).
function styleOf(s) {
  if (WORKING.includes(s)) return ['●', 'ylw', 0, 'working'];
  if (NEEDS.includes(s)) return ['!', 'hot', 1, 'needs you'];
  if (s === 'ready') return ['>', 'cyn', 2, 'ready'];
  if (s === 'queued') return ['○', 'blu', 3, 'queued'];
  if (s === 'blocked') return ['~', 'blu', 4, 'blocked'];
  if (s === 'merged') return ['+', 'grn', 5, 'merged'];
  return ['·', 'gry', 6, 'idle'];
}
// The state as the run record names it, where the table's word is another.
const RECORD_STATE = { impl: 'implement', codex: 'cross-review', 'gate red': 'red' };

// The run starts at 22:41:07 local time on a made-up day, so the clock reads the same in any zone.
const EPOCH0 = new Date(2026, 9, 11, 22, 41, 7).getTime() / 1000;
const at = (min) => Math.floor(EPOCH0 + min * 60);
const two = (n) => String(n).padStart(2, '0');
const clock12 = (min, id) => {
  const d = new Date((at(min) + ((Number(id.slice(1)) * 17) % 60)) * 1000);
  const h = d.getHours();
  return `${h % 12 || 12}:${two(d.getMinutes())}:${two(d.getSeconds())} ${h < 12 ? 'am' : 'pm'}`;
};

// Every ticket as it stands at minute t.
function tickets(t) {
  const out = new Map();
  for (const [when, id, state, note, commits] of EVENTS) {
    if (when > t) break;
    const prev = out.get(id);
    out.set(id, {
      id, state,
      note: note.startsWith('@') ? `[${clock12(when, id)}] ${note.slice(1)}` : note,
      since: prev && prev.state === state ? prev.since : when,
      // When it first left the queue: its tokens grow from here.
      started: prev?.started ?? (['queued', 'blocked'].includes(state) ? undefined : when),
      commits: commits ?? prev?.commits ?? 0,
    });
  }
  return out;
}

// What the table draws for a ticket's diff: lines added and removed on its branch, made up but steady per ticket.
function diffOf(id, commits) {
  const n = Number(id.slice(1));
  if (id === '#48') return `+34 \u22121159`;
  return `+${(n * 37) % 90 + 14 * commits} \u2212${(n * 11) % 40 + 3 * commits}`;
}

// A ticket's tokens in/out: none before its first pass, then growing with its time since it started, as the
// real column does while passes report usage, and never falling.
function ticketTokens(id, state, ran) {
  if (['queued', 'blocked', 'setup'].includes(state) || !(ran >= 0)) return '-';
  const n = Number(id.slice(1));
  const part = Math.min(1, 0.15 + ran / 25);
  return `${((0.6 + ((n * 13) % 20) / 10) * part).toFixed(1)}M/${Math.round((10 + ((n * 7) % 40)) * part)}k`;
}

// The run's snapshot and table at minute t, as the view reads them.
function inputs(t) {
  const now = at(t);
  const stage = RUN_STAGES.filter(([when]) => when <= t).pop()[1];
  const finished = stage === 'finished';
  const all = [...tickets(t).values()];
  const elapsed = Math.min(t, END);
  const working = all.filter((r) => WORKING.includes(r.state) && r.state !== 'landing').length;
  const gating = all.filter((r) => r.state === 'gates').length;
  // Each landed branch adds its commits and a merge commit, and none of it is pushed.
  const unpushed = all.filter((r) => r.state === 'merged').reduce((n, r) => n + r.commits + 1, 0);
  const kTokens = Math.round(40 + elapsed * 19);

  const rows = all
    .map((r) => {
      const [glyph, tone, prio, group] = styleOf(r.state);
      const idle = ['queued', 'blocked'].includes(r.state);
      const n = Number(r.id.slice(1));
      // A step past twice its usual time: the age turns red, the note says what usual is.
      // A finished row shows its whole length, first start to end; a working one, the time in its state.
      const minutes = ['merged', ...NEEDS].includes(r.state) ? r.since - r.started : elapsed - r.since;
      const tokens = idle ? '-' : ticketTokens(r.id, r.state, elapsed - r.started);
      const wobble = Math.sin(t * 0.9 + n) * 0.5 + 0.5;
      const row = {
        id: r.id,
        shown: r.id,
        state: r.state,
        glyph,
        tone,
        group,
        time: idle ? '-' : ago(Math.max(0, Math.round(minutes * 60))),
        timeTone: idle ? 'gry' : r.note.startsWith('usually') ? 'hot' : 'head',
        diff: idle || !r.commits ? '-' : diffOf(r.id, r.commits),
        note: r.note,
        noteTone: NEEDS.includes(r.state) ? 'hot' : 'mute',
        prio,
        key: r.since,
        apart: false,
      };
      if (tokens !== '-') {
        row.tokens = tokens;
        // Most of the input comes from the prompt cache; one ticket's cache is not holding, which turns the share amber.
        row.cache = r.id === '#44' ? 64 : 86 + (n % 11);
      }
      if (r.state === 'gates') row.cpu = { cpu: `${(6 + wobble * 6).toFixed(1)}c`, mem: `${(1.4 + wobble * 0.6).toFixed(1)}G`, hot: wobble > 0.8 };
      else if (WORKING.includes(r.state)) row.cpu = { cpu: `${(0.2 + wobble * 1.4).toFixed(1)}c`, mem: `${180 + ((n * 37) % 300) + Math.round(wobble * 40)}M`, hot: false };
      return row;
    })
    .sort((a, b) => a.prio - b.prio || b.key - a.key || a.id.localeCompare(b.id));
  const counts = { working: 0, 'needs you': 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 0, 'left over': 0, idle: 0 };
  for (const r of rows) counts[r.group]++;

  const recordTickets = {};
  for (const r of all) {
    recordTickets[r.id] = {
      state: RECORD_STATE[r.state] ?? r.state,
      since: at(r.since),
      note: r.note,
      commits: r.commits,
      ...(r.started === undefined ? {} : { started: at(r.started), attemptStarted: at(r.started) }),
    };
  }
  const record = {
    startedAt: new Date(EPOCH0 * 1000).toISOString().slice(0, 19) + 'Z',
    stage: stage === 'agents' ? 'running' : stage,
    tokens: `${kTokens >= 1000 ? (kTokens / 1000).toFixed(1) + 'M' : kTokens + 'k'} in / ${Math.round(kTokens / 60)}k out`,
    concurrency: 6,
    typical: { issue: 25 * 60, 'landing gates': 60 },
    demand: String(Math.min(6, all.filter((r) => !['merged', 'held', 'gate red'].includes(r.state)).length)),
    share: '6',
    tickets: recordTickets,
    // Plan usage: both windows, read from the agents' own events a little while ago.
    usage: [{
      provider: 'claude',
      at: now - 40,
      windows: {
        fiveHour: { percent: Math.round(22 + elapsed * 1.4), resetsAt: now + 3 * 3600 + 20 * 60 },
        week: { percent: 41, resetsAt: at(0) + 3 * 86400 + 9 * 3600 },
      },
    }],
  };
  if (finished) {
    record.finishedAt = new Date(at(END) * 1000).toISOString().slice(0, 19) + 'Z';
    record.exitCode = 0;
  }
  const snapshot = {
    now,
    root: '',
    dir: '',
    name: 'my-app',
    base: 'main',
    hasRecord: true,
    record,
    tickets: recordTickets,
    live: !finished,
    outcomes: {},
    logs: [],
    tails: {},
    worktrees: [],
    branches: {},
    containers: {},
    cpus: 8,
    pool: { sandboxes: { used: Math.min(working, 6), limit: '6' }, gates: { used: Math.min(gating, 2), limit: '2' } },
    queue: { tickets: [] },
    unpushed,
    settings: {
      from: finished ? 'last run' : 'live',
      settings: { autonomy: 2, concurrency: 6, repair: 2, crossReview: false, usageGuard: true, usageStop: 90, usagePause: 90 },
    },
    models: 'implement claude-sonnet-5-5/high · review claude-opus-5-5/high',
    runOutput: [],
    links: false,
    clickMod: 'fallback',
  };
  return { snapshot, table: { rows, counts, partly: 0, later: { ids: [], blocked: 0 } } };
}

// ---------------------------------------------------------------------------
// One frame at minute t, `cols` columns wide, as lines of segments.

// The renderer paints with escape codes; these stand for its colours, so the frame can be read back into the
// colour names the stylesheet knows.
const NAMES = ['rule', 'mute', 'head', 'accent', 'wht', 'grn', 'ylw', 'cyn', 'blu', 'gry', 'hot', 'moon', 'dusk', 'night', 'deep', 'star'];
const COLOURS = { bold: '\x1b[1m', off: '\x1b[0m', ...Object.fromEntries(NAMES.map((n, i) => [n, `\x1b[38;5;${100 + i}m`])) };

// The frame the view would draw, as its escape codes. Every row is shown, however many.
function ansi(t, cols) {
  const { snapshot, table } = inputs(t);
  return renderFrame(snapshot, table, { cols, rows: 1000000, showAll: true, colours: COLOURS });
}

function frame(t, cols, changed = new Set()) {
  const lines = [];
  // oxlint-disable-next-line no-control-regex -- the escape byte is what the frame is read by
  const code = /\x1b\[([0-9;]*)m/g;
  for (const text of ansi(t, cols).split('\n')) {
    if (text === '' && lines.length) break;
    const segs = [];
    let colour = '';
    let bold = false;
    let from = 0;
    const put = (to) => {
      if (to > from) segs.push([text.slice(from, to), [colour, bold ? 'b' : ''].filter(Boolean).join(' ')]);
    };
    for (const m of text.matchAll(code)) {
      put(m.index);
      from = m.index + m[0].length;
      if (m[1] === '0') [colour, bold] = ['', false];
      else if (m[1] === '1') bold = true;
      else colour = NAMES[Number(m[1].split(';')[2]) - 100] ?? colour;
    }
    put(text.length);
    // A ticket's row, by its id: it slides to its new place, and its state glows when it has just changed.
    const key = /^│\s+(#\d+)\s/.exec(segs.map(([s]) => s).join(''))?.[1];
    if (key) {
      segs.key = key;
      if (changed.has(key)) {
        const state = segs.find(([s, c]) => c && /^[●!>○~+·] /.test(s));
        if (state) state[1] += ' flash';
      }
    }
    // The header's clock, so it can tick without redrawing the window.
    const clock = segs.find(([s]) => /^\d\d:\d\d:\d\d$/.test(s));
    if (clock) clock[1] += ' clock';
    lines.push(segs);
  }
  return lines;
}

// Which tickets changed state between two minutes, for the flash.
function changedBetween(a, b) {
  const before = tickets(a);
  const after = tickets(b);
  const out = new Set();
  for (const [id, r] of after) if (before.get(id)?.state !== r.state) out.add(id);
  return out;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toHTML(lines) {
  return lines
    .map((segs) => {
      // Adjacent segments of one colour merge, so a frame is a few hundred spans, not thousands.
      const merged = [];
      for (const [t, c] of segs) {
        const last = merged[merged.length - 1];
        if (last && last[1] === c) last[0] += t;
        else merged.push([t, c]);
      }
      const body = merged.map(([t, c]) => (c ? `<span class="${c.split(' ').map((k) => `c-${k}`).join(' ')}">${esc(t)}</span>` : esc(t))).join('');
      return `<span class="ln"${segs.key ? ` data-k="${segs.key}"` : ''}>${body}</span>`;
    })
    .join('');
}

// The header's clock alone, as the renderer writes it, so it can tick without redrawing the whole window.
const clockAt = (t) => {
  const d = new Date(EPOCH0 * 1000 + t * 60000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

window.SandcastleStatus = { frame, changedBetween, toHTML, clockAt, END, inputs, ansi, colours: COLOURS };
})();
