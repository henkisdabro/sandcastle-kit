// The live status window: status.sh's grid (split_w, junction, cells_line and
// the legend band) ported line for line, playing a scripted overnight run.
// Drawn as text rather than canvas, so it stays sharp at any zoom, can be
// selected, and reflows by dropping columns the way the real view does.

// A line is a list of [text, colour] segments; the colours are the status
// view's own variable names, styled in site.css as .c-<name>.
(function () {
  'use strict';

const len = (segs) => segs.reduce((n, [t]) => n + t.length, 0);
const pad = (n) => [' '.repeat(Math.max(0, n)), ''];

function align(segs, w, al = 'l') {
  if (w <= 0) return [];
  const n = len(segs);
  if (n > w) {
    // Cut to the width with an ellipsis, as fit() does in status.sh.
    const out = [];
    let left = w - 1;
    for (const [t, c] of segs) {
      if (left <= 0) break;
      out.push([t.slice(0, left), c]);
      left -= t.length;
    }
    out.push(['…', segs[segs.length - 1][1]]);
    return out;
  }
  if (al === 'r') return [pad(w - n), ...segs];
  if (al === 'c') {
    const l = (w - n) >> 1;
    return [pad(l), ...segs, pad(w - n - l)];
  }
  return [...segs, pad(w - n)];
}

// $1 columns split by weights, the remainder spread by cumulative rounding.
function splitW(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let cum = 0;
  let prev = 0;
  return weights.map((w) => {
    cum += w;
    const at = Math.floor((total * cum * 2 + sum) / (sum * 2));
    const width = at - prev;
    prev = at;
    return width;
  });
}

const bars = (ow) => {
  const out = [];
  let p = 0;
  for (let i = 0; i < ow.length - 1; i++) out.push((p += ow[i] + 1));
  return out;
};

// status.sh's snap_w: each inner bar of ow within 4 columns of a bar above (ref) moves onto it,
// so the two meet in one ┼ rather than a near-miss like ┴┬. A cell is never cut below min (one
// already narrower keeps its width): that bar stays, and the last cell takes the remainder.
function snapW(win, ow, ref, min) {
  const n = ow.length;
  const mn = ow.map((w, i) => Math.min(min[i] ?? 0, w));
  const suf = Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + mn[i] + 1;
  const pos = [];
  let prev = 0;
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += ow[i] + 1;
    let best = acc;
    let bd = 5;
    for (const r of ref) {
      const d = Math.abs(r - acc);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    if (best !== acc && (best - prev - 1 < mn[i] || win - 1 - best < suf[i + 1])) best = acc;
    // An earlier move right may have squeezed this cell.
    best = Math.max(best, prev + 1 + mn[i]);
    pos.push(best);
    prev = best;
  }
  return [...pos, win - 1].map((p, i) => p - (i ? pos[i - 1] : 0) - 1);
}

function junction(win, l, r, fill, up = [], dn = []) {
  const [x, y, z] = ['┼', '┴', '┬'];
  let s = l;
  for (let i = 1; i < win - 1; i++) {
    const a = up.includes(i);
    const b = dn.includes(i);
    s += a && b ? x : a ? y : b ? z : fill;
  }
  return [[s + r, 'rule']];
}

function cellsLine(ow, cells, al) {
  const out = [['│', 'rule']];
  ow.forEach((w, i) => out.push(pad(1), ...align(cells[i] || [], w - 2, al[i]), pad(1), ['│', 'rule']));
  return out;
}

// ---------------------------------------------------------------------------
// The run. Times are minutes after the start; each event sets a ticket's
// state, its activity note and its commit count. Made up, but every state and
// note is one the real view shows. A note starting with @ is an agent's log
// line, which carries its own time: "[10:44:31 pm] Editing src/api/x.ts".
// Each branch lands as it goes green, on one landing worker, its row moving
// down into the merged group while the others work; a ticket whose blocker
// lands starts at once, in the same run.

const START = 22 * 3600 + 41 * 60 + 7; // 22:41:07
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
// glyph, colour, priority, legend group - status.sh's style_of.
function styleOf(s) {
  if (WORKING.includes(s)) return ['●', 'ylw', 0, 'working'];
  if (NEEDS.includes(s)) return ['!', 'hot', 1, 'needs you'];
  if (s === 'ready') return ['>', 'cyn', 2, 'ready'];
  if (s === 'queued') return ['○', 'blu', 3, 'queued'];
  if (s === 'blocked') return ['~', 'blu', 4, 'blocked'];
  if (s === 'merged') return ['+', 'grn', 5, 'merged'];
  return ['·', 'gry', 6, 'idle'];
}

const hhmm = (sec) => {
  const s = ((sec % 86400) + 86400) % 86400;
  const two = (n) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}`;
};
const hhmmss = (sec) => `${hhmm(sec)}:${String(Math.floor(sec) % 60).padStart(2, '0')}`;
// "10:44:31 pm", the seconds varied per ticket so the lines do not all tick together.
const clock12 = (sec, id) => {
  const s = Math.floor(sec) + ((Number(id.slice(1)) * 17) % 60);
  const h = Math.floor(s / 3600) % 24;
  const two = (n) => String(n).padStart(2, '0');
  return `${h % 12 || 12}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)} ${h < 12 ? 'am' : 'pm'}`;
};
const ago = (min) =>
  min < 1 ? `${Math.max(1, Math.round(min * 60))}s` : min < 60 ? `${Math.round(min)}m` : `${Math.floor(min / 60)}h`;

// Every ticket as it stands at minute t.
function snapshot(t) {
  const tickets = new Map();
  for (const [at, id, state, note, commits] of EVENTS) {
    if (at > t) break;
    const prev = tickets.get(id);
    tickets.set(id, {
      id, state,
      note: note.startsWith('@') ? `[${clock12(START + at * 60, id)}] ${note.slice(1)}` : note,
      since: prev && prev.state === state ? prev.since : at,
      commits: commits ?? prev?.commits ?? 0,
    });
  }
  return tickets;
}

// A sandbox's CPU and memory, steady per ticket and wobbling with time.
function load(id, state, t) {
  const n = Number(id.slice(1));
  const wobble = Math.sin(t * 0.9 + n) * 0.5 + 0.5;
  if (state === 'gates') return [`${(6 + wobble * 6).toFixed(1)}c`, `${(1.4 + wobble * 0.6).toFixed(1)}G`, wobble > 0.8];
  if (WORKING.includes(state)) return [`${(0.2 + wobble * 1.4).toFixed(1)}c`, `${180 + ((n * 37) % 300) + Math.round(wobble * 40)}M`, false];
  return ['-', '-', false];
}

function gauge(used, of) {
  return [['█'.repeat(used), 'ylw'], ['░'.repeat(of - used), 'rule'], [` ${used}/${of}`, 'head']];
}
const kv = (k, v) => [[k.padEnd(10), 'mute'], ...v];

// ---------------------------------------------------------------------------
// One frame at minute t, `cols` columns wide, as lines of segments.

function frame(t, cols, changed = new Set()) {
  const win = cols;
  const lines = [];
  const put = (l, key) => {
    if (key) l.key = key;
    lines.push(l);
  };
  const tickets = snapshot(t);
  const now = START + t * 60;
  const stage = RUN_STAGES.filter(([at]) => at <= t).pop()[1];
  const rows = [...tickets.values()];
  const working = rows.filter((r) => WORKING.includes(r.state) && r.state !== 'landing').length;
  const gating = rows.filter((r) => r.state === 'gates').length;
  // Each landed branch adds its commits and a merge commit, and none of it is pushed.
  const ahead = rows.filter((r) => r.state === 'merged').reduce((n, r) => n + r.commits + 1, 0);
  const unpushed = ahead ? [[` ↑${ahead} unpushed`, 'hot']] : [];

  // The header: the logo, the run and the machine, the models.
  const narrow = cols < 62;
  const logo = narrow
    ? [
        [[' ▄ ▄ ▄', 'moon'], [' +  ', 'star'], ['sandcastle', 'moon b'], ['-kit', 'night']],
        [[' █████', 'dusk'], ['    ', ''], ['my-app', 'head']],
        [[' ██▀██', 'deep'], [' ·  ', 'star'], ['base ', 'mute'], ['main', 'accent'], ...unpushed, ['  ·  ', 'rule'], [hhmm(now), 'accent clock']],
      ]
    : [
        [[' ▄ ▄ ▄', 'moon'], [' +   ', 'star'], ['s a n d c a s t l e', 'moon b'], [' - k i t', 'night'], ['  ·   +   ·', 'star']],
        [[' █████', 'dusk'], ['     ', ''], ['my-app', 'head']],
        [[' ██▀██', 'deep'], [' ·   ', 'star'], ['base ', 'mute'], ['main', 'accent'], ...unpushed, ['  ·  ', 'rule'], [hhmmss(now), 'accent clock']],
      ];
  const lw = Math.max(...logo.map(len));
  let ow = splitW(win - 2, [1]);
  put(junction(win, '┌', '┐', '─'));
  for (const l of logo) put(cellsLine(ow, [align(l, lw)], ['c']));

  const elapsed = Math.min(t, END);
  const state =
    stage === 'finished'
      ? [['ended (exit 0)', 'mute']]
      : [['running', 'ylw'], [` · ${ago(elapsed)}`, 'mute'], [' · ', 'rule'], [stage, 'accent']];
  const tokens = Math.round(40 + elapsed * 19);
  const run = [
    kv('state', state),
    stage === 'finished'
      ? kv('started', [[hhmm(START), 'mute']])
      : kv('since', [[hhmm(START), 'mute']]),
    kv('tokens', [[`${tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'M' : tokens + 'k'} in / ${Math.round(tokens / 60)}k out`, 'head']]),
  ];
  const mac = [
    kv('sandboxes', gauge(Math.min(working, 6), 6)),
    kv('gates', gauge(Math.min(gating, 2), 2)),
    kv('waiting', [['none', 'gry']]),
  ];
  const models = kv('models', [['implement ', 'mute'], ['claude-sonnet-5-5/high', 'head'], [' · ', 'rule'], ['review ', 'mute'], ['claude-opus-5-5/high', 'head']]);

  ow = splitW(win - 3, [1, 1]);
  let prevBars = bars(ow);
  put(junction(win, '├', '┤', '─', [], narrow ? [] : prevBars));
  if (narrow) {
    ow = splitW(win - 2, [1]);
    for (const l of [...run, ...mac]) put(cellsLine(ow, [l], ['l']));
    prevBars = [];
  } else {
    for (let i = 0; i < 3; i++) put(cellsLine(ow, [run[i], mac[i]], ['l', 'l']));
    ow = splitW(win - 2, [1]);
    put(junction(win, '├', '┤', '─', prevBars, []));
    put(cellsLine(ow, [models], ['l']));
    prevBars = [];
  }

  // The table: status.sh's minimum widths and shares, ACTIVITY takes the rest.
  // Below 80 columns CPU and MEM give way to ACTIVITY; on a phone COMMITS too.
  const wide = cols >= 100 ? 2 : cols >= 80 ? 1 : cols >= 62 ? 0 : -1;
  let min = [7, 14, 6, 9, 7, 7];
  let pct = [6, 9, 5, 6, 6, 6];
  min = min.slice(0, 4 + Math.max(wide, 0));
  pct = pct.slice(0, 4 + Math.max(wide, 0));
  if (wide < 0) {
    min = [7, 11, 5];
    pct = [6, 9, 5];
  }
  const avail = win - min.length - 2;
  const tw = min.map((m, i) => Math.max(m, Math.floor((avail * pct[i]) / 100)));
  tw.push(Math.max(10, avail - tw.reduce((a, b) => a + b, 0)));
  const tal = [...tw.map((_, i) => (i === 1 ? 'l' : 'c')).slice(0, -1), 'l'];
  const tbars = bars(tw);
  const heads = ['ISSUE', 'STATE', 'AGE', 'COMMITS', 'CPU', 'MEM'].slice(0, tw.length - 1);
  put(junction(win, '├', '┤', '─', prevBars, tbars));
  put(cellsLine(tw, [...heads, 'ACTIVITY'].map((h) => [[h, 'head b']]), tal));
  put(junction(win, '├', '┤', '─', tbars, tbars));

  const sorted = rows
    .map((r) => ({ ...r, style: styleOf(r.state) }))
    .sort((a, b) => a.style[2] - b.style[2] || b.since - a.since || a.id.localeCompare(b.id));
  let prio = null;
  for (const r of sorted) {
    if (prio !== null && r.style[2] !== prio) put(junction(win, '├', '┤', '─', tbars, tbars));
    prio = r.style[2];
    const [glyph, colour] = r.style;
    const idle = ['queued', 'blocked'].includes(r.state);
    const [cpu, mem, hot] = load(r.id, r.state, t);
    const stateCls = changed.has(r.id) ? `${colour} flash` : colour;
    const cells = [
      [[r.id, 'wht b']],
      [[`${glyph} ${r.state}`, stateCls]],
      // A step past twice its usual time: the age turns red, the note says what usual is.
      idle ? [['-', 'gry']] : [[ago(Math.min(t, END) - r.since), r.note.startsWith('usually') ? 'hot' : 'head']],
      idle ? [['-', 'gry']] : [[String(r.commits), 'head']],
      [[cpu, hot ? 'hot' : cpu === '-' ? 'gry' : 'head']],
      [[mem, mem === '-' ? 'gry' : 'head']],
    ].slice(0, tw.length - 1);
    cells.push([[r.note, NEEDS.includes(r.state) ? 'hot' : 'mute']]);
    put(cellsLine(tw, cells, tal), r.id);
  }

  // The legend band with each group's count, then the note.
  const count = (g) => sorted.filter((r) => r.style[3] === g).length;
  const legend = [
    [['● working ', 'ylw'], [String(count('working')), 'ylw b']],
    [['! needs you ', 'hot'], [String(count('needs you')), 'hot b']],
    [['> ready to land ', 'cyn'], [String(count('ready')), 'cyn b']],
    [['○ queued ', 'blu'], [String(count('queued')), 'blu b']],
    [['~ blocked ', 'blu'], [String(count('blocked')), 'blu b']],
    [['+ merged ', 'grn'], [String(count('merged')), 'grn b']],
    [['- left over ', 'gry'], ['0', 'gry b']],
    [['· idle ', 'gry'], ['0', 'gry b']],
  ];
  let per = cols >= 130 ? 8 : 4;
  let lwt;
  for (;;) {
    lwt = [];
    for (let c = 0; c < per; c++) {
      let w = 0;
      for (let r = c; r < 8; r += per) w = Math.max(w, len(legend[r]));
      lwt.push(w + 4);
    }
    if (per <= 2 || lwt.reduce((a, b) => a + b, 0) + per + 1 <= win) break;
    per /= 2;
  }
  ow = snapW(win, splitW(win - per - 1, lwt), tbars, lwt);
  const lbars = bars(ow);
  put(junction(win, '├', '┤', '─', tbars, lbars));
  for (let r = 0; r < 8; r += per) put(cellsLine(ow, legend.slice(r, r + per), Array(per).fill('c')));
  put(junction(win, '├', '┤', '─', lbars, []));
  // The notes joined by " · " into as few lines as they fit, as wrap_items does.
  const notes = ['ready = gates green, waits for the landing worker', 'age = time in state (red: twice the usual)'];
  if (wide >= 1) notes.push('CPU in cores of 8');
  const noteLines = [];
  for (const item of notes) {
    const lastLine = noteLines[noteLines.length - 1];
    if (lastLine && len(lastLine) + 3 + item.length <= win - 4) lastLine.push([' · ', 'gry'], [item, 'gry']);
    else noteLines.push([[item, 'gry']]);
  }
  for (const n of noteLines) put(cellsLine(splitW(win - 2, [1]), [n], ['c']));
  put(junction(win, '└', '┘', '─'));
  return lines;
}

// Which tickets changed state between two minutes, for the flash.
function changedBetween(a, b) {
  const before = snapshot(a);
  const after = snapshot(b);
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

// The header's clock alone, so it can tick without redrawing the whole window.
const clockAt = (t, cols) => (cols < 62 ? hhmm : hhmmss)(START + t * 60);

window.SandcastleStatus = { frame, changedBetween, toHTML, clockAt, END };
})();
