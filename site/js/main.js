// The page's behaviour: the sand, the live status window, the copy buttons.
// Plain scripts, not modules, so the page also works opened from disk.
(function () {
  'use strict';

  const { frame, changedBetween, toHTML, clockAt, END } = window.SandcastleStatus;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let sand = null;

  // ------------------------------------------------------------ the sand

  function startSand() {
    sand = window.SandcastleSand({
      field: document.querySelector('.sand'),
      dunes: document.querySelector('.dunes'),
      castle: document.querySelector('.castle'),
      castleCanvas: document.querySelector('.castle-sand'),
      reduced,
    });
  }

  // ------------------------------------------------------------ status window
  // A night in about forty seconds: the run's clock moves a minute a
  // second, holds on the finished frame, then starts again. It plays only
  // while on screen. When a ticket changes group its row slides to its new
  // place - above all down into merged as its branch lands.

  const RATE = 1;
  const HOLD = 7; // seconds on the finished frame
  const STILL = 22; // the minute shown without motion: working, landing, held and merged on screen
  const FIRST = 8; // where the run starts the first time: sandboxes already busy
  const SLIDE = 800; // ms for a row to reach its new place

  const pre = document.querySelector('.status');
  let cols = 0;
  let t = FIRST;
  let shownMinute = -1;
  let visible = false;
  let last = 0;
  let drawn = 0;
  let raf = 0;

  function measure() {
    const probe = document.createElement('span');
    probe.textContent = '─'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden';
    pre.append(probe);
    const ch = probe.getBoundingClientRect().width / 100;
    probe.remove();
    return Math.max(44, Math.floor(pre.clientWidth / ch));
  }

  // Each row is drawn where it now belongs, then started from where it was and
  // let glide there; the one that moved furthest passes over the rest.
  function draw(minute, flash) {
    const was = new Map();
    for (const row of pre.querySelectorAll('[data-k]')) was.set(row.dataset.k, row.offsetTop);
    pre.innerHTML = toHTML(frame(minute, cols, flash));
    if (reduced.matches || !was.size) return;
    for (const row of pre.querySelectorAll('[data-k]')) {
      const from = was.get(row.dataset.k);
      if (from === undefined || from === row.offsetTop) continue;
      const dy = from - row.offsetTop;
      row.classList.add('moving');
      row.style.zIndex = String(Math.round(Math.abs(dy)));
      row
        .animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
          duration: SLIDE,
          easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',
        })
        .finished.then(() => row.classList.remove('moving'), () => {});
    }
  }

  function tick(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt * RATE;
    if (t > END + HOLD * RATE) {
      t = 0;
      shownMinute = -1;
    }
    const minute = Math.min(t, END);
    const whole = Math.floor(minute);
    // The window is redrawn on each new minute, with the flash; in between only
    // its clock ticks, four times a second.
    if (whole !== shownMinute) {
      draw(minute, shownMinute >= 0 ? changedBetween(shownMinute, whole) : new Set());
      shownMinute = whole;
      drawn = now;
    } else if (now - drawn > 250) {
      const clock = pre.querySelector('.c-clock');
      if (clock) clock.textContent = clockAt(minute, cols);
      drawn = now;
    }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    cancelAnimationFrame(raf);
    if (reduced.matches || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function layout() {
    const c = measure();
    if (c === cols) return;
    cols = c;
    draw(reduced.matches ? STILL : Math.min(t, END), new Set());
  }

  // ------------------------------------------------------------ copy buttons

  for (const box of document.querySelectorAll('[data-copy]')) {
    const button = box.querySelector('.copy');
    const code = box.querySelector('code');
    button.addEventListener('click', async () => {
      const text = code.textContent.replace(/^\$\s*/, '');
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
        const b = button.getBoundingClientRect();
        if (sand) sand.puff(b.left + b.width / 2, b.top + 4, 30, 0.8);
      } catch {
        // No clipboard (a page opened from disk, a refused permission): select it instead.
        getSelection().selectAllChildren(code);
        button.textContent = 'Selected';
      }
      setTimeout(() => (button.textContent = 'Copy'), 1600);
    });
  }

  // ------------------------------------------------------------ start
  // Once the fonts are in, so the castle's grains and the window's columns
  // are measured against the type they will sit beside.

  document.fonts.ready.then(() => {
    startSand();
    if (!pre) return;
    if (reduced.matches) t = STILL;
    layout();
    new ResizeObserver(layout).observe(pre);
    new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        play();
      },
      { threshold: 0.25 },
    ).observe(pre);
    document.addEventListener('visibilitychange', play);
    reduced.addEventListener('change', () => {
      draw(reduced.matches ? STILL : t, new Set());
      play();
    });
  });
})();
